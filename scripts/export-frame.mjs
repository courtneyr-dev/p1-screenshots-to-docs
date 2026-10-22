#!/usr/bin/env node
/**
 * screenshots-to-docs / export-frame
 *
 * Exports a Figma frame at a scale the Figma MCP's get_screenshot can't return in one call. get_screenshot caps
 * the longest side of an image at 1024 px, so a 2200 x 1400 export (a 1100 x 700 frame at 2x) is impossible in
 * one call. The workaround: clone the frame, rescale the clone, cut it into tiles no larger than 1000 px on a
 * side, fetch each tile (a tile under the cap comes back at full resolution), and stitch the tiles into one PNG.
 *
 *   plan     print use_figma code that clones a frame at --scale and cuts the clone into TEMP-tile frames
 *   stitch   join downloaded tiles named <prefix>_r<row>c<col>.png into one PNG of a stated size, then verify it
 *   cleanup  print use_figma code that removes the TEMP- nodes plan made
 *
 * Usage:
 *   node export-frame.mjs plan --node-id 12:34 --scale 2 [--name editor-shell] [--max-tile 1000] [--out plan.js]
 *   node export-frame.mjs stitch --dir <tiles> --prefix editor-shell --width 2200 --height 1400 --out editor-shell.png
 *   node export-frame.mjs cleanup [--name editor-shell] [--out cleanup.js]
 *
 * Rows and columns count from 0. The plan's result lists each tile's node ID, row, column, and size. Fetch each
 * tile with get_screenshot, save it as <prefix>_r<row>c<col>.png, then stitch. Chrome does the stitching,
 * through puppeteer-core; set CHROME_BIN if it isn't found.
 */

import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_CAP = 1024; // get_screenshot returns at most this many pixels on the longest side
export const MAX_TILE = 1000;
const NODE_ID = /^\d+:\d+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ---------------------------------------------------------------- tiles

/** The grid that covers width x height with tiles no larger than max on either side. Tiles are as equal as possible. */
export function tileGrid(width, height, max = MAX_TILE) {
  const cols = Math.ceil(width / max), rows = Math.ceil(height / max);
  const tw = Math.ceil(width / cols), th = Math.ceil(height / rows);
  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.push({ row, col, x: col * tw, y: row * th, width: Math.min(tw, width - col * tw), height: Math.min(th, height - row * th) });
    }
  }
  return { cols, rows, tiles };
}

function checkPlanArgs({ nodeId, scale, maxTile, prefix }) {
  if (!NODE_ID.test(nodeId || '')) throw new Error(`--node-id "${nodeId}" is not a Figma node ID such as 12:34`);
  if (!(scale > 0 && scale <= 8)) throw new Error(`--scale "${scale}" must be a number above 0 and at most 8`);
  if (!Number.isInteger(maxTile) || maxTile < 100) throw new Error(`--max-tile "${maxTile}" must be a whole number of at least 100`);
  if (maxTile > MAX_TILE) throw new Error(`--max-tile ${maxTile} is over ${MAX_TILE}. get_screenshot caps the longest side at ${MCP_CAP} px, so keep tiles at ${MAX_TILE} or less.`);
  if (!NAME.test(prefix || '')) throw new Error(`--name "${prefix}" may hold only letters, digits, and hyphens (it names the tile files and the TEMP- nodes)`);
}

/** The use_figma code for `plan`. Everything it creates is named TEMP-... so `cleanup` can remove it. */
export function planCode({ nodeId, scale = 2, maxTile = MAX_TILE, prefix = 'export' }) {
  checkPlanArgs({ nodeId, scale, maxTile, prefix });
  return `const SOURCE_ID = ${JSON.stringify(nodeId)};
const SCALE = ${scale};
const MAX_TILE = ${maxTile};
const PREFIX = ${JSON.stringify(prefix)};

const src = await figma.getNodeByIdAsync(SOURCE_ID);
if (!src) throw new Error('Node ' + SOURCE_ID + ' not found. Check the ID and that the file is open.');
if (typeof src.clone !== 'function' || typeof src.rescale !== 'function') throw new Error(src.type + ' ' + SOURCE_ID + ' can not be cloned and rescaled. Pass a frame.');

// The clone is the only thing rescaled: the source frame is never touched.
const big = src.clone();
big.name = 'TEMP-clone ' + PREFIX;
big.rescale(SCALE);
const host = big.parent;
if (host && 'layoutMode' in host && host.layoutMode !== 'NONE') throw new Error('The frame sits in an auto layout parent, which would move the tiles. Move it to the page first.');

const W = Math.round(big.width), H = Math.round(big.height);
const cols = Math.ceil(W / MAX_TILE), rows = Math.ceil(H / MAX_TILE);
const tw = Math.ceil(W / cols), th = Math.ceil(H / rows);
const tiles = [];
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const w = Math.min(tw, W - c * tw), h = Math.min(th, H - r * th);
    const tile = figma.createFrame();
    tile.name = 'TEMP-tile ' + PREFIX + '_r' + r + 'c' + c;
    host.appendChild(tile);
    tile.resize(w, h);
    tile.fills = [];
    tile.clipsContent = true;
    tile.x = big.x + c * (tw + 100);
    tile.y = big.y + big.height + 200 + r * (th + 100);
    const copy = big.clone();
    tile.appendChild(copy);
    copy.x = -c * tw;
    copy.y = -r * th;
    tiles.push({ id: tile.id, name: tile.name, row: r, col: c, width: w, height: h });
  }
}
return { prefix: PREFIX, sourceId: SOURCE_ID, cloneId: big.id, scale: SCALE, width: W, height: H, cols, rows, maxTile: MAX_TILE, tiles };
`;
}

