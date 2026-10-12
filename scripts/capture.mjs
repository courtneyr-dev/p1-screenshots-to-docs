#!/usr/bin/env node
/**
 * nextjs-screenshots / capture
 *
 * Puppeteer-driven screenshot harness for Next.js sites. Reads a JSON brief
 * describing each shot and writes PNGs into an output folder. When the brief
 * names a `baseline` site (the WordPress site being replaced), every shot is
 * also captured there, at the same path, into <outDir>/baseline/.
 *
 * Usage:
 *   node capture.mjs --brief briefs/my-site.json
 *   node capture.mjs --brief briefs/my-site.json --target baseline
 *   node capture.mjs --brief briefs/my-site.json --only 01-home,02-about
 *
 * See SKILL.md for the brief schema.
 */

import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, applyOverrides, validateConfig, formatValidation, deriveParams, applyParams, presetNameOf, signInModeOf } from './lib/config.mjs';
import { loadPreset } from './lib/presets.mjs';

// Freeze motion and hide the Next.js dev overlay / build indicator.
const STABILIZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition: none !important;
    caret-color: transparent !important;
  }
  nextjs-portal { display: none !important; }
`;

const CHROMIUM_CANDIDATES = [
  process.env.NEXTJS_SCREENSHOTS_CHROMIUM,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter(Boolean);

// Headless shell builds first: a fresh profile in the full Chrome app makes macOS ask to switch the default browser.
function headlessShells() {
  const home = process.env.HOME || '';
  const roots = [join(home, 'Library/Caches/ms-playwright'), join(home, '.cache/ms-playwright'), join(home, '.cache/puppeteer/chrome-headless-shell')];
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const n of readdirSync(dir).sort().reverse()) {
      const p = join(dir, n);
      if (n === 'chrome-headless-shell') { if (existsSync(p) && !existsSync(join(p, 'chrome-headless-shell'))) found.push(p); else walk(p, depth + 1); }
      else if (n.startsWith('chromium_headless_shell') || n.startsWith('chrome-headless-shell') || n.startsWith('mac') || n.startsWith('linux')) walk(p, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return found;
}

function findChromium() {
  if (process.env.NEXTJS_SCREENSHOTS_CHROMIUM && existsSync(process.env.NEXTJS_SCREENSHOTS_CHROMIUM)) return process.env.NEXTJS_SCREENSHOTS_CHROMIUM;
  const shell = headlessShells()[0];
  if (shell) return shell;
  for (const c of CHROMIUM_CANDIDATES) if (existsSync(c)) return c;
  const cacheRoot = join(process.env.HOME || '', '.cache/puppeteer/chrome');
  if (existsSync(cacheRoot)) {
    for (const d of readdirSync(cacheRoot).sort().reverse()) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
        const p = join(cacheRoot, d, sub);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

const { values } = parseArgs({
  options: {
    brief:      { type: 'string' },
    site:       { type: 'string' },
    baseline:   { type: 'string' },
    target:     { type: 'string' },
    'out-dir':  { type: 'string' },
    only:       { type: 'string' },
    'no-login': { type: 'boolean' },
    connect:    { type: 'string' },
    config:     { type: 'string' },
    set:        { type: 'string', multiple: true },
    'dry-run':  { type: 'boolean' },
    'allow-tracked-output': { type: 'boolean' },
    help:       { type: 'boolean' },
  },
  strict: false,
});

if (values.help || !values.brief) {
  console.log(`Usage: node capture.mjs --brief <brief.json> [options]

