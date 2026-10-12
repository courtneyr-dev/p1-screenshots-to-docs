#!/usr/bin/env node
/**
 * p1-editor-screenshots / handoff
 *
 * Writes the manual docs handoff note for one or more capture runs, from the run's
 * capture-report.json and figma-plan.json (run figma-plan.mjs first) and the per-run config.
 * The note goes to docs.handoffDir from the config, as markdown or json (docs.format).
 *
 * It fills in what the tools know. Everything a person has to decide (docs section, annotations,
 * the manual export step) stays a "TO FILL" line. It never claims an export to Google Docs.
 *
 * Usage:
 *   node handoff.mjs --config p1-editor.config.json --dir <out>/run1 --release "<release name>"
 *   node handoff.mjs --config ... --dir <out>/run1 --dir <out>/run2 --release "..." --approved-page "<Figma page name>"
 *   Optional: --author "<name>"  --template <file>  --captions <file>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareRuns } from './compare-runs.mjs';
import { canonicalPath, isInside } from './lib/paths.mjs';
import { loadInventory, validateInventory, formatIssues, checkText, renderDocsHandoff, inventoryCommit } from './lib/inventory.mjs';
import { TOOL_DIR, loadConfig, applyOverrides, validateConfig, formatValidation, deriveParams, applyParams, expandHome, DEFAULTS } from './lib/config.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    set: { type: 'string', multiple: true },
    dir: { type: 'string', multiple: true },
    release: { type: 'string' },
    previous: { type: 'string' },
    inventory: { type: 'string' },
    author: { type: 'string' },
    'approved-page': { type: 'string' },
    'skip-annotation': { type: 'string' },
    template: { type: 'string' },
    captions: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const fail = msg => { console.error(`FAIL: ${msg}`); process.exit(1); };

if (values.help || !values.config || !values.dir?.length || !values.release) {
  console.log(`Usage: node handoff.mjs --config <file> --dir <run folder> [--dir <second run folder>] --release "<name>"
       [--previous <previous run folder>] [--inventory <inventory file>] [--author "<name>"] [--approved-page "<Figma page name>"] [--template <file>] [--captions <file>]
       [--skip-annotation "<reason>"]   hand off without annotated frames; the note says so

Every shot needs an annotated frame, recorded with scripts/record-annotation.mjs (or an inventory record
with annotation_status complete), before a handoff is written.`);
  process.exit(values.help ? 0 : 1);
}

let cfg;
try {
  cfg = applyOverrides(loadConfig(values.config), values.set || []);
} catch (e) {
  fail(e.message);
}
const check = validateConfig(cfg, ['handoff']);
if (check.errors.length) {
  console.error(formatValidation(check, 'Handoff settings'));
  process.exit(1);
}
for (const w of check.warnings) console.error(`  ! ${w}`);

const runs = values.dir.map(d => {
  const dir = resolve(d);
  const read = f => {
    const p = join(dir, f);
    if (!existsSync(p)) fail(`${p} not found.${f === 'figma-plan.json' ? ' Run scripts/figma-plan.mjs for this run first.' : ' Run scripts/capture.mjs first.'}`);
    return JSON.parse(readFileSync(p, 'utf-8'));
  };
  return { dir, report: read('capture-report.json'), plan: read('figma-plan.json') };
});
const first = runs[0];

const base = deriveParams({ ...cfg, topic: cfg.topic || first.report.topic });
const params = {
  ...base,
  // What the run actually captured (recorded in its report) wins over the config, which may have changed since.
  projectName: first.report.projectName || cfg.projectName || '(not recorded)',
  workstream: first.report.workstream || cfg.workstream || '(not recorded)',
  pagePath: first.report.pagePath || cfg.pagePath || '(not recorded)',
  baseUrl: first.report.site || cfg.baseUrl || '(not recorded)',
  blockType: base.blockType || 'the selected block',
};

let toolCommit = '(unknown)';
try { toolCommit = execFileSync('git', ['-C', TOOL_DIR, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not in a git checkout */ }

const captionsFile = values.captions ? resolve(values.captions) : join(TOOL_DIR, 'templates', 'shot-captions.json');
const captions = JSON.parse(readFileSync(captionsFile, 'utf-8'));
const fill = t => applyParams(t, params).value;