/** The use_figma code for `cleanup`: removes top-level TEMP- nodes (all of them, or those of one --name). */
export function cleanupCode({ prefix } = {}) {
  if (prefix !== undefined && !NAME.test(prefix)) throw new Error(`--name "${prefix}" may hold only letters, digits, and hyphens`);
  const starts = prefix ? [`TEMP-clone ${prefix}`, `TEMP-tile ${prefix}_`] : ['TEMP-'];
  return `const STARTS = ${JSON.stringify(starts)};
const mine = n => STARTS.some(s => n.name.startsWith(s));
try { await figma.loadAllPagesAsync(); } catch (e) {}
const removed = [];
for (const page of figma.root.children) {
  // Top-level matches only: removing a node removes what is inside it.
  const found = page.findAll(n => mine(n) && !(n.parent && n.parent.name && mine(n.parent)));
  for (const n of found) {
    if (n.removed) continue;
    removed.push({ id: n.id, name: n.name });
    n.remove();
  }
}
return { removed };
`;
}

// ---------------------------------------------------------------- PNG and Chrome

export function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function findChrome() {
  const home = process.env.HOME || '';
  const shells = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const n of readdirSync(dir).sort().reverse()) {
      const p = join(dir, n);
      if (n === 'chrome-headless-shell') { if (existsSync(p) && !existsSync(join(p, 'chrome-headless-shell'))) shells.push(p); else walk(p, depth + 1); }
      else if (n.startsWith('chromium_headless_shell') || n.startsWith('chrome-headless-shell') || n.startsWith('mac') || n.startsWith('linux')) walk(p, depth + 1);
    }
  };
  // A headless shell first: a fresh profile in the full Chrome app makes macOS ask to switch the default browser.
  for (const root of [join(home, 'Library/Caches/ms-playwright'), join(home, '.cache/ms-playwright'), join(home, '.cache/puppeteer/chrome-headless-shell')]) walk(root, 0);
  const candidates = [
    process.env.CHROME_BIN, process.env.NEXTJS_SCREENSHOTS_CHROMIUM, process.env.PUPPETEER_EXECUTABLE_PATH,
    ...shells,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find(c => existsSync(c)) || null;
}

// ---------------------------------------------------------------- stitch