Options:
  --site <url>          Next.js base URL (overrides brief.site)
  --baseline <url>      Site being replaced (overrides brief.baseline)
  --target <which>      next | baseline | both (default: both when a baseline is set)
  --out-dir <dir>       Output directory (default: ./screenshots/<topic>/)
  --config <file>       Per-run settings (base URL, project, workstream, page, Chrome profile and
                        debugging port, Figma and docs settings). Fills {{placeholders}} in the brief
                        and is validated before any browser opens. See examples/config.example.json.
  --set key=value       Override one config value (dotted keys, for example chrome.cdpPort=9333)
  --dry-run             Validate and print the resolved shots, then exit. Opens no browser.
  --allow-tracked-output  Allow --out-dir inside a git repository where it is not git-ignored (not recommended).
  --connect <url>       Attach to a Chrome you started with --remote-debugging-port and signed in to
                        (http://127.0.0.1:<port>; defaults to the config's chrome.cdpPort). The harness
                        never launches a browser, handles credentials, or stores a session; it opens
                        tabs in yours.
  --only <slugs>        Comma-separated slugs to capture
  --no-login            Skip auth; capture every shot logged out
  --help                Show this help
`);
  process.exit(values.help ? 0 : 1);
}

const fail = msg => { console.error(`FAIL: ${msg}`); process.exit(1); };

const briefPath = resolve(values.brief);
let brief;
try {
  brief = JSON.parse(readFileSync(briefPath, 'utf-8'));
} catch (e) {
  fail(`cannot read brief ${briefPath}: ${e.message}`);
}

// Per-run settings. Everything that differs between people and projects comes from the config.
let params = {};
let cfg = null;
if (values.config) {
  try {
    cfg = applyOverrides(loadConfig(values.config), values.set || []);
  } catch (e) {
    fail(e.message);
  }
  const check = validateConfig(cfg, ['capture']);
  if (check.errors.length) {
    console.error(formatValidation(check));
    process.exit(1);
  }
  for (const w of check.warnings) console.error(`  ! ${w}`);
  params = deriveParams(cfg);
} else if (values.set?.length) {
  fail('--set needs --config');
}

// A shot can list `requires` (all must be set) or `requiresAny` (one must be set), for example
// ["blockType"]. Without the value the shot is skipped and reported, not failed. A brief can hold
// two variants of a slug with different `requires`; only the one the config satisfies survives.
const skipped = [];
if (Array.isArray(brief.shots)) {
  brief.shots = brief.shots.filter(s => {
    const lacking = (s.requires || []).filter(k => !(k in params));
    if (lacking.length) {
      skipped.push({ slug: s.slug, reason: `needs ${lacking.join(', ')}` });
      return false;
    }
    if (s.requiresAny?.length && !s.requiresAny.some(k => k in params)) {
      skipped.push({ slug: s.slug, reason: `needs one of: ${s.requiresAny.join(', ')}` });
      return false;
    }
    return true;
  });
}
// A slug that still runs through another variant isn't skipped.
{
  const running = new Set((brief.shots || []).map(s => s.slug));
  const merged = new Map();
  for (const sk of skipped) {
    if (running.has(sk.slug)) continue;
    const prev = merged.get(sk.slug);
    merged.set(sk.slug, prev ? { slug: sk.slug, reason: `${prev.reason}; or ${sk.reason.replace(/^needs /, '')}` } : sk);
  }
  skipped.splice(0, skipped.length, ...merged.values());
}
{
  const applied = applyParams(brief, params);
  if (applied.unresolved.length) {
    fail(`the brief uses {{${applied.unresolved.join('}}, {{')}}} but no value is set. ${values.config ? 'Add it to the config file.' : 'Pass --config <file> with these values.'}`);
  }
  brief = applied.value;
}
if (!brief.topic || !Array.isArray(brief.shots)) {
  fail('brief must have { topic, shots: [...] }');
}
if (values.config && !values.connect && params.connectUrl) values.connect = params.connectUrl;

const trim = u => (u || '').replace(/\/+$/, '');
const SITE = trim(values.site || brief.site);
const BASELINE = trim(values.baseline || brief.baseline);
if (!SITE) {
  console.error('FAIL: missing site URL. Set brief.site or pass --site <url>.');
  process.exit(1);
}

const target = values.target || (BASELINE ? 'both' : 'next');
if (!['next', 'baseline', 'both'].includes(target)) {
  console.error(`FAIL: --target must be next, baseline, or both (got ${target})`);
  process.exit(1);
}
if (target !== 'next' && !BASELINE) {
  console.error('FAIL: --target baseline/both needs brief.baseline or --baseline <url>.');
  process.exit(1);
}

// Presets: the config's preset first, then any the brief lists. Each adds actions, CSS, and a sign-in mode.
let presets;
try {
  presets = loadPresets([...new Set([...(cfg ? [presetNameOf(cfg)] : []), ...(brief.presets || [])])], briefPath);
} catch (e) {
  fail(e.message);
}
// Sign-in: "chrome" attaches to the dedicated Chrome you signed in to; "form" signs in to a local or test
// site with a password read from the environment; "none" captures public pages.
const signInMode = values['no-login'] ? 'none' : values.connect && !cfg ? 'chrome' : cfg ? signInModeOf(cfg) : brief.auth ? 'form' : presets.signIn.mode;
if (signInMode !== 'chrome') delete values.connect;
const auth = signInMode === 'form' ? brief.auth || (presets.signIn.mode === 'form' ? { login: presets.signIn.login } : null) : null;
if (signInMode === 'form' && !auth) fail('sign-in mode "form" needs a preset with a sign-in form, or "auth" in the brief');
// With a sign-in form every shot is signed in unless it sets loggedOut: true.
if (signInMode === 'form') for (const s of brief.shots) if (s.loggedIn === undefined) s.loggedIn = !s.loggedOut;
const needsAuth = !!auth && brief.shots.some(s => s.loggedIn);

const onlySet = values.only ? new Set(values.only.split(',').map(s => s.trim())) : null;
const shots = onlySet ? brief.shots.filter(s => onlySet.has(s.slug)) : brief.shots;

try {
  for (const spec of shots) compileActions(spec, presets.actions);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
}

if (values['dry-run']) {
  console.log(JSON.stringify({
    topic: brief.topic, site: SITE, preset: presets.names.join(', ') || null, signIn: signInMode, connect: values.connect || null, project: params.projectName || null,
    workstream: params.workstream || null, pagePath: params.pagePath || null,
    shots: shots.map(s => ({ slug: s.slug, url: s.url, steps: s.steps, expect: s.expect, expectAfter: s.expectAfter })),
    skipped,
  }, null, 2));
  process.exit(0);
}

// Capture output (screenshots of a signed-in editor) must not land where git would pick it up.
// An out-dir inside a git work tree is refused unless git already ignores it.
const outProbe = (() => {
  const raw = values['out-dir'] || brief.outDir || join(process.cwd(), 'screenshots', brief.topic);
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
})();
{
  let top = null;
  for (let d = outProbe; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) { top = d; break; }
    if (dirname(d) === d) break;
  }
  if (top && !values['allow-tracked-output']) {
    // Probe a PNG path: the screenshots are what must stay out of git. (capture-report.json is ignored by name
    // everywhere, so probing it passed for any folder.)
    const ignored = spawnSync('git', ['-C', top, 'check-ignore', '-q', '--no-index', join(outProbe, 'shot.png')]).status === 0;
    if (!ignored) {
      fail(`--out-dir ${outProbe} is inside a git repository (${top}) and isn't git-ignored, so screenshots of a signed-in editor could be committed. Use a directory outside the repository, or an ignored path (for example a screenshots/ folder). Pass --allow-tracked-output only if you are sure.`);
    }
  }
}

