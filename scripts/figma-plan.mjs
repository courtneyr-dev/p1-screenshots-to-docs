#!/usr/bin/env node
/**
 * nextjs-screenshots / figma-plan
 *
 * Turns a finished capture run into a Figma push plan. One run becomes one
 * Figma page named "<topic> · <YYYY-MM-DD HH:mm> · <runId>", so every run is
 * kept side by side in the same file and the team annotates on that page.
 * (Figma's Plugin API cannot create file-version-history entries, so a page
 * per run is the durable "version".)
 *
 * Writes into the capture folder:
 *   figma-plan.json  run id, page name, rows, and the ordered upload list
 *   figma-page.js    code for the Figma MCP `use_figma` tool: creates the page
 *                    and one named placeholder rectangle per PNG, and returns
 *                    their node ids in upload order
 *
 * Usage:
 *   node figma-plan.mjs --dir screenshots/acme
 *   node figma-plan.mjs --dir screenshots/acme --only 01-home,02-pricing
 *
 * Then: run figma-page.js via use_figma, call upload_assets with the returned
 * node ids, and POST the bytes with figma-upload.mjs. See SKILL.md.
 */

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { loadConfig, applyOverrides, validateConfig, formatValidation, runIdFor, pageNameFor, DEFAULTS } from './lib/config.mjs';
import { loadInventory, validateInventory, formatIssues, mappingFor, frameName, inventoryCommit, sha256 } from './lib/inventory.mjs';

const FIGMA_MAX_BYTES = 10 * 1024 * 1024; // upload_assets limit per asset
const UPLOAD_CHUNK = 60;                  // upload_assets limit per call
const USE_FIGMA_MAX_CHARS = 50000;        // use_figma `code` limit

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    only: { type: 'string' },
    config: { type: 'string' },
    set: { type: 'string', multiple: true },
    release: { type: 'string' },
    inventory: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || !values.dir) {
  console.log(`Usage: node figma-plan.mjs --dir <capture folder> [--only slug,slug] [--config <file>] [--set key=value] [--release <name>] [--inventory <file>]

--inventory  Adds each screenshot's stable ID, Figma frame name, and evidence state to the plan, and writes
          figma-manifest.json. Nothing is uploaded or marked uploaded: the manifest says "planned".

--config  Takes the Figma destination (figma.fileKey) and the run ID and page naming patterns
          (figma.runIdPattern, figma.pageNamePattern) from the per-run config. Without it the
          defaults are used: run ID "{topic}-{yyyymmdd}-{hhmm}", page "{topic} · {datetime} · {runId}".`);
  process.exit(values.help ? 0 : 1);
}

