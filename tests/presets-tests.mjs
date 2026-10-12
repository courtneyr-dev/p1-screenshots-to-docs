#!/usr/bin/env node
/**
 * Tests for target presets (scripts/presets/), preset-driven configuration, the starter briefs, and the
 * release-check sources. No browser opens and no network is used: capture runs with --dry-run, and the
 * release sources are fed saved responses. Prints PASS/FAIL lines in the format tests/run-tests.sh counts.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { listPresets, loadPreset, withDefaults, signInEnvVars } from '../scripts/lib/presets.mjs';
import { validateConfig, deriveParams, targetParams, signInModeOf } from '../scripts/lib/config.mjs';
import { parseSource, sourceUrl, versionFrom, latestVersion } from '../scripts/lib/release-sources.mjs';
import { pickWindow, mergeReport, parseSize } from '../scripts/capture-window.mjs';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'presets-test-')));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
const PROFILE = join(TMP, 'profile');
mkdirSync(PROFILE);

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`FAIL  ${name}`); console.log('        ' + String(e.message || e).split('\n').slice(0, 8).join('\n        ')); failed += 1; }
};
const keys = r => r.errors.map(e => e.key);

// ---------- presets ----------
await test('every built-in preset loads, names a valid sign-in mode, and has a starter brief that uses it', () => {
  const names = listPresets();
  for (const n of ['p1-editor', 'wordpress-admin', 'drupal-admin', 'public-site', 'content-publisher', 'pantheon-dashboard', 'gdocs-addon', 'word-addin']) assert.ok(names.includes(n), `missing preset ${n}`);
  for (const n of names) {
    const p = loadPreset(n);
    assert.ok(p.description.length > 40, `${n} needs a description`);
    const brief = JSON.parse(readFileSync(join(ROOT, 'briefs', `${n}.json`), 'utf-8'));
    assert.deepEqual(brief.presets, [n]);
    for (const s of brief.shots) for (const a of s.actions || []) {
      const name = typeof a === 'string' ? a : Object.keys(a)[0];
      assert.ok(p.actions[name], `${n}: brief shot ${s.slug} uses unknown action ${name}`);
    }
  }
});

await test('every brief in briefs/ names only presets and actions that exist', () => {
  for (const file of readdirSync(join(ROOT, 'briefs')).filter(f => f.endsWith('.json'))) {
    const brief = JSON.parse(readFileSync(join(ROOT, 'briefs', file), 'utf-8'));
    const actions = Object.assign({}, ...(brief.presets || []).map(n => loadPreset(n).actions));
    for (const s of brief.shots) for (const a of s.actions || []) {
      const name = typeof a === 'string' ? a : Object.keys(a)[0];
      assert.ok(actions[name], `${file}: shot ${s.slug} uses unknown action ${name}`);
    }
  }
});

await test('no brief tells an action to click Publish, Save, Disconnect, or Delete', () => {
  for (const file of readdirSync(join(ROOT, 'briefs')).filter(f => f.endsWith('.json'))) {
    const brief = JSON.parse(readFileSync(join(ROOT, 'briefs', file), 'utf-8'));
    for (const s of brief.shots) for (const a of s.actions || []) {
      if (typeof a === 'string') continue;
      for (const v of Object.values(Object.values(a)[0])) assert.doesNotMatch(String(v).trim(), /^(publish|save|disconnect|delete|remove)( collection| site)?$/i, `${file}: ${s.slug}`);
    }
  }
});

await test('no preset step clicks anything destructive, and form sign-in reads only environment variables', () => {
  for (const n of listPresets()) {
    const p = loadPreset(n);
    for (const [a, d] of Object.entries(p.actions)) for (const s of d.steps || []) assert.doesNotMatch(JSON.stringify(s).toLowerCase(), /delete|remove|archive|discard|publish now|uninstall/, `${n}.${a}`);
    for (const v of signInEnvVars(p.signIn)) assert.match(v, /^[A-Z][A-Z0-9_]*$/, `${n}: ${v} is not an environment variable name`);
  }
});

await test('preset defaults fill in, and a default can name another value', () => {
  const p = loadPreset('p1-editor');
  const v = withDefaults(p, { pagePath: '/about' });
  assert.equal(v.pageLabel, '/about'); assert.equal(v.editorRoute, '/p1'); assert.equal(v.blockCategory, 'P1 Layout');
  assert.equal(withDefaults(p, { pagePath: '/a', pageLabel: 'About' }).pageLabel, 'About');
});

await test('an unknown preset is refused with the list of built-in presets', () => {
  assert.throws(() => loadPreset('joomla-admin'), /not found\. Built-in presets: .*wordpress-admin/);
  const r = validateConfig({ topic: 'x', preset: 'joomla-admin', baseUrl: 'http://localhost:1' });
  assert.ok(keys(r).includes('preset'));
});

// ---------- configuration ----------
const p1Legacy = () => ({ topic: 'qa', baseUrl: 'http://localhost:3000', projectName: 'QA', workstream: 'main', pagePath: '/', blockType: 'Hero', chrome: { profileDir: PROFILE, cdpPort: 9555 } });

await test('a config written before presets still works: no preset means p1-editor, top-level P1 values are read', () => {
  const r = validateConfig(p1Legacy());
  assert.deepEqual(r.errors, []);
  const d = deriveParams(p1Legacy());
  assert.equal(d.preset, 'p1-editor'); assert.equal(d.projectName, 'QA'); assert.equal(d.editorUrl, '/p1'); assert.equal(d.connectUrl, 'http://127.0.0.1:9555');
});

await test('the same P1 values work under "params", and the P1 rules come from the preset', () => {
  const cfg = { topic: 'qa', preset: 'p1-editor', baseUrl: 'http://localhost:3000', params: { projectName: 'QA', workstream: 'main', pagePath: '/about', blockType: 'Hero', blockSelector: '.x' }, chrome: { profileDir: PROFILE, cdpPort: 9555 } };
  const r = validateConfig(cfg);
  assert.ok(keys(r).includes('params.blockType'), JSON.stringify(r.errors));
  delete cfg.params.blockSelector; cfg.params.pagePath = 'about';
  assert.ok(keys(validateConfig(cfg)).includes('params.pagePath'));
  cfg.params.pagePath = '/about';
  assert.deepEqual(validateConfig(cfg).errors, []);
  assert.equal(deriveParams(cfg).editorUrl, '/p1/about');
  delete cfg.params.workstream;
  assert.ok(keys(validateConfig(cfg)).includes('params.workstream'));
});

await test('a WordPress config needs no Chrome profile, and reports missing sign-in variables without reading a value', () => {
  const cfg = { topic: 'wp', preset: 'wordpress-admin', baseUrl: 'http://localhost:8881' };
  const saved = { u: process.env.WP_USER, p: process.env.WP_PASSWORD };
  delete process.env.WP_USER; delete process.env.WP_PASSWORD;
  try {
    const r = validateConfig(cfg);
    assert.equal(r.errors.filter(e => e.key === 'signIn').length, 2);
    assert.ok(!keys(r).some(k => k.startsWith('chrome')));
    process.env.WP_USER = 'u'; process.env.WP_PASSWORD = 'p';
    assert.deepEqual(validateConfig(cfg).errors, []);
    assert.equal(signInModeOf(cfg), 'form');
    assert.equal(deriveParams(cfg).connectUrl, undefined);
  } finally {
    for (const [k, v] of [['WP_USER', saved.u], ['WP_PASSWORD', saved.p]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

await test('signIn "chrome" switches any preset to the dedicated Chrome, and needs its profile and port', () => {
  const cfg = { topic: 'wp', preset: 'wordpress-admin', baseUrl: 'https://example.com', signIn: 'chrome' };
  assert.ok(keys(validateConfig(cfg)).includes('chrome.profileDir'));
  cfg.chrome = { profileDir: PROFILE, cdpPort: 9444 };
  assert.deepEqual(validateConfig(cfg).errors, []);
  assert.equal(deriveParams(cfg).connectUrl, 'http://127.0.0.1:9444');
  assert.ok(keys(validateConfig({ ...cfg, signIn: 'magic' })).includes('signIn'));
  assert.ok(keys(validateConfig({ topic: 'p', preset: 'public-site', baseUrl: 'https://example.com', signIn: 'form' })).includes('signIn'));
});

await test('P1 values on another preset, and params a preset does not know, are refused', () => {
  const r = validateConfig({ topic: 'd', preset: 'public-site', baseUrl: 'https://example.com', workstream: 'main', params: { color: 'red' } });
  assert.ok(keys(r).includes('workstream')); assert.ok(keys(r).includes('params.color'));
});

await test('a secret-looking key is still refused anywhere, including under params', () => {
  const r = validateConfig({ topic: 'w', preset: 'public-site', baseUrl: 'https://example.com', params: { apiToken: 'x' } });
  assert.ok(r.errors.some(e => e.key === 'params.apiToken' && /credential/.test(e.message)));
});

await test('targetParams merges top-level P1 values, params, and defaults', () => {
  const v = targetParams({ preset: 'p1-editor', projectName: 'A', params: { workstream: 'w', pagePath: '/x' } });
  assert.equal(v.projectName, 'A'); assert.equal(v.workstream, 'w'); assert.equal(v.pageLabel, '/x');
});

// ---------- starter briefs: dry run, no browser ----------
for (const [preset, extra, env] of [
  ['wordpress-admin', {}, { WP_USER: 'u', WP_PASSWORD: 'p' }],
  ['drupal-admin', {}, { DRUPAL_USER: 'u', DRUPAL_PASSWORD: 'p' }],
  ['public-site', {}, {}],
  ['content-publisher', { chrome: { profileDir: PROFILE, cdpPort: 9447 } }, {}],
  ['pantheon-dashboard', { chrome: { profileDir: PROFILE, cdpPort: 9448 } }, {}],
  ['gdocs-addon', { chrome: { profileDir: PROFILE, cdpPort: 9449 } }, {}],
  ['word-addin', { chrome: { profileDir: PROFILE, cdpPort: 9450 } }, {}],
]) {
  await test(`the ${preset} starter brief compiles with its preset (dry run)`, () => {
    const cfgFile = join(TMP, `${preset}.json`);
    const base = loadPreset(preset).params;
    const params = Object.fromEntries(Object.entries(base).filter(([, s]) => s.required).map(([k, s]) => [k, ['qa', randomUUID(), 'qaTestDocument0123456789abcdef', 'https://example.com/doc.docx'].find(v => !s.pattern || new RegExp(s.pattern).test(v))]));
    writeFileSync(cfgFile, JSON.stringify({ topic: `qa-${preset}`, preset, baseUrl: 'http://localhost:9', ...(Object.keys(params).length && { params }), ...extra }));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/capture.mjs'), '--config', cfgFile, '--brief', join(ROOT, 'briefs', `${preset}.json`), '--dry-run'], { encoding: 'utf-8', env: { ...process.env, ...env } });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = JSON.parse(r.stdout);
    assert.ok(out.shots.length > 0);
    assert.equal(out.preset, preset);
    assert.equal(out.signIn, signInModeOf({ preset, ...extra }));
    assert.doesNotMatch(r.stdout, /"p"|password/i);
  });
}

await test('capture refuses an output folder that git tracks, even when capture-report.json is ignored by name', () => {
  const repo = join(TMP, 'tracked-repo');
  mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, '.gitignore'), 'capture-report.json\n');
  const cfg = join(TMP, 'tracked-public.json');
  writeFileSync(cfg, JSON.stringify({ topic: 'qa-tracked', preset: 'public-site', baseUrl: 'http://localhost:9' }));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/capture.mjs'), '--config', cfg, '--brief', join(ROOT, 'briefs/public-site.json'), '--out-dir', join(repo, 'shots')], { encoding: 'utf-8' });
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /isn't git-ignored/);
});

// ---------- desktop windows ----------
await test('capture-window picks exactly one window, skips thumbnails, and says why when it cannot', () => {
  const wins = [{ id: 1, app: 'Claude', title: 'Claude', w: 1495, h: 1073 }, { id: 2, app: 'Claude', title: 'App Icon', w: 64, h: 64 }, { id: 3, app: 'Cursor', title: 'a.md — repo', w: 1400, h: 900 }, { id: 4, app: 'Cursor', title: 'b.md — repo', w: 1400, h: 900 }];
  assert.equal(pickWindow(wins, { app: 'claude' }).window.id, 1);
  assert.match(pickWindow(wins, { app: 'Cursor' }).error, /2 windows.*--title/);
  assert.equal(pickWindow(wins, { app: 'Cursor', title: 'b.md' }).window.id, 4);
  assert.match(pickWindow(wins, { app: 'Cursor', title: 'zzz' }).error, /no window whose title contains/);
  assert.match(pickWindow(wins, { app: 'Word' }).error, /no window on screen for "Word".*Claude, Cursor/);
});

await test('capture-window writes the same report format as capture.mjs, replacing a re-captured slug', () => {
  const a = mergeReport(null, { topic: 't', app: 'Claude', slug: 'reply', file: '/x/reply.png', dpr: 2, capturedAt: '2026-10-12T00:00:00Z' });
  assert.equal(a.results[0].url, 'app://Claude/'); assert.equal(a.results[0].side, 'next'); assert.equal(a.results[0].ok, true);
  assert.equal(new URL(a.results[0].finalUrl).pathname, '/');
  const b = mergeReport(a, { topic: 't', app: 'Claude', slug: 'reply', file: '/x/reply.png', dpr: 2, capturedAt: '2026-10-12T00:01:00Z' });
  assert.equal(b.results.length, 1);
  assert.deepEqual(parseSize('1440x900'), { w: 1440, h: 900 }); assert.equal(parseSize('big'), null);
});

// ---------- release sources ----------
await test('release sources parse, and anything else is refused', () => {
  assert.deepEqual(parseSource('npm:@pantheon-systems/p1-next-sdk'), { kind: 'npm', name: '@pantheon-systems/p1-next-sdk' });
  assert.deepEqual(parseSource('github:ddev/ddev'), { kind: 'github', repo: 'ddev/ddev' });
  assert.deepEqual(parseSource('wordpress'), { kind: 'wordpress' });
  assert.equal(sourceUrl(parseSource('drupal')), 'https://updates.drupal.org/release-history/drupal/current');
  assert.equal(parseSource('page:https://example.com/about').url, 'https://example.com/about');
  for (const bad of ['', 'npm:', 'github:ddev', 'page:ftp://x', 'page:https://u:p@example.com/', 'pypi:requests', 'joomla']) assert.throws(() => parseSource(bad));
  assert.equal(sourceUrl(parseSource('npm:@a/b')), 'https://registry.npmjs.org/@a%2Fb/latest');
});

await test('each source reads its version from a saved response', () => {
  assert.equal(versionFrom({ kind: 'npm' }, '{"version":"0.20.0"}'), '0.20.0');
  assert.equal(versionFrom({ kind: 'github' }, '{"tag_name":"v1.25.4"}'), '1.25.4');
  assert.equal(versionFrom({ kind: 'wordpress' }, '{"offers":[{"response":"upgrade","current":"7.1.3"},{"response":"autoupdate","current":"7.1.3"}]}'), '7.1.3');
  const drupal = ['12.0.0-beta1', '11.4.8', '11.10.0', '11.4.10', '10.5.3'].map(v => `<release><version>${v}</version></release>`).join('');
  assert.equal(versionFrom({ kind: 'drupal', project: 'drupal' }, `<project><releases>${drupal}</releases></project>`), '11.10.0');
  assert.equal(versionFrom({ kind: 'page', url: 'https://example.com' }, '<footer>Version 3.2.1</footer>', { pattern: 'Version (\\d+\\.\\d+\\.\\d+)' }), '3.2.1');
  assert.throws(() => versionFrom({ kind: 'page', url: 'https://example.com' }, 'x'), /--pattern/);
  assert.throws(() => versionFrom({ kind: 'page', url: 'https://example.com' }, 'nothing', { pattern: 'v(\\d+)' }), /found no version/);
  assert.throws(() => versionFrom({ kind: 'npm' }, '<html>'), /JSON/);
});

await test('latestVersion makes one GET to the source URL and reports HTTP errors', async () => {
  const seen = [];
  const fake = status => async (url, opts) => { seen.push([url, opts.headers.accept]); return { ok: status === 200, status, text: async () => '{"tag_name":"v2.0.0"}' }; };
  assert.equal(await latestVersion('github:o/r', { fetchImpl: fake(200) }), '2.0.0');
  assert.deepEqual(seen[0], ['https://api.github.com/repos/o/r/releases/latest', 'application/json']);
  await assert.rejects(latestVersion('github:o/r', { fetchImpl: fake(404) }), /HTTP 404/);
});

await test('release-check uses the config\'s preset source when no source is given', () => {
  const inv = join(TMP, 'inv.json');
  writeFileSync(inv, readFileSync(join(ROOT, 'tests/fixtures/inventory/inventory.valid.json')));
  const cfg = join(TMP, 'wp-release.json');
  writeFileSync(cfg, JSON.stringify({ topic: 'wp', preset: 'wordpress-admin', baseUrl: 'http://localhost:1' }));
  // --app needs an npm source; WordPress's is "wordpress", so the message names the source it found.
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/inventory.mjs'), 'release-check', '--inventory', inv, '--config', cfg, '--app', TMP], { encoding: 'utf-8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /the source is wordpress/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