const rawOutDir = values['out-dir'] || brief.outDir || join(process.cwd(), 'screenshots', brief.topic);
const outDir = isAbsolute(rawOutDir) ? rawOutDir : resolve(process.cwd(), rawOutDir);
mkdirSync(outDir, { recursive: true });
if (target !== 'next') mkdirSync(join(outDir, 'baseline'), { recursive: true });

const chromium = findChromium();
if (!chromium && !values.connect) {
  console.error('FAIL: no Chrome/Chromium found. Set NEXTJS_SCREENSHOTS_CHROMIUM=/path/to/chrome.');
  process.exit(2);
}

const DEFAULT_DPR = 2;
const DEFAULT_VIEWPORT = [1440, 900];

console.log(`Site:     ${SITE}`);
if (BASELINE) console.log(`Baseline: ${BASELINE}`);
console.log(`Target:   ${target}`);
console.log(`Output:   ${outDir}`);
console.log(`Capturing ${shots.length} shot(s)\n`);

function resolveUrl(base, u) {
  u = u || '/';
  if (/^https?:\/\//.test(u)) return u;
  return `${base}${u.startsWith('/') ? '' : '/'}${u}`;
}

// Auth: a cookies file (exported from a logged-in browser) and/or a scripted
// login form. Secrets come from env vars named in the brief, never inline.
async function authenticate(context) {
  if (auth.cookiesFile) {
    const p = isAbsolute(auth.cookiesFile) ? auth.cookiesFile : resolve(dirname(briefPath), auth.cookiesFile);
    const cookies = JSON.parse(readFileSync(p, 'utf-8'));
    const host = new URL(SITE).hostname;
    await context.setCookie(...cookies.map(c => ({ domain: host, path: '/', ...c })));
  }
  if (auth.login) {
    const page = await context.newPage();
    const { url, fields = {}, form, submit, success } = auth.login;
    await page.goto(resolveUrl(SITE, url), { waitUntil: 'networkidle2', timeout: 60000 });
    for (const [selector, envName] of Object.entries(fields)) {
      const value = process.env[envName];
      if (value === undefined) throw new Error(`env var ${envName} (for ${selector}) is not set`);
      await page.waitForSelector(selector, { timeout: 15000 });
      await page.type(selector, value);
    }
    // `form` submits the form element directly. On some WordPress setups a click on the submit button
    // never posts, and the only symptom is the login page coming back with no error.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      form ? page.$eval(form, el => el.submit()) : page.click(submit || 'button[type="submit"]'),
    ]);
    if (success && !page.url().includes(success)) {
      throw new Error(`login failed: expected URL containing "${success}", got ${page.url()}`);
    }
    await page.close();
  }
}

