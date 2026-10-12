#!/usr/bin/env node
/**
 * screenshots-to-docs / capture-window
 *
 * Captures one window of a desktop app on macOS (Claude Desktop, Cursor, VS Code, Terminal) as a PNG, for the
 * screens no browser preset can reach. You set the window up first: open the app, run the steps, and leave the
 * reply or screen the doc needs on screen. This script finds the window by app name (and title), captures only
 * that window at its native resolution, and records it in capture-report.json in the same format as capture.mjs,
 * so the Figma, alt-text, and inventory steps work the same way.
 *
 * It reads the window list and captures; it doesn't click or type in the app. --size and --front change the
 * window (its size, or which app is in front), and only when you ask for them.
 *
 * Usage:
 *   node scripts/capture-window.mjs --list [--app Claude]
 *   node scripts/capture-window.mjs --app Claude --slug assistant-reply --topic my-doc [--title "<window title text>"]
 *        [--out-dir <dir>] [--size 1440x900] [--front] [--delay 3]
 *
 * The window must be on screen: not minimized, and in the current Stage Manager group. --front brings the app
 * forward first.
 *
 * Needs macOS, and Screen Recording permission for the app running this command (System Settings > Privacy &
 * Security > Screen Recording). --size also needs Accessibility permission.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

// A window is { id, app, title, w, h } in points. Small windows are Stage Manager thumbnails and app icons.
export function pickWindow(windows, { app, title } = {}) {
  const real = windows.filter(w => w.w >= 300 && w.h >= 200);
  const byApp = real.filter(w => w.app.toLowerCase() === String(app || '').toLowerCase());
  const matches = title ? byApp.filter(w => w.title.toLowerCase().includes(title.toLowerCase())) : byApp;
  if (!byApp.length) return { error: `no window on screen for "${app}" (minimized windows and other Stage Manager groups don't count; --front brings the app forward). Apps with windows on screen: ${[...new Set(real.map(w => w.app))].sort().join(', ') || '(none)'}` };
  if (!matches.length) return { error: `"${app}" has no window whose title contains "${title}". Its windows: ${byApp.map(w => `"${w.title}"`).join(', ')}` };
  if (matches.length > 1) return { error: `"${app}" has ${matches.length} windows: ${matches.map(w => `"${w.title}"`).join(', ')}. Add --title to pick one.` };
  return { window: matches[0] };
}

// Add or replace one shot in a capture report, keeping the format capture.mjs writes.
export function mergeReport(existing, { topic, app, slug, file, dpr, capturedAt }) {
  const report = existing && Array.isArray(existing.results) ? existing : { topic, site: null, baseline: null, target: 'next', preset: 'desktop-window', signIn: 'none', skipped: [], results: [] };
  const url = `app://${encodeURIComponent(app)}/`;
  const row = { slug, side: 'next', ok: true, file, url, finalUrl: url, status: null, devMode: false, dpr, app };
  report.results = [...report.results.filter(r => !(r.slug === slug && r.side === 'next')), row];
  report.site = report.site || url;
  report.capturedAt = capturedAt;
  return report;
}

export function parseSize(s) {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(s || '');
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

const JXA_LIST = `ObjC.import("CoreGraphics");
const l = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)));
JSON.stringify(l.filter(w => w.kCGWindowLayer === 0).map(w => ({ id: w.kCGWindowNumber, app: w.kCGWindowOwnerName || "", title: w.kCGWindowName || "", w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height })))`;

function listWindows() {
  const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', JXA_LIST], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`could not read the window list: ${(r.stderr || '').trim().split('\n')[0]}`);
  return JSON.parse(r.stdout);
}

function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { values } = parseArgs({ options: {
    app: { type: 'string' }, title: { type: 'string' }, slug: { type: 'string' }, topic: { type: 'string' },
    'out-dir': { type: 'string' }, size: { type: 'string' }, front: { type: 'boolean' }, delay: { type: 'string', default: '0' },
    list: { type: 'boolean' }, 'allow-tracked-output': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const fail = m => { console.error(`FAIL: ${m}`); process.exit(1); };
  if (process.platform !== 'darwin') fail('capture-window needs macOS');
  if (values.help || (!values.list && (!values.app || !values.slug || !values.topic))) {
    console.log('Usage: node scripts/capture-window.mjs --list [--app <App>]\n       node scripts/capture-window.mjs --app <App> --slug <slug> --topic <topic> [--title <text>] [--out-dir <dir>] [--size 1440x900] [--front] [--delay <seconds>]');
    process.exit(values.help ? 0 : 1);
  }
  // The window list only has windows on screen (not minimized, not in another Stage Manager group), so --front
  // brings the app forward before the lookup.
  if (values.front && values.app) { spawnSync('osascript', ['-e', `tell application "${values.app.replace(/"/g, '')}" to activate`]); await sleep(1500); }
  let windows;
  try { windows = listWindows(); } catch (e) { fail(e.message); }
  if (values.list) {
    for (const w of windows.filter(w => w.w >= 300 && w.h >= 200 && (!values.app || w.app.toLowerCase() === values.app.toLowerCase()))) {
      console.log(`${String(w.id).padEnd(8)} ${w.app.padEnd(20)} ${Math.round(w.w)}x${Math.round(w.h)}  ${w.title}`);
    }
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(values.slug)) fail('--slug must be lowercase letters, digits, and "-"');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(values.topic)) fail('--topic must be lowercase letters, digits, and "-"');
  const picked = pickWindow(windows, { app: values.app, title: values.title });
  if (picked.error) fail(picked.error);
  const win = picked.window;

  const outDir = resolve(values['out-dir'] || join('screenshots', values.topic));
  // Same rule as capture.mjs: screenshots of a signed-in app must not land where git would pick them up.
  for (let d = outDir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) {
      const ignored = spawnSync('git', ['-C', d, 'check-ignore', '-q', '--no-index', join(outDir, `${values.slug}.png`)]).status === 0;
      if (!ignored && !values['allow-tracked-output']) fail(`--out-dir ${outDir} is inside a git repository (${d}) and isn't git-ignored. Use an ignored folder such as screenshots/.`);
      break;
    }
    if (dirname(d) === d) break;
  }
  mkdirSync(outDir, { recursive: true });

  if (values.size) {
    const size = parseSize(values.size);
    if (!size) fail('--size must look like 1440x900');
    const r = spawnSync('osascript', ['-e', `tell application "System Events" to tell (first process whose name is "${win.app.replace(/"/g, '')}") to set size of (first window whose name is "${win.title.replace(/"/g, '')}") to {${size.w}, ${size.h}}`], { encoding: 'utf-8' });
    if (r.status !== 0) fail(`could not resize the window (System Events needs Accessibility permission): ${(r.stderr || '').trim().split('\n')[0]}`);
    await sleep(800);
  }
  const delay = Number(values.delay);
  if (!Number.isFinite(delay) || delay < 0) fail('--delay must be a number of seconds');
  if (delay) await sleep(delay * 1000);

  const file = join(outDir, `${values.slug}.png`);
  // -l: one window by ID, even when another app is in front. -o: no window shadow. -x: no sound.
  const shot = spawnSync('screencapture', ['-x', '-o', '-l', String(win.id), file], { encoding: 'utf-8' });
  if (shot.status !== 0 || !existsSync(file)) fail(`screencapture failed${shot.stderr ? `: ${shot.stderr.trim()}` : ''}. Check Screen Recording permission for the app running this command.`);
  const px = pngSize(file);
  const dpr = Math.round(px.w / win.w) || 1;

  const reportFile = join(outDir, 'capture-report.json');
  const existing = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf-8')) : null;
  writeFileSync(reportFile, JSON.stringify(mergeReport(existing, { topic: values.topic, app: win.app, slug: values.slug, file, dpr, capturedAt: new Date().toISOString() }), null, 2));
  console.log(`  ${values.slug.padEnd(44)} OK  ${win.app} "${win.title}"  ${px.w}x${px.h} (${dpr}x)`);
  console.log(`Report: ${reportFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
