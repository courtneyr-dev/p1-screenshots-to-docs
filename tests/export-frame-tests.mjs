#!/usr/bin/env node
/**
 * Tests for scripts/export-frame.mjs: planning tiles for a frame over get_screenshot's 1024 px cap, stitching
 * the downloaded tiles, and cleaning up. The plan and cleanup code run against a small in-memory model of the
 * Figma plugin API; the stitch uses synthetic PNG tiles and headless Chrome (it needs Chrome, like the
 * capture tests). Prints PASS/FAIL lines in the format tests/run-tests.sh counts.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { planCode, cleanupCode, tileGrid, stitchTiles, readTiles, pngSize, findChrome } from '../scripts/export-frame.mjs';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'export-frame-test-')));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`FAIL  ${name}`); console.log('        ' + String(e.message || e).split('\n').slice(0, 8).join('\n        ')); failed += 1; }
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const cli = (...args) => spawnSync('node', [join(ROOT, 'scripts', 'export-frame.mjs'), ...args], { encoding: 'utf-8' });

// ---------- a minimal model of the Figma plugin API ----------

let registry = null; // the model that numbers every node, including clones
class Node {
  constructor(type, name, w = 0, h = 0) { Object.assign(this, { type, name, width: w, height: h, x: 0, y: 0, children: [], parent: null, removed: false, fills: [{ type: 'SOLID' }], clipsContent: false, layoutMode: 'NONE', rescales: [] }); }
  appendChild(n) { n.parent?.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n); }
  resize(w, h) { this.width = w; this.height = h; }
  rescale(s) { this.rescales.push(s); this.width *= s; this.height *= s; }
  clone() {
    const c = new Node(this.type, this.name, this.width, this.height);
    Object.assign(c, { x: this.x, y: this.y, layoutMode: this.layoutMode });
    this.parent?.appendChild(c);
    return registry.reg(c);
  }
  remove() { this.removed = true; this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  findAll(pred) { const out = []; const walk = n => { for (const c of n.children) { if (pred(c)) out.push(c); walk(c); } }; walk(this); return out; }
}
function mockFigma(build) {
  let seq = 0;
  const all = new Map();
  const reg = n => { n.id = `${100 + ++seq}:${seq}`; all.set(n.id, n); return n; };
  const page = new Node('PAGE', 'Page 1');
  const doc = { children: [page] };
  const figma = {
    root: doc,
    getNodeByIdAsync: async id => all.get(id) || null,
    createFrame: () => reg(new Node('FRAME', 'Frame')),
    loadAllPagesAsync: async () => {},
  };
  const ctx = { figma, page, reg };
  registry = ctx;
  build(ctx);
  return ctx;
}
const run = (code, figma) => new AsyncFunction('figma', code)(figma);

// ---------- tile grid ----------

await test('tileGrid: 2200 x 1400 is 3 columns by 2 rows of 734 x 700 tiles, the last column 732 wide', () => {
  const g = tileGrid(2200, 1400);
  assert.deepEqual([g.cols, g.rows, g.tiles.length], [3, 2, 6]);
  assert.deepEqual(g.tiles.map(t => [t.width, t.height]), [[734, 700], [734, 700], [732, 700], [734, 700], [734, 700], [732, 700]]);
});

await test('tileGrid: no tile is over 1000 px on either side, and the tiles cover the image exactly, for many sizes', () => {
  for (const [w, h] of [[1, 1], [999, 999], [1000, 1000], [1001, 1000], [1000, 1001], [2200, 1400], [2880, 1800], [4096, 4096], [3001, 17], [1440, 9000]]) {
    const g = tileGrid(w, h);
    let area = 0;
    for (const t of g.tiles) {
      assert.ok(t.width <= 1000 && t.height <= 1000 && t.width > 0 && t.height > 0, `${w}x${h} ${JSON.stringify(t)}`);
      area += t.width * t.height;
    }
    assert.equal(area, w * h, `${w}x${h} coverage`);
    assert.equal(g.tiles.length, g.cols * g.rows);
  }
  assert.equal(tileGrid(1000, 1000).tiles.length, 1);
  assert.equal(tileGrid(1001, 1000).tiles.length, 2);
});

// ---------- plan ----------

await test('plan: a 1100 x 700 frame at 2x becomes six TEMP-tile frames of 734 x 700 and the source is untouched', async () => {
  const m = mockFigma(({ page, reg }) => { const f = reg(new Node('FRAME', 'Editor shot', 1100, 700)); f.x = 40; f.y = 60; page.appendChild(f); });
  const src = m.page.children[0];
  const out = await run(planCode({ nodeId: src.id, scale: 2, prefix: 'editor-shell' }), m.figma);
  assert.deepEqual([out.width, out.height, out.cols, out.rows], [2200, 1400, 3, 2]);
  assert.equal(out.tiles.length, 6);
  assert.deepEqual(out.tiles.map(t => t.name), ['r0c0', 'r0c1', 'r0c2', 'r1c0', 'r1c1', 'r1c2'].map(s => `TEMP-tile editor-shell_${s}`));
  for (const t of out.tiles) assert.ok(t.width <= 1000 && t.height <= 1000);
  assert.deepEqual(out.tiles.map(t => [t.row, t.col]), [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]);
  assert.deepEqual([src.width, src.height, src.x, src.y, src.rescales.length, src.name], [1100, 700, 40, 60, 0, 'Editor shot'], 'the source frame is unchanged');
});

await test('plan: every tile frame clips a copy of the 2x clone, offset by its position, and is a TEMP- node', async () => {
  const m = mockFigma(({ page, reg }) => { page.appendChild(reg(new Node('FRAME', 'Shot', 1100, 700))); });
  const out = await run(planCode({ nodeId: m.page.children[0].id, scale: 2, prefix: 'p' }), m.figma);
  const clone = m.figma.root.children[0].children.find(n => n.name === 'TEMP-clone p');
  assert.ok(clone && clone.rescales.join() === '2' && clone.width === 2200 && clone.height === 1400, 'the clone is rescaled 2x');
  assert.equal(out.cloneId, clone.id);
  for (const t of out.tiles) {
    const frame = m.figma.root.children[0].children.find(n => n.id === t.id);
    assert.ok(frame.name.startsWith('TEMP-') && frame.clipsContent === true && frame.fills.length === 0);
    assert.equal(frame.children.length, 1);
    const [copy] = frame.children;
    assert.deepEqual([copy.x, copy.y, copy.width, copy.height], [-t.col * 734, -t.row * 700, 2200, 1400]);
    assert.deepEqual([frame.width, frame.height], [t.width, t.height]);
  }
  // Every node the plan left on the page is TEMP- (the source aside).
  const left = m.figma.root.children[0].children.filter(n => n.name !== 'Shot');
  assert.ok(left.length === 7 && left.every(n => n.name.startsWith('TEMP-')), left.map(n => n.name).join());
});

await test('plan: a frame that already fits (900 x 600 at 1x) makes one tile, so a small export needs no stitching', async () => {
  const m = mockFigma(({ page, reg }) => { page.appendChild(reg(new Node('FRAME', 'Small', 900, 600))); });
  const out = await run(planCode({ nodeId: m.page.children[0].id, scale: 1, prefix: 's' }), m.figma);
  assert.deepEqual([out.cols, out.rows, out.tiles.length, out.tiles[0].width, out.tiles[0].height], [1, 1, 1, 900, 600]);
});

await test('plan: a missing node, a node that cannot be rescaled, and an auto layout parent each fail before anything is made', async () => {
  const m = mockFigma(({ page, reg }) => {
    page.appendChild(reg(new Node('FRAME', 'Shot', 1100, 700)));
    const text = reg(new Node('TEXT', 'Label', 10, 10)); text.rescale = undefined; page.appendChild(text);
    const auto = reg(new Node('FRAME', 'Auto', 500, 500)); auto.layoutMode = 'VERTICAL'; page.appendChild(auto);
    const inner = reg(new Node('FRAME', 'Inner', 100, 100)); auto.appendChild(inner);
  });
  const [, text, auto] = m.page.children;
  await assert.rejects(run(planCode({ nodeId: '9:9' }), m.figma), /not found/);
  await assert.rejects(run(planCode({ nodeId: text.id }), m.figma), /can not be cloned and rescaled/);
  await assert.rejects(run(planCode({ nodeId: auto.children[0].id }), m.figma), /auto layout parent/);
});

await test('plan refuses a tile size over 1000 (the 1024 px cap), a bad node ID, a bad scale, and a bad name', () => {
  assert.throws(() => planCode({ nodeId: '1:2', maxTile: 1024 }), /over 1000.*1024/);
  assert.throws(() => planCode({ nodeId: '1:2', maxTile: 50 }), /at least 100/);
  assert.throws(() => planCode({ nodeId: 'abc' }), /not a Figma node ID/);
  assert.throws(() => planCode({ nodeId: '1:2', scale: 0 }), /scale/);
  assert.throws(() => planCode({ nodeId: '1:2', scale: 9 }), /scale/);
  assert.throws(() => planCode({ nodeId: '1:2', prefix: 'a b' }), /letters, digits, and hyphens/);
  assert.throws(() => planCode({ nodeId: '1:2', prefix: '../x' }), /letters, digits, and hyphens/);
});

await test('plan --out writes code that parses, and the CLI exits 1 with the reason for a bad argument', () => {
  const f = join(TMP, 'plan.js');
  const ok = cli('plan', '--node-id', '12:34', '--scale', '2', '--name', 'shot', '--out', f);
  assert.equal(ok.status, 0, ok.stderr);
  new AsyncFunction('figma', readFileSync(f, 'utf-8'));
  assert.match(ok.stdout, /get_screenshot/);
  const bad = cli('plan', '--node-id', '12:34', '--max-tile', '1024');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /1024/);
  assert.equal(cli('bogus').status, 1);
});

// ---------- cleanup ----------

await test('cleanup removes only TEMP- nodes (top level, once), keeps everything else, and says what it removed', async () => {
  const m = mockFigma(({ page, reg }) => {
    page.appendChild(reg(new Node('FRAME', 'Shot', 1100, 700)));
    page.appendChild(reg(new Node('FRAME', 'TEMPLATE notes')));   // starts with TEMP but not TEMP-
    page.appendChild(reg(new Node('FRAME', 'temp-lower')));
    const tile = reg(new Node('FRAME', 'TEMP-tile a_r0c0')); page.appendChild(tile);
    tile.appendChild(reg(new Node('FRAME', 'TEMP-inner')));
    tile.appendChild(reg(new Node('FRAME', 'child of a tile')));
    page.appendChild(reg(new Node('FRAME', 'TEMP-clone a')));
  });
  const out = await run(cleanupCode(), m.figma);
  assert.deepEqual(out.removed.map(r => r.name).sort(), ['TEMP-clone a', 'TEMP-tile a_r0c0']);
  assert.deepEqual(m.page.children.map(n => n.name), ['Shot', 'TEMPLATE notes', 'temp-lower']);
});

await test('cleanup --name removes only that export\'s nodes', async () => {
  const m = mockFigma(({ page, reg }) => {
    for (const n of ['TEMP-clone a', 'TEMP-tile a_r0c0', 'TEMP-tile a_r0c1', 'TEMP-clone b', 'TEMP-tile b_r0c0', 'TEMP-tile ab_r0c0']) page.appendChild(reg(new Node('FRAME', n)));
  });
  const out = await run(cleanupCode({ prefix: 'a' }), m.figma);
  assert.equal(out.removed.length, 3);
  assert.deepEqual(m.page.children.map(n => n.name), ['TEMP-clone b', 'TEMP-tile b_r0c0', 'TEMP-tile ab_r0c0']);
  assert.throws(() => cleanupCode({ prefix: 'a/b' }), /letters, digits, and hyphens/);
});

await test('plan then cleanup leaves the file as it was', async () => {
  const m = mockFigma(({ page, reg }) => { page.appendChild(reg(new Node('FRAME', 'Shot', 1100, 700))); });
  const id = m.page.children[0].id;
  await run(planCode({ nodeId: id, scale: 2, prefix: 'x' }), m.figma);
  assert.ok(m.page.children.length > 1);
  await run(cleanupCode({ prefix: 'x' }), m.figma);
  assert.deepEqual(m.page.children.map(n => n.name), ['Shot']);
});

// ---------- stitch: synthetic PNG tiles ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function encodePng(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = pixel(x, y); raw.set([r, g, b, 255], y * (w * 4 + 1) + 1 + x * 4); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// An independent decoder (8-bit RGBA or RGB, any filter), so the stitch is not graded by the code under test.
function decodePng(buf) {
  const { width, height } = pngSize(buf);
  const colorType = buf[25], bpp = colorType === 6 ? 4 : 3;
  const idat = []; let p = 8;
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8); if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len)); p += 12 + len; }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * bpp, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i], a = i >= bpp ? px[y * stride + i - bpp] : 0, b = y ? px[(y - 1) * stride + i] : 0, c = i >= bpp && y ? px[(y - 1) * stride + i - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      px[y * stride + i] = (v + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
  }
  return { width, height, at: (x, y) => [...px.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)] };
}
const hasChrome = !!findChrome();

// A 2200 x 1400 export as the plan cuts it: 3 x 2 tiles of 734/734/732 by 700. Each tile has its own base color
// and, at its corners, marker pixels that must land on either side of a seam.
const COLS = [734, 734, 732], ROWS = [700, 700];
const BASE = [[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120], [130, 140, 150], [160, 170, 180]];
const RED = [255, 0, 0], BLUE = [0, 0, 255], GREEN = [0, 255, 0], MAGENTA = [255, 0, 255], YELLOW = [255, 255, 0];
function writeTiles(dir, prefix) {
  mkdirSync(dir, { recursive: true });
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
    const w = COLS[c], h = ROWS[r];
    const px = (x, y) => {
      if (r === 0 && c === 0 && x === w - 1 && y === h - 1) return RED;   // global (733, 699): bottom right of the first tile
      if (r === 0 && c === 1 && x === 0 && y === 0) return BLUE;          // global (734, 0): first pixel of the next column
      if (r === 1 && c === 0 && x === 0 && y === 0) return GREEN;         // global (0, 700): first pixel of the next row
      if (r === 1 && c === 1 && x === 0 && y === 0) return YELLOW;        // global (734, 700): where four tiles meet
      if (r === 1 && c === 2 && x === w - 1 && y === h - 1) return MAGENTA; // global (2199, 1399): the last pixel
      return BASE[r * 3 + c];
    };
    writeFileSync(join(dir, `${prefix}_r${r}c${c}.png`), encodePng(w, h, px));
  }
}
const SEAMS = [[733, 699, RED, 'last pixel of the first tile'], [734, 0, BLUE, 'first pixel of the second column'], [0, 700, GREEN, 'first pixel of the second row'], [734, 700, YELLOW, 'where four tiles meet'], [2199, 1399, MAGENTA, 'the last pixel']];
const seamErrors = img => SEAMS.filter(([x, y, want]) => img.at(x, y).join() !== want.join()).map(s => s[3]);

const T = join(TMP, 'tiles');
if (hasChrome) writeTiles(T, 'shot');

await test('stitch needs Chrome (the stitch tests would otherwise prove nothing)', () => { assert.ok(hasChrome, 'no Chrome found; set CHROME_BIN'); });

await test('stitch: six tiles become one 2200 x 1400 PNG and the size is verified', async () => {
  const out = join(TMP, 'stitched.png');
  const r = await stitchTiles({ dir: T, prefix: 'shot', width: 2200, height: 1400, out });
  assert.deepEqual([r.tiles, r.width, r.height], [6, 2200, 1400]);
  assert.deepEqual(pngSize(readFileSync(out)), { width: 2200, height: 1400 });
});

await test('stitch seams: a known pixel at each tile boundary lands in the right place, and the tile interiors keep their colors', () => {
  const img = decodePng(readFileSync(join(TMP, 'stitched.png')));
  assert.deepEqual(seamErrors(img), []);
  for (const [x, y, base] of [[5, 5, 0], [740, 5, 1], [1500, 5, 2], [5, 705, 3], [740, 705, 4], [1500, 705, 5]]) assert.deepEqual(img.at(x, y), BASE[base], `interior at ${x},${y}`);
  // The pixel just before each seam is still the previous tile's color.
  assert.deepEqual(img.at(733, 0), BASE[0]);
  assert.deepEqual(img.at(0, 699), BASE[0]);
  assert.deepEqual(img.at(1468, 0), BASE[2]);   // 734 + 734: first column of the third tile
});

await test('MUTATION: two same-size tiles swapped keeps the size but fails the seam check, so the seam test can fail', async () => {
  const S = join(TMP, 'tiles-swapped'); writeTiles(S, 'shot');
  renameSync(join(S, 'shot_r0c0.png'), join(S, 'tmp.png'));
  renameSync(join(S, 'shot_r0c1.png'), join(S, 'shot_r0c0.png'));
  renameSync(join(S, 'tmp.png'), join(S, 'shot_r0c1.png'));
  const out = join(TMP, 'swapped.png');
  await stitchTiles({ dir: S, prefix: 'shot', width: 2200, height: 1400, out });
  assert.deepEqual(pngSize(readFileSync(out)), { width: 2200, height: 1400 });
  const errs = seamErrors(decodePng(readFileSync(out)));
  assert.ok(errs.includes('last pixel of the first tile') && errs.includes('first pixel of the second column'), errs.join());
});

await test('stitch refuses a missing tile and names it, and writes nothing', async () => {
  const S = join(TMP, 'tiles-missing'); writeTiles(S, 'shot'); rmSync(join(S, 'shot_r1c1.png'));
  const out = join(TMP, 'missing.png');
  await assert.rejects(stitchTiles({ dir: S, prefix: 'shot', width: 2200, height: 1400, out }), /missing 1 of 6 tiles: shot_r1c1\.png/);
  assert.ok(!existsSync(out));
});

await test('stitch refuses a size that is not the tiles\' total, and says what the tiles add up to', async () => {
  const out = join(TMP, 'wrongsize.png');
  await assert.rejects(stitchTiles({ dir: T, prefix: 'shot', width: 2400, height: 1400, out }), /add up to 2200 x 1400 px, not the 2400 x 1400/);
  await assert.rejects(stitchTiles({ dir: T, prefix: 'shot', width: 2200, height: 1024, out }), /add up to 2200 x 1400 px, not the 2200 x 1024/);
  assert.ok(!existsSync(out));
});

await test('stitch refuses a tile whose size does not fit its row and column, and a file that is not a PNG', async () => {
  const S = join(TMP, 'tiles-odd'); writeTiles(S, 'shot');
  writeFileSync(join(S, 'shot_r1c2.png'), encodePng(734, 700, () => BASE[5]));
  await assert.rejects(stitchTiles({ dir: S, prefix: 'shot', width: 2200, height: 1400, out: join(TMP, 'odd.png') }), /shot_r1c2\.png is 734 x 700 px, but column 2 is 732 wide/);
  const N = join(TMP, 'tiles-notpng'); writeTiles(N, 'shot'); writeFileSync(join(N, 'shot_r0c2.png'), 'not a png at all, just text');
  await assert.rejects(stitchTiles({ dir: N, prefix: 'shot', width: 2200, height: 1400, out: join(TMP, 'np.png') }), /shot_r0c2\.png is not a PNG/);
});

await test('stitch ignores other prefixes in the folder, and refuses a folder with none of its tiles', async () => {
  const S = join(TMP, 'tiles-mixed'); writeTiles(S, 'shot'); writeTiles(S, 'other');
  assert.equal(readTiles(S, 'shot', 2200, 1400).tiles.length, 6);
  await assert.rejects(stitchTiles({ dir: S, prefix: 'nothing', width: 10, height: 10, out: join(TMP, 'n.png') }), /no tiles named nothing_r<row>c<col>\.png/);
});

await test('stitch CLI prints the verified size and exits 0; exits 1 with the reason when a tile is missing', () => {
  const out = join(TMP, 'cli.png');
  const ok = cli('stitch', '--dir', T, '--prefix', 'shot', '--width', '2200', '--height', '1400', '--out', out);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Stitched 6 tiles into .*2200 x 1400 px, as stated/);
  const S = join(TMP, 'tiles-cli-missing'); writeTiles(S, 'shot'); rmSync(join(S, 'shot_r0c0.png'));
  const bad = cli('stitch', '--dir', S, '--prefix', 'shot', '--width', '2200', '--height', '1400', '--out', join(TMP, 'cli2.png'));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /shot_r0c0\.png/);
  assert.equal(cli('stitch', '--dir', T).status, 1);
});

console.log(`\nexport-frame tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