async function settle(page, spec) {
  await page.addStyleTag({ content: STABILIZE_CSS + presets.css }).catch(() => {});
  if (spec.hide?.length) {
    await page.addStyleTag({ content: `${spec.hide.join(', ')} { visibility: hidden !important; }` }).catch(() => {});
  }
  // next/font and other web fonts
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  // next/image lazy-loads below the fold; walk the page so a full-page shot has every image.
  if (spec.fullPage) {
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    }).catch(() => {});
  }
  // A lazy image that isn't rendered (inside a closed menu) or sits below the fold of a viewport-sized
  // shot never loads, so it isn't waited for.
  await page.waitForFunction(
    full => [...document.images].every(img => {
      if (img.complete || img.loading !== 'lazy') return img.complete;
      const r = img.getBoundingClientRect();
      return (r.width === 0 && r.height === 0) || (!full && r.top >= innerHeight);
    }),
    { timeout: 10000 },
    !!spec.fullPage,
  ).catch(() => console.log('    (some images still loading after 10s)'));
}

// Text and URL markers of a Cloudflare browser challenge. The challenge page is served with 403
// (or 200 with cf-mitigated), so a status check alone isn't enough.
const CHALLENGE_TEXT = /performing security verification/i;
// Weaker phrases also appear on ordinary pages, so they only count together with an error status.
const CHALLENGE_TEXT_WEAK = /just a moment\.{0,3}|verify(ing)? you are (a )?human|checking (if the site connection is secure|your browser)/i;

// Returns a failure reason when the response is a bot challenge or an access denial, else null.
// Detect and report only: the harness never tries to get past a challenge.
async function detectBlock(page, res, status, finalUrl) {
  const markers = [];
  if (/[?&]__cf_chl_/.test(finalUrl)) markers.push('__cf_chl URL token');
  const mitigated = res?.headers()['cf-mitigated'];
  if (mitigated) markers.push(`cf-mitigated: ${mitigated}`);
  const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000)).catch(() => '');
  const hit = text.match(CHALLENGE_TEXT) || (status >= 400 ? text.match(CHALLENGE_TEXT_WEAK) : null);
  if (hit) markers.push(`page text "${hit[0]}"`);
  if (markers.length) {
    const e = new Error(`bot challenge, not the real page (HTTP ${status}; ${markers.join('; ')}). Capture from an unchallenged origin; do not bypass it.`);
    e.blocked = 'challenge';
    return e;
  }
  if (status === 403) {
    const e = new Error('HTTP 403: access denied, not a usable screenshot.');
    e.blocked = 'http-403';
    return e;
  }
  return null;
}

// Proves the intended canvas block (not a neighbor) is the selected one:
//   1. the target selector resolves to a canvas block (the element, or its closest ancestor, that carries
//      Puck's data-puck-component id);
//   2. exactly one selection overlay (data-puck-overlay with an "--isSelected" modifier class) exists in
//      the preview frame, and its box matches the target block's box within `tolerance` px;
//   3. the properties panel (`panel`, default "main") names the block's type, read from the id's prefix.
// A neighbor, even one of the same type, fails step 2. If the editor stops marking the overlay this way,
// the check fails closed instead of passing.
async function requireSelectedBlock(page, spec, fail) {
  const { frame: frameSel = '#preview-frame', target, tolerance = 12, panel = 'main' } = spec;
  const frameEl = await page.waitForSelector(frameSel, { timeout: 15000 }).catch(async () => { throw await fail(`expected iframe not found: ${frameSel}`); });
  const scope = await frameEl.contentFrame();
  if (!scope) throw await fail(`${frameSel} has no readable content frame`);
  const probe = await scope.evaluate((sel, tol) => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const hit = [...document.querySelectorAll(sel)].find(vis);
    if (!hit) return { error: `target not found: ${sel}` };
    const block = hit.closest('[data-puck-component]');
    if (!block) return { error: `${sel} is not inside a canvas block (no data-puck-component)` };
    const id = block.getAttribute('data-puck-component');
    const overlays = [...document.querySelectorAll('[data-puck-overlay]')].filter(o => /--isSelected/.test(o.className));
    if (overlays.length !== 1) return { error: `expected exactly one selected block overlay, found ${overlays.length}`, id };
    const a = block.getBoundingClientRect();
    const b = overlays[0].getBoundingClientRect();
    const off = Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
    return { id, off: Math.round(off), ok: off <= tol };
  }, target, tolerance);
  if (probe.error) throw await fail(`block selection not proven: ${probe.error}`);
  if (!probe.ok) throw await fail(`a different block is selected: the selected overlay is ${probe.off}px away from the intended block (${probe.id})`);
  const type = probe.id.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '');
  if (!type || type === probe.id) throw await fail(`block id "${probe.id}" has no type prefix to check in the properties panel`);
  const text = await page.$eval(panel, el => (el.innerText || '').replace(/\s+/g, ' ')).catch(() => '');
  if (!text.toLowerCase().includes(type.toLowerCase())) throw await fail(`the properties panel doesn't name the selected block type "${type}"`);
}