const dir = resolve(values.dir);
const reportPath = join(dir, 'capture-report.json');
if (!existsSync(reportPath)) {
  console.error(`FAIL: ${reportPath} not found. Run capture.mjs first.`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
const only = values.only ? new Set(values.only.split(',').map(s => s.trim())) : null;

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IEND = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 45 || !b.subarray(0, 8).equals(PNG_SIG) || b.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  if (!b.subarray(b.length - 12).equals(PNG_IEND)) throw new Error('PNG is truncated (no IEND chunk)');
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  if (!w || !h) throw new Error('PNG has zero width or height');
  return { w, h };
}

// Figma destination and naming come from the config; the defaults reproduce the original convention.
let figmaCfg = {};
if (values.config) {
  let cfg;
  try {
    cfg = applyOverrides(loadConfig(values.config), values.set || []);
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }
  const check = validateConfig(cfg, ['figma']);
  if (check.errors.length) {
    console.error(formatValidation(check, 'Figma settings'));
    process.exit(1);
  }
  figmaCfg = cfg.figma;
}
const runIdPattern = figmaCfg.runIdPattern || DEFAULTS.runIdPattern;
const pageNamePattern = figmaCfg.pageNamePattern || DEFAULTS.pageNamePattern;
for (const [pattern, tokens] of [[pageNamePattern, { project: report.projectName, workstream: report.workstream, release: values.release }]]) {
  for (const [token, v] of Object.entries(tokens)) {
    if (pattern.includes(`{${token}}`) && !v) {
      console.error(`FAIL: the page name pattern uses {${token}}, but ${token === 'release' ? 'no --release was given. Pass --release "<name>".' : `capture-report.json has no ${token === 'project' ? 'projectName' : token}. Capture with --config so the report records it.`}`);
      process.exit(1);
    }
  }
}
const runId = runIdFor(report.capturedAt, report.topic, runIdPattern);
const pageName = pageNameFor({ capturedAt: report.capturedAt, topic: report.topic, runId, project: report.projectName || '', workstream: report.workstream || '', release: values.release || '' }, pageNamePattern);
const stamp = pageNameFor({ capturedAt: report.capturedAt, topic: report.topic, runId }, '{datetime}');

// Group results by slug, keeping capture order.
const bySlug = new Map();
for (const r of report.results) {
  if (only && !only.has(r.slug)) continue;
  if (!bySlug.has(r.slug)) bySlug.set(r.slug, {});
  bySlug.get(r.slug)[r.side] = r;
}

const sides = report.baseline ? ['baseline', 'next'] : ['next'];
const rows = [];
const uploads = [];
const warnings = [];
const integrity = [];

for (const [slug, bySide] of bySlug) {
  const cells = [];
  for (const side of sides) {
    const r = bySide[side];
    const key = `${slug}|${side}`;
    if (!r) {
      cells.push({ side, key, state: 'missing', note: 'not captured (compare: false or target limited)' });
      continue;
    }
    if (!r.ok) {
      cells.push({ side, key, state: 'failed', note: r.error || 'capture failed' });
      continue;
    }
    // The report says this capture succeeded, so a bad file means the run is broken, not that the page is.
    if (!existsSync(r.file)) {
      integrity.push(`${key}: report says captured, but the file is missing: ${r.file}`);
      continue;
    }
    const bytes = statSync(r.file).size;
    if (bytes > FIGMA_MAX_BYTES) {
      warnings.push(`${key} is ${(bytes / 1048576).toFixed(1)} MB; Figma accepts 10 MB per asset. Recapture with a lower dpr.`);
      cells.push({ side, key, state: 'failed', note: `PNG is ${(bytes / 1048576).toFixed(1)} MB, over Figma's 10 MB limit` });
      continue;
    }
    let w, h;
    try {
      ({ w, h } = pngSize(r.file));
    } catch (e) {
      integrity.push(`${key}: report says captured, but ${r.file} is unusable: ${e.message}`);
      continue;
    }
    const dpr = r.dpr || 1;
    const moved = new URL(r.finalUrl).pathname.replace(/\/+$/, '') !== new URL(r.url).pathname.replace(/\/+$/, '');
    cells.push({
      side, key, state: 'ok',
      w: Math.round(w / dpr), h: Math.round(h / dpr),
      status: r.status, moved, finalUrl: r.finalUrl,
    });
    uploads.push({ key, file: r.file, bytes });
  }
  const attention = cells.some(c => c.state !== 'ok' || c.status >= 400 || c.moved);
  rows.push({ slug, attention, cells });
}

if (integrity.length) {
  console.error(`FAIL: ${integrity.length} capture(s) the report calls successful have no usable PNG. Nothing was written.`);
  for (const m of integrity) console.error(`  ${m}`);
  console.error('Rerun capture.mjs for these shots (--only slug,slug), or fix the files, then run figma-plan again.');
  process.exit(1);
}

if (!uploads.length) {
  const blocked = report.results.filter(r => r.blocked);
  console.error('FAIL: no usable screenshots in this report, so there is nothing to push. Nothing was written.');
  for (const r of blocked) console.error(`  [${r.side}] ${r.slug}: ${r.blocked}`);
  console.error('Fix the failures (see capture-report.json), recapture, then plan again.');
  process.exit(1);
}

// Inventory-driven shots: attach the stable ID, frame names, and evidence state. Nothing here claims an upload.
let inventoryPlan = null;
const identOf = slug => bySlug.get(slug)?.next?.screenshotId || bySlug.get(slug)?.baseline?.screenshotId || null;
if (values.inventory) {
  const inv = loadInventory(resolve(values.inventory));
  const check = validateInventory(inv.doc);
  if (check.errors.length) {
    console.error(`FAIL: the inventory ${inv.file} is invalid. Nothing was written.`);
    console.error(formatIssues(check.errors));
    process.exit(1);
  }
  const byId = new Map(inv.doc.records.map(r => [r.screenshot_id, r]));
  const commit = inventoryCommit(inv.file);
  const entries = [];
  const problems = [];
  for (const row of rows) {
    const id = identOf(row.slug);
    if (!id) { problems.push(`${row.slug}: the report has no screenshotId, so this shot is not an inventory record (inventory gap)`); continue; }
    const rec = byId.get(id);
    if (!rec) { problems.push(`${id}: captured, but no inventory record exists (inventory gap)`); continue; }
    const res = bySlug.get(row.slug).next;
    if (res?.release && res.release !== rec.capture?.release) problems.push(`${id}: captured for release "${res.release}" but the record says "${rec.capture?.release}"`);
    if (res?.altText !== undefined && res.altText !== rec.content?.alt_text) problems.push(`${id}: the report's alt text differs from the inventory; regenerate the brief and recapture`);
    if (res?.caption !== undefined && res.caption !== rec.content?.caption) problems.push(`${id}: the report's caption differs from the inventory; regenerate the brief and recapture`);
    row.screenshotId = id;
    row.frameName = frameName(rec, 'clean');
    const png = uploads.find(u => u.key === `${row.slug}|next`);
    const pngSha = png ? sha256(readFileSync(png.file)) : null;
    const m = mappingFor(rec, { inventory: { file: values.inventory, ...commit } });
    entries.push({
      ...m,
      this_run: {
        state: 'planned',
        note: 'Planned only. Nothing is uploaded until you run figma-page.js and upload_assets, and nothing is recorded as uploaded until you record the real file URL and node ID.',
        run_id: runId, page_name: pageName, release: values.release || rec.capture?.release || null,
        capture_png_sha256: pngSha,
        inventory_sha256_matches: rec.asset?.sha256 ? rec.asset.sha256 === pngSha : null,
      },
      dev_resources_planned: [
        { name: 'Docs destination', url: rec.source?.docs_url || null, status: rec.source?.docs_url ? 'planned' : 'unverified' },
        { name: 'Source request', url: rec.source?.request_url || null, status: rec.source?.request_url ? 'planned' : 'unverified' },
        { name: 'Screenshot inventory', url: null, path: values.inventory, commit: commit.commit, status: 'unverified', note: 'needs a pushed commit URL' },
      ],
    });
  }
  if (problems.length) {
    console.error(`FAIL: ${problems.length} problem(s) between the capture report and the inventory. Nothing was written.`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  entries.sort((a, b) => (a.screenshot_id < b.screenshot_id ? -1 : 1));
  inventoryPlan = { file: values.inventory, commit: commit.commit, dirty: commit.dirty, records: entries };
  if (!/^RUN-\d{4}-\d{2}-\d{2}|release/i.test(pageName)) warnings.push(`page name "${pageName}" does not follow the RUN-YYYY-MM-DD or release-page convention; set figma.pageNamePattern (for example "RUN-{date} · {runId}")`);
} else {
  for (const row of rows) { const id = identOf(row.slug); if (id) row.screenshotId = id; }
}

// "Needs attention" first, matching the gallery; stable within each group.
rows.sort((a, b) => Number(b.attention) - Number(a.attention));

const chunks = [];
for (let i = 0; i < uploads.length; i += UPLOAD_CHUNK) chunks.push(uploads.slice(i, i + UPLOAD_CHUNK).map(u => u.key));

const plan = {
  runId, pageName, topic: report.topic, site: report.site, baseline: report.baseline,
  projectName: report.projectName || null, workstream: report.workstream || null, pagePath: report.pagePath || null, release: values.release || null,
  destination: { fileKey: figmaCfg.fileKey || null },
  skipped: report.skipped || [],
  ...(inventoryPlan && { inventory: inventoryPlan }),
  capturedAt: report.capturedAt, dir, rows, uploads, chunks, warnings,
};
writeFileSync(join(dir, 'figma-plan.json'), JSON.stringify(plan, null, 2));
if (inventoryPlan) writeFileSync(join(dir, 'figma-manifest.json'), JSON.stringify({ run_id: runId, page_name: pageName, destination: plan.destination, inventory: { file: inventoryPlan.file, commit: inventoryPlan.commit }, records: inventoryPlan.records }, null, 2) + '\n');

// Code for use_figma. Compact data goes in as a literal; Figma-side code builds the page.
const data = {
  pageName, runId,
  title: `${report.topic} · ${stamp}`,
  subtitle: `${report.site}${report.baseline ? `  vs  ${report.baseline}` : ''}`,
  sides,
  rows: rows.map(r => ({
    slug: r.slug, attention: r.attention, frameName: r.frameName || null,
    cells: r.cells.map(c => ({
      side: c.side, key: c.key, state: c.state, note: c.note, w: c.w, h: c.h, status: c.status, moved: c.moved,
    })),
  })),
  order: uploads.map(u => u.key),
};

const code = `const DATA = ${JSON.stringify(data)};
if (figma.root.children.some(p => p.name === DATA.pageName)) {
  throw new Error('Page already exists: ' + DATA.pageName + '. This run is already pushed.');
}
await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
await figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' });
const page = figma.createPage();
page.name = DATA.pageName;
await figma.setCurrentPageAsync(page);

const INK = { r: 0.1, g: 0.1, b: 0.12 }, MUTED = { r: 0.42, g: 0.42, b: 0.46 }, RED = { r: 0.8, g: 0.1, b: 0.1 };
const text = (chars, size, style, color) => {
  const t = figma.createText();
  t.fontName = { family: 'Inter', style };
  t.fontSize = size;
  t.characters = chars;
  t.fills = [{ type: 'SOLID', color }];
  return t;
};

const al = (...a) => { const f = figma.createAutoLayout(...a); f.fills = []; return f; };
const root = figma.createAutoLayout('VERTICAL', { name: 'Run ' + DATA.runId, itemSpacing: 64, paddingLeft: 48, paddingRight: 48, paddingTop: 48, paddingBottom: 48 });
root.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.96, b: 0.97 } }];
page.appendChild(root);
root.x = 0; root.y = 0;

const head = al('VERTICAL', { name: 'Header', itemSpacing: 6 });
root.appendChild(head);
head.appendChild(text(DATA.title, 28, 'Semi Bold', INK));
head.appendChild(text(DATA.subtitle, 14, 'Regular', MUTED));
head.appendChild(text('Run ' + DATA.runId, 12, 'Regular', MUTED));

const nodes = {};
for (const row of DATA.rows) {
  const rowFrame = al('VERTICAL', { name: row.frameName || row.slug, itemSpacing: 16 });
  root.appendChild(rowFrame);
  rowFrame.appendChild(text(row.slug + (row.attention ? '  ·  NEEDS ATTENTION' : ''), 18, 'Semi Bold', row.attention ? RED : INK));
  const cellsFrame = al('HORIZONTAL', { name: 'cells', itemSpacing: 48, counterAxisAlignItems: 'MIN' });
  rowFrame.appendChild(cellsFrame);
  for (const c of row.cells) {
    const cell = al('VERTICAL', { name: c.key, itemSpacing: 10 });
    cellsFrame.appendChild(cell);
    let cap = c.side.toUpperCase();
    if (c.state === 'ok') cap += (c.status ? '  ·  HTTP ' + c.status : '') + (c.moved ? '  ·  redirected' : '');
    const bad = c.state !== 'ok' || c.status >= 400 || c.moved;
    cell.appendChild(text(cap, 12, 'Semi Bold', bad ? RED : MUTED));
    if (c.state === 'ok') {
      const r = figma.createRectangle();
      r.name = c.key;
      r.resize(c.w, c.h);
      r.fills = [{ type: 'SOLID', color: { r: 0.88, g: 0.88, b: 0.9 } }];
      cell.appendChild(r);
      nodes[c.key] = r.id;
    } else {
      const box = figma.createAutoLayout('VERTICAL', { name: c.key + ' (no image)', paddingLeft: 24, paddingRight: 24, paddingTop: 24, paddingBottom: 24 });
      box.fills = [{ type: 'SOLID', color: { r: 1, g: 0.93, b: 0.93 } }];
      box.strokes = [{ type: 'SOLID', color: RED }];
      box.dashPattern = [6, 4];
      box.strokeWeight = 1;
      box.appendChild(text(c.state === 'failed' ? 'Capture failed' : 'No capture', 14, 'Semi Bold', RED));
      box.appendChild(text(c.note || '', 12, 'Regular', MUTED));
      cell.appendChild(box);
    }
  }
}
return { pageId: page.id, rootId: root.id, nodeIds: DATA.order.map(k => nodes[k]), order: DATA.order };
`;

if (code.length > USE_FIGMA_MAX_CHARS) {
  console.error(`FAIL: figma-page.js is ${code.length} chars; use_figma accepts ${USE_FIGMA_MAX_CHARS}. Push in batches with --only.`);
  process.exit(1);
}
writeFileSync(join(dir, 'figma-page.js'), code);

console.log(`Run:      ${runId}`);
console.log(`Page:     ${pageName}`);
console.log(`Figma:    ${figmaCfg.fileKey ? `file key ${figmaCfg.fileKey}` : 'no destination set (pass --config with figma.fileKey, or give the file key to use_figma yourself)'}`);
console.log(`Rows:     ${rows.length} (${rows.filter(r => r.attention).length} need attention)`);
console.log(`Uploads:  ${uploads.length} PNG(s) in ${chunks.length} upload_assets call(s)`);
for (const w of warnings) console.log(`  WARN: ${w}`);
console.log(`Wrote:    ${dir}/figma-plan.json, figma-page.js (${code.length} chars)`);