const rows = [];
let n = 0;
const inventoryAnnotated = new Map();
const cell = s => String(s).replace(/\|/g, '\\|');
let shotTable;
let docsMapping = '(no inventory given: pass --inventory to list the exact article, heading, and image slot for each screenshot)';
if (values.inventory) {
  // Inventory-driven: identity, caption, and alt text come from the inventory record, unchanged.
  const inv = loadInventory(resolve(values.inventory));
  const check = validateInventory(inv.doc);
  if (check.errors.length) fail(`the inventory ${inv.file} is invalid:\n${formatIssues(check.errors)}`);
  const byId = new Map(inv.doc.records.map(r => [r.screenshot_id, r]));
  const idOf = slug => first.report.results.find(r => r.slug === slug)?.screenshotId;
  const used = [];
  for (const slug of [...new Set(first.plan.rows.map(r => r.slug))]) {
    const id = idOf(slug);
    if (!id) fail(`shot "${slug}" has no screenshotId in the capture report, so it is not an inventory record (inventory gap). Generate the brief with scripts/inventory.mjs brief.`);
    const rec = byId.get(id);
    if (!rec) fail(`${id} was captured but is not in ${inv.file} (inventory gap)`);
    if (rec.figma?.annotation_status === 'complete' && rec.figma?.annotated_node_id && rec.figma.annotated_node_id !== rec.figma.node_id) inventoryAnnotated.set(slug, rec.figma.annotated_node_id);
    for (const [kind, key] of [['caption', 'caption'], ['alt_text', 'alt_text']]) {
      const t = checkText(kind, rec.content?.[key], id, [...byId.keys()].filter(x => x !== id));
      if (t.errors.length) fail(`${id}: ${t.errors.join('; ')}. The handoff will not fall back to generic text.`);
    }
    n += 1;
    used.push(id);
    rows.push({ n, screenshotId: id, rectangle: `${slug}|next`, docsSection: `${rec.source.docs_document_id || rec.source.docs_url} / ${rec.source.docs_heading} / ${rec.publication.docs_image_slot}`, caption: rec.content.caption, alt: rec.content.alt_text });
  }
  shotTable = [
    '| # | Screenshot | Figma rectangle | Docs article / heading / image slot | Caption | Alt text |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.n} | \`${r.screenshotId}\` | \`${cell(r.rectangle)}\` | ${cell(r.docsSection)} | ${r.caption} | ${r.alt} |`),
  ].join('\n');
  const rendered = renderDocsHandoff(inv.doc, { ids: used, inventory: { file: values.inventory, ...inventoryCommit(inv.file) } });
  docsMapping = rendered.markdown.split('\n').slice(2).map(l => l.replace(/^## /, '### ')).join('\n');
} else {
  if (first.report.results.some(r => r.screenshotId)) process.stderr.write('  ! The report has screenshot IDs. Pass --inventory so captions, alt text, and docs slots come from the inventory.\n');
  for (const slug of [...new Set(first.plan.rows.map(r => r.slug))].sort((a, b) => Object.keys(captions).indexOf(a) - Object.keys(captions).indexOf(b))) {
    n += 1;
    const c = captions[slug] || { caption: 'TO FILL', alt: 'TO FILL' };
    rows.push({ n, rectangle: `${slug}|next`, docsSection: 'TO FILL', caption: fill(c.caption), alt: fill(c.alt) });
  }
  shotTable = [
    '| # | Figma rectangle | Docs section | Suggested caption | Suggested alt text |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.n} | \`${cell(r.rectangle)}\` | ${r.docsSection} | ${cell(r.caption)} | ${cell(r.alt)} |`),
  ].join('\n');
}

// Annotation gate: every shot needs an annotated frame before a handoff is written. The docs embed the
// annotated frame, so a handoff without one sends the docs author a bare capture.
let annotationStatus;
{
  const problems = [];
  const done = [];
  for (const run of runs) {
    const recFile = join(run.dir, 'annotation-record.json');
    const record = existsSync(recFile) ? JSON.parse(readFileSync(recFile, 'utf-8')) : { frames: {} };
    for (const slug of [...new Set(run.plan.rows.map(r => r.slug))]) {
      const f = record.frames?.[slug];
      if (f) {
        const why = [];
        if (f.status !== 'complete') why.push('status is not complete');
        if (!f.annotatedNodeId) why.push('no annotated frame node ID');
        if (f.cleanNodeId && f.cleanNodeId === f.annotatedNodeId) why.push('the annotated node ID is the clean frame');
        if (f.kitOnly !== true) why.push('not attested as Annotation kit instances only');
        if (f.redacted !== true) why.push('not attested as redacted');
        if (why.length) problems.push(`${run.plan.runId} / ${slug}: ${why.join('; ')}`);
        else done.push(`${slug} → ${f.annotatedNodeId}`);
      } else if (inventoryAnnotated.has(slug)) {
        done.push(`${slug} → ${inventoryAnnotated.get(slug)} (inventory)`);
      } else {
        problems.push(`${run.plan.runId} / ${slug}: no annotation recorded`);
      }
    }
  }
  if (values['skip-annotation'] !== undefined) {
    if (!values['skip-annotation'].trim()) fail('--skip-annotation needs a reason, for example --skip-annotation "release freeze; annotate after".');
    process.stderr.write(`  ! Annotation skipped: ${values['skip-annotation']}\n`);
    annotationStatus = `SKIPPED by request: ${values['skip-annotation']}. The docs must not embed these images until every shot has an annotated frame.${problems.length ? ' Not annotated: ' + problems.map(p => p.split(': ')[0]).join(', ') + '.' : ''}`;
  } else if (problems.length) {
    fail(`annotation is required before a handoff, and ${problems.length} shot${problems.length === 1 ? ' is' : 's are'} not ready:\n${problems.map(p => '  - ' + p).join('\n')}\nAnnotate every shot in Figma with the Annotation kit (docs/how-to/annotate.md), then record each one:\n  node scripts/record-annotation.mjs --dir <run folder> --slug <slug> --annotated-node-id <id> --kit-only --redacted\nTo hand off without annotation, pass --skip-annotation "<reason>"; the note will say it was skipped. Nothing was written.`);
  } else {
    annotationStatus = `Complete. Every shot has an annotated frame built from Annotation kit instances, with personal data redacted: ${done.join('; ')}.`;
  }
}

const skipped = [...new Map(runs.flatMap(r => r.plan.skipped || []).map(s => [s.slug, s])).values()];
// "What changed": compare with the previous release's run when one is given.
let changes = 'TO FILL: no previous run was given (--previous), so nothing was compared. For each shot, say whether the UI changed and how.';
let previousRun = '(none given)';
if (values.previous) {
  let cmp;
  try { cmp = compareRuns(values.previous, first.dir); } catch (e) { fail(`cannot compare with ${values.previous}: ${e.message}`); }
  let prevId = '(unknown)';
  try { prevId = `\`${JSON.parse(readFileSync(join(resolve(values.previous), 'figma-plan.json'), 'utf-8')).runId}\``; } catch { /* previous run was not planned */ }
  previousRun = prevId;
  const word = { identical: 'unchanged', changed: 'CHANGED', resized: 'CHANGED (size)', new: 'NEW', removed: 'removed', failed: 'FAILED now' };
  changes = [
    `Compared with run ${prevId} by pixel comparison.`,
    '',
    '| Shot | Result | Detail |',
    '| --- | --- | --- |',
    ...cmp.rows.map(r => `| \`${r.slug}\` | ${word[r.status] || r.status} | ${r.detail || ''} |`),
    '',
    cmp.rows.some(r => r.status !== 'identical') ? 'TO FILL: for each shot that is not unchanged, describe what changed in the UI (labels, layout, new or removed controls).' : 'No shot changed.',
  ].join('\n');
}

const fields = {
  release: values.release,
  changes,
  previousRun,
  captureDate: first.report.capturedAt,
  toolCommit,
  author: values.author || '(not recorded)',
  baseUrl: params.baseUrl,
  projectName: params.projectName,
  workstream: params.workstream,
  pagePath: params.pagePath,
  runIds: runs.map(r => `\`${r.plan.runId}\``).join(', '),
  figmaFileKey: cfg.figma?.fileKey ? `\`${cfg.figma.fileKey}\`` : 'TO FILL',
  figmaPages: runs.map(r => `\`${r.plan.pageName}\``).join('; '),
  annotationStatus,
  approvedPage: values['approved-page'] ? `\`${values['approved-page']}\`` : 'TO FILL: choose one of the pages above',
  shotTable,
  docsMapping,
  skippedShots: skipped.length ? skipped.map(s => `- \`${s.slug}\`: ${s.reason}`).join('\n') : 'None.',
};

const format = cfg.docs.format || DEFAULTS.docsFormat;
const outDir = resolve(expandHome(cfg.docs.handoffDir));
// Config validation already checked this; re-check right before writing, with symlinks resolved.
try {
  if (isInside(canonicalPath(outDir), canonicalPath(TOOL_DIR))) fail(`${outDir} resolves to a place inside this tool's directory. Nothing was written.`);
} catch (e) { fail(`cannot confirm where ${outDir} leads: ${e.message} Nothing was written.`); }
mkdirSync(outDir, { recursive: true });
const runKey = runs.map(r => r.plan.runId).join('+');
let out;
if (format === 'json') {
  out = join(outDir, `handoff-${runKey}.json`);
  writeFileSync(out, JSON.stringify({ ...fields, shots: rows, runs: runs.map(r => ({ runId: r.plan.runId, figmaPage: r.plan.pageName })) }, null, 2) + '\n');
} else {
  const template = readFileSync(values.template ? resolve(values.template) : join(TOOL_DIR, 'templates', 'handoff-note.template.md'), 'utf-8');
  const filled = applyParams(template, fields);
  if (filled.unresolved.length) fail(`the template uses {{${filled.unresolved.join('}}, {{')}}} with no value.`);
  out = join(outDir, `handoff-${runKey}.md`);
  writeFileSync(out, filled.value);
}
console.log(`Handoff note (${format}): ${out}`);
console.log('Fill in the TO FILL lines, then give the note to the docs author. This does not export anything to Google Docs or a docs site.');