// Fail closed: a shot that lists checks in `expect` (before actions) or `expectAfter` (after
// click/hover) is only saved when all of them pass. Catches sign-in, loading, and public pages.
// An entry is a selector string, or { selector, text?, absent?, frame? }:
//   text    the element's visible text must contain this (for example the workstream name)
//   absent  the element must not be visible (for example a loading spinner)
//   frame   selector of a same-origin iframe; `selector` is then looked up inside it (for example
//           the editor's preview canvas, to confirm the page being edited actually rendered)
// A frame is one iframe selector, or a list of them for nested frames (an Office add-in's panel sits in an
// iframe inside Word's editor iframe). Returns the innermost frame, or throws with the selector that failed.
async function resolveFrame(page, frameSel, timeout = 15000) {
  let scope = page;
  for (const sel of [].concat(frameSel)) {
    const el = await scope.waitForSelector(sel, { timeout }).catch(() => null);
    if (!el) throw new Error(`iframe not found: ${sel}`);
    scope = await el.contentFrame();
    if (!scope) throw new Error(`${sel} has no readable content frame`);
  }
  return scope;
}

async function requireSelectors(page, checks, phase) {
  for (const check of checks || []) {
    const { selector, text, absent, frame: frameSel, selectedBlock } = typeof check === 'string' ? { selector: check } : check;
    const fail = async why => {
      const seen = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100)).catch(() => '');
      const e = new Error(`${phase}: ${why}. This is not the page the shot needs (sign-in, loading, wrong workstream, public page, or missing UI). Page shows: "${seen}"`);
      e.blocked = 'expectation';
      return e;
    };
    if (selectedBlock) {
      await requireSelectedBlock(page, selectedBlock, fail);
      continue;
    }
    let scope = page;
    if (frameSel) scope = await resolveFrame(page, frameSel).catch(async e => { throw await fail(`expected ${e.message}`); });
    if (absent) {
      await scope.waitForSelector(selector, { hidden: true, timeout: 30000 }).catch(async () => { throw await fail(`${selector} is still visible`); });
      continue;
    }
    await scope.waitForSelector(selector, { timeout: 30000 }).catch(async () => { throw await fail(`expected element not found: ${selector}${frameSel ? ` (in ${frameSel})` : ''}`); });
    if (text) {
      const seen = await scope.$eval(selector, el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim());
      if (!seen.toLowerCase().includes(text.toLowerCase())) throw await fail(`${selector} shows "${seen.slice(0, 60)}", expected text containing "${text}"`);
    }
  }
}

// Named actions. A brief lists `presets` (files in scripts/presets/ or paths relative to the brief)
// and each shot lists `actions`: "name", or { name: { param: value } }. An action expands into the
// steps and checks its preset defines, with {param} replaced. Raw `steps` still work and run after
// the actions. Everything is resolved before a browser opens, so a typo fails immediately.
function loadPresets(names, briefFile) {
  const out = { names: [], actions: {}, css: '', signIn: { mode: 'none' } };
  for (const n of names) {
    const p = loadPreset(n, dirname(briefFile));
    out.names.push(p.name);
    Object.assign(out.actions, p.actions);
    if (p.css) out.css += `\n${p.css}`;
    if (out.signIn.mode === 'none') out.signIn = p.signIn;
  }
  return out;
}

function compileActions(spec, presets) {
  const steps = [], expect = [], expectAfter = [];
  const substitute = (v, params) => {
    if (typeof v === 'string') return v.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    if (Array.isArray(v)) return v.map(x => substitute(x, params));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, params)]));
    return v;
  };
  for (const item of spec.actions || []) {
    const [name, params = {}] = typeof item === 'string' ? [item, {}] : Object.entries(item)[0] || [];
    const def = presets[name];
    if (!def) throw new Error(`shot "${spec.slug}": unknown action "${name}". Known actions: ${Object.keys(presets).join(', ') || '(no presets loaded; add "presets" to the brief)'}`);
    const missing = (def.params || []).filter(p => params[p] === undefined);
    if (missing.length) throw new Error(`shot "${spec.slug}": action "${name}" needs ${missing.join(', ')}`);
    const out = substitute({ steps: def.steps || [], expect: def.expect || [], expectAfter: def.expectAfter || [] }, params);
    if (JSON.stringify(out).match(/\{\w+\}/)) throw new Error(`shot "${spec.slug}": action "${name}" has an unresolved parameter`);
    steps.push(...out.steps); expect.push(...out.expect); expectAfter.push(...out.expectAfter);
  }
  spec.steps = [...steps, ...(spec.steps || [])];
  spec.expect = [...(spec.expect || []), ...expect];
  spec.expectAfter = [...(spec.expectAfter || []), ...expectAfter];
}