/** Reads <prefix>_r<row>c<col>.png tiles from dir and checks they form one complete grid of width x height. */
export function readTiles(dir, prefix, width, height) {
  if (!NAME.test(prefix || '')) throw new Error(`--prefix "${prefix}" may hold only letters, digits, and hyphens`);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('--width and --height must be whole numbers of pixels, for example --width 2200 --height 1400');
  const pattern = new RegExp(`^${prefix}_r(\\d+)c(\\d+)\\.png$`);
  const tiles = [];
  for (const file of readdirSync(dir)) {
    const m = file.match(pattern);
    if (!m) continue;
    const buf = readFileSync(join(dir, file));
    const size = pngSize(buf);
    if (!size) throw new Error(`${file} is not a PNG`);
    tiles.push({ file, row: Number(m[1]), col: Number(m[2]), buf, ...size });
  }
  if (!tiles.length) throw new Error(`no tiles named ${prefix}_r<row>c<col>.png in ${dir}`);
  const rows = Math.max(...tiles.map(t => t.row)) + 1, cols = Math.max(...tiles.map(t => t.col)) + 1;
  const at = (r, c) => tiles.find(t => t.row === r && t.col === c);
  const missing = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!at(r, c)) missing.push(`${prefix}_r${r}c${c}.png`);
  if (missing.length) throw new Error(`missing ${missing.length} of ${rows * cols} tiles: ${missing.join(', ')}`);
  // Every tile in a column shares a width, and every tile in a row a height; offsets come from those sizes.
  const colW = Array.from({ length: cols }, (_, c) => at(0, c).width);
  const rowH = Array.from({ length: rows }, (_, r) => at(r, 0).height);
  for (const t of tiles) {
    if (t.width !== colW[t.col] || t.height !== rowH[t.row]) throw new Error(`${t.file} is ${t.width} x ${t.height} px, but column ${t.col} is ${colW[t.col]} wide and row ${t.row} is ${rowH[t.row]} high`);
  }
  const sum = a => a.reduce((x, y) => x + y, 0);
  if (sum(colW) !== width || sum(rowH) !== height) throw new Error(`the tiles add up to ${sum(colW)} x ${sum(rowH)} px, not the ${width} x ${height} you stated. A tile is missing from an edge, or the size is wrong.`);
  for (const t of tiles) { t.x = sum(colW.slice(0, t.col)); t.y = sum(rowH.slice(0, t.row)); }
  return { tiles, rows, cols };
}

export async function stitchTiles({ dir, prefix, width, height, out }) {
  const { tiles } = readTiles(resolve(dir), prefix, width, height);
  const chrome = findChrome();
  if (!chrome) throw new Error('no Chrome found to stitch with. Set CHROME_BIN=/path/to/chrome.');
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, waitForInitialPage: false, args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><canvas id="c"></canvas>');
    const dataUrl = await page.evaluate(async (list, w, h) => {
      const canvas = document.getElementById('c');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      for (const t of list) {
        const img = new Image();
        img.src = 'data:image/png;base64,' + t.data;
        await img.decode();
        ctx.drawImage(img, t.x, t.y);
      }
      return canvas.toDataURL('image/png');
    }, tiles.map(t => ({ x: t.x, y: t.y, data: t.buf.toString('base64') })), width, height);
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    const size = pngSize(buf);
    if (!size || size.width !== width || size.height !== height) throw new Error(`the stitched image is ${size ? `${size.width} x ${size.height}` : 'not a PNG'}, not ${width} x ${height}. Nothing was written.`);
    writeFileSync(resolve(out), buf);
    return { tiles: tiles.length, width: size.width, height: size.height, out: resolve(out) };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- command line

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const usage = `Usage:
  node export-frame.mjs plan --node-id <id> [--scale 2] [--name <prefix>] [--max-tile ${MAX_TILE}] [--out plan.js]
  node export-frame.mjs stitch --dir <tiles> --prefix <prefix> --width <px> --height <px> --out <file.png>
  node export-frame.mjs cleanup [--name <prefix>] [--out cleanup.js]`;
  if (!['plan', 'stitch', 'cleanup'].includes(command)) {
    console.log(usage);
    process.exit(command === '--help' || command === '-h' ? 0 : 1);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      'node-id': { type: 'string' }, scale: { type: 'string', default: '2' }, name: { type: 'string' }, 'max-tile': { type: 'string', default: String(MAX_TILE) },
      out: { type: 'string' }, dir: { type: 'string' }, prefix: { type: 'string' }, width: { type: 'string' }, height: { type: 'string' },
    },
  });
  const emit = (code, note) => {
    if (values.out) { writeFileSync(resolve(values.out), code); console.log(`Wrote ${values.out}. ${note}`); } else process.stdout.write(code);
  };
  try {
    if (command === 'plan') {
      emit(planCode({ nodeId: values['node-id'], scale: Number(values.scale), maxTile: Number(values['max-tile']), prefix: values.name || 'export' }),
        'Run it with use_figma. It returns the tile IDs; fetch each with get_screenshot, save it as <prefix>_r<row>c<col>.png, then run stitch.');
    } else if (command === 'cleanup') {
      emit(cleanupCode({ prefix: values.name }), 'Run it with use_figma. It removes the TEMP- nodes and returns what it removed.');
    } else {
      for (const k of ['dir', 'prefix', 'width', 'height', 'out']) if (!values[k]) throw new Error(`stitch needs --${k}\n${usage}`);
      const r = await stitchTiles({ dir: values.dir, prefix: values.prefix, width: Number(values.width), height: Number(values.height), out: values.out });
      console.log(`Stitched ${r.tiles} tiles into ${r.out}: ${r.width} x ${r.height} px, as stated.`);
    }
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }
}