// Interaction steps for a shot, run after the page settles and `expect` passes. Each step is one of:
//   { click: selector, text?, frame?, offset?, skipIf? }   (frame: an iframe selector, or a list for nested iframes)
//       click the first visible match whose text contains `text`. `frame` is a same-origin iframe
//       selector to look inside. `offset` {x, y} clicks that far from the element's top-left.
//       `skipIf` is a selector: when the matched element matches it, the click is skipped
//       (so "expand" can't collapse something already open).
//   { scroll: selector, frame? }   scroll the match to the center of its scroll container
//   { wait: selector | ms, frame? } wait for a selector to be visible, or pause
//   { key: "Escape" }              press a key
//   { moveMouse: {x, y} }          move the pointer (clears hover tooltips)
//   { bringToFront: true }         bring this tab in front (takes the screen while the shot runs)
//   { check: selector | { selector, text?, notText? }, frame?, timeout? }  wait until it's visible, contains
//       text, and (with notText) no longer shows that text
// A click can add `opensWindow: "<text in the new window's URL>"`: the click opens a window (an add-on's
// popup, for example), and the rest of the shot (later steps, expectAfter, the screenshot) uses that window.
// It's closed after the shot.
// Add `optional: true` to a click or scroll to skip it quietly when the target isn't there.
// A target that isn't there fails the shot instead of skipping the step.
async function runSteps(page, steps, opened = []) {
  for (const step of steps || []) {
    const target = step.click || step.scroll || (typeof step.wait === 'string' ? step.wait : null);
    let scope = page;
    if (step.frame) scope = await resolveFrame(page, step.frame).catch(async e => { throw await stepFail(page, e.message); });
    if (step.click || step.scroll) {
      // With `text`, wait for any visible match that contains it: the first match of a broad selector can be a
      // hidden element (a Back button on the first screen), and waiting for that one would time out.
      const until = step.text
        ? scope.waitForFunction((sel, text) => [...document.querySelectorAll(sel)].some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (e.innerText || e.textContent || '').toLowerCase().includes(text.toLowerCase()); }), { timeout: step.optional ? 2000 : 15000 }, target, step.text)
        : scope.waitForSelector(target, { visible: true, timeout: step.optional ? 2000 : 15000 });
      const found = await until.catch(async () => { if (step.optional) return null; throw await stepFail(page, `target not found: ${target}${step.text ? ` containing "${step.text}"` : ''}${step.frame ? ` (in ${step.frame})` : ''}`); });
      if (!found) continue;
      // Text is matched case-insensitively against the rendered text (CSS can uppercase labels).
      const handle = await scope.evaluateHandle((sel, text) => {
        const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        return [...document.querySelectorAll(sel)].find(e => vis(e) && (!text || (e.innerText || e.textContent || '').toLowerCase().includes(text.toLowerCase())));
      }, target, step.text || '');
      const el = handle.asElement();
      if (!el) {
        if (step.optional) continue;
        throw await stepFail(page, `no visible ${target}${step.text ? ` containing "${step.text}"` : ''}`);
      }
      if (step.scroll) {
        await el.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'nearest' }));
      } else if (step.skipIf && await el.evaluate((e, sel) => e.matches(sel), step.skipIf)) {
        continue;
      } else {
        // The canvas can still be smooth-scrolling after a scroll step; clicking a moving target
        // selects the neighbor. Wait (up to 3s) until its position is unchanged across reads.
        await el.evaluate(async e => {
          let prev = '';
          for (let i = 0; i < 30; i++) {
            const r = e.getBoundingClientRect();
            const cur = `${Math.round(r.top)}|${Math.round(r.left)}`;
            if (cur === prev) return;
            prev = cur;
            await new Promise(res => setTimeout(res, 100));
          }
        });
        const known = step.opensWindow ? new Set(page.browser().targets()) : null;
        const win = step.opensWindow ? page.browser().waitForTarget(t => t.type() === 'page' && !known.has(t) && t.url().includes(step.opensWindow), { timeout: 30000 }) : null;
        await el.click(step.offset ? { offset: step.offset } : {});
        if (win) {
          const target = await win.catch(async () => { throw await stepFail(page, `no window with "${step.opensWindow}" in its URL opened`); });
          const next = await target.page();
          opened.push(next);
          await next.setViewport(page.viewport());
          await next.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }).catch(() => {});
          page = next;
          await settle(page, {});
        }
      }
    } else if (step.bringToFront) {
      // Some add-ins only open their windows from a tab that's in front (a background tab's click opens nothing).
      // This takes the screen while the shot runs.
      await page.bringToFront();
      await new Promise(r => setTimeout(r, 1500));
    } else if (step.check) {
      // A check partway through the steps: wait (up to `timeout` ms, default 20000) until the selector is
      // visible and, with `text`, contains it. For screens that load after a click, such as an add-on panel.
      // `notText` waits until no match contains that text (a "Checking…" message that clears on its own).
      const { selector, text, notText } = typeof step.check === 'string' ? { selector: step.check } : step.check;
      await scope.waitForFunction((sel, t, nt) => {
        const els = [...document.querySelectorAll(sel)].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        const has = e => (e.innerText || e.textContent || '').toLowerCase();
        return els.some(e => !t || has(e).includes(t.toLowerCase())) && (!nt || !els.some(e => has(e).includes(nt.toLowerCase())));
      }, { timeout: step.timeout || 20000 }, selector, text || '', notText || '')
        .catch(async () => { throw await stepFail(page, `check: ${selector}${text ? ` with "${text}"` : ''}${notText ? ` without "${notText}"` : ''} not met${step.frame ? ` (in ${step.frame})` : ''}`); });
    } else if (typeof step.wait === 'number') {
      await new Promise(r => setTimeout(r, step.wait));
    } else if (step.wait) {
      await scope.waitForSelector(step.wait, { visible: true, timeout: 15000 }).catch(async () => { throw await stepFail(page, `wait target not found: ${step.wait}`); });
    } else if (step.key) {
      await page.keyboard.press(step.key);
    } else if (step.moveMouse) {
      await page.mouse.move(step.moveMouse.x, step.moveMouse.y);
    }
  }
  return page;
}

async function stepFail(page, why) {
  const seen = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100)).catch(() => '');
  const e = new Error(`steps: ${why}. Page shows: "${seen}"`);
  e.blocked = 'expectation';
  return e;
}

async function captureOne(page, spec, base, file) {
  const vw = spec.viewport || DEFAULT_VIEWPORT;
  const dpr = spec.dpr ?? brief.dpr ?? DEFAULT_DPR;
  await page.setViewport({ width: vw[0], height: vw[1], deviceScaleFactor: dpr, isMobile: vw[0] < 768, hasTouch: vw[0] < 768 });
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-color-scheme', value: spec.colorScheme || brief.colorScheme || 'light' },
  ]);

  const url = base === SITE ? resolveUrl(SITE, spec.url) : resolveUrl(BASELINE, spec.baselineUrl || spec.url);
  const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  const status = res ? res.status() : null;
  // The pointer keeps its last position across tabs and runs, and a leftover hover style would make two
  // identical captures differ. Start every shot just off the page: (1, 1) is inside the WordPress logo's
  // hover menu, so any on-page corner can open something.
  await page.mouse.move(-1, -1);
  const finalUrl = page.url();
  const devMode = await page.evaluate(() => !!document.querySelector('nextjs-portal')).catch(() => false);

  const blocked = await detectBlock(page, res, status, finalUrl);
  if (blocked) throw blocked;

  await settle(page, spec);
  await requireSelectors(page, spec.expect, 'expect');
  const opened = [];
  try {
    page = await runSteps(page, spec.steps, opened);
    return await finishShot(page, spec, file, { url, finalUrl, status, devMode, dpr });
  } finally {
    for (const w of opened) await w.close().catch(() => {});
  }
}

// The rest of a shot, on the page the steps ended on (a window a step opened, or the original page).
async function finishShot(page, spec, file, info) {
  if (spec.scrollTo) {
    await page.evaluate(sel => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), spec.scrollTo).catch(() => {});
  }
  if (spec.evaluateBefore) {
    await page.evaluate(spec.evaluateBefore).catch(e => console.log(`    evaluateBefore warned: ${e.message}`));
  }
  if (spec.click) await page.click(spec.click).catch(() => {});
  if (spec.hover) await page.hover(spec.hover).catch(() => {});

  const delay = spec.delay ?? 800;
  if (delay > 0) await new Promise(r => setTimeout(r, delay));
  await requireSelectors(page, spec.expectAfter, 'expectAfter');

  await page.screenshot({ path: file, type: 'png', fullPage: !!spec.fullPage });
  return info;
}

async function main() {
  const browser = values.connect ? await puppeteer.connect({ browserURL: values.connect, defaultViewport: null }) : await puppeteer.launch({
    executablePath: chromium,
    headless: true,
    // We open our own contexts and pages below. Waiting for Chrome's initial page target
    // times out at 30s on recent headless Chrome, before any shot starts.
    waitForInitialPage: false,
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors', '--disable-dev-shm-usage'],
  });

  // --connect: use the attached browser's own profile, so its login applies to every tab we open.
  const anonContext = values.connect ? browser.defaultBrowserContext() : await browser.createBrowserContext();
  const anonPage = await anonContext.newPage();

  let authPage = null;
  if (values.connect) {
    authPage = anonPage;
  } else if (needsAuth && target !== 'baseline') {
    const authContext = await browser.createBrowserContext();
    console.log('Authenticating...');
    try {
      await authenticate(authContext);
    } catch (e) {
      console.error(`FAIL: ${e.message}`);
      await browser.close();
      process.exit(1);
    }
    authPage = await authContext.newPage();
  }
  for (const p of new Set([anonPage, authPage].filter(Boolean))) p.on('dialog', d => d.dismiss().catch(() => {}));

  const jobs = [];
  for (const spec of shots) {
    if (target !== 'baseline') jobs.push({ spec, base: SITE, side: 'next', file: join(outDir, `${spec.slug}.png`) });
    // Baseline shots are always anonymous: the WordPress site's login is out of scope for parity.
    if (target !== 'next' && spec.compare !== false) jobs.push({ spec, base: BASELINE, side: 'baseline', file: join(outDir, 'baseline', `${spec.slug}.png`) });
  }

  // Inventory-driven shots carry their identity, caption, and alt text into the report unchanged.
  const ident = s => ({ ...(s.screenshotId && { screenshotId: s.screenshotId }), ...(s.release && { release: s.release }), ...(s.caption !== undefined && { caption: s.caption }), ...(s.altText !== undefined && { altText: s.altText }) });
  const results = [];
  let warnedDev = false;
  for (const { spec, base, side, file } of jobs) {
    if (!spec.slug || !spec.url) {
      results.push({ slug: spec.slug || '?', side, ...ident(spec), ok: false, error: 'missing slug or url' });
      continue;
    }
    process.stdout.write(`  ${(side === 'baseline' ? '[baseline] ' : '') + spec.slug}`.padEnd(48));
    try {
      if (spec.loggedIn && side === 'next' && !authPage) throw new Error('shot needs loggedIn but brief has no auth (or --no-login was passed)');
      const page = spec.loggedIn && side === 'next' ? authPage : anonPage;
      const info = await captureOne(page, spec, base, file);
      const path = u => new URL(u).pathname.replace(/\/+$/, '') || '/';
      const moved = path(info.finalUrl) !== path(info.url);
      // A logged-in shot that lands elsewhere is almost always an expired session bounced to /login.
      if (moved && spec.loggedIn && side === 'next') throw new Error(`loggedIn shot landed on ${info.finalUrl}; session missing or expired`);
      const flag = (info.status >= 400 ? `  HTTP ${info.status}` : '') + (moved ? `  -> ${path(info.finalUrl)}` : '');
      console.log(`OK${flag}`);
      if (info.devMode && !warnedDev) {
        console.log('    WARN: Next.js dev overlay detected. Capture against `next build && next start` for final shots.');
        warnedDev = true;
      }
      results.push({ slug: spec.slug, side, ...ident(spec), ok: true, file, ...info });
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
      results.push({ slug: spec.slug, side, ...ident(spec), ok: false, error: e.message, ...(e.blocked && { blocked: e.blocked }) });
    }
  }

  if (values.connect) {
    await anonPage.close().catch(() => {});
    await browser.disconnect();
  } else {
    await browser.close();
  }

  writeFileSync(join(outDir, 'capture-report.json'), JSON.stringify({
    topic: brief.topic, site: SITE, baseline: BASELINE || null, target, preset: presets.names.join(', ') || null, signIn: signInMode,
    projectName: params.projectName || null, workstream: params.workstream || null, pagePath: params.pagePath || null,
    skipped,
    ...(brief.inventory && { inventory: brief.inventory }),
    capturedAt: new Date().toISOString(), results,
  }, null, 2));

  const ok = results.filter(r => r.ok).length;
  const httpErrors = results.filter(r => r.ok && r.status >= 400);
  console.log(`\nDone: ${ok}/${results.length} captured, ${results.length - ok} failed, ${httpErrors.length} with HTTP >= 400`);
  for (const r of httpErrors) console.log(`  HTTP ${r.status}  [${r.side}] ${r.slug}  ${r.url}`);
  for (const r of results.filter(r => !r.ok)) console.log(`  FAIL [${r.side}] ${r.slug}: ${r.error}`);
  console.log(`Report: ${join(outDir, 'capture-report.json')}`);
  if (ok < results.length) process.exit(1);
}

main().catch(e => { console.error('FAIL:', e); process.exit(2); });
