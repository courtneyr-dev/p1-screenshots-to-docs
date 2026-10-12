#!/usr/bin/env node
/**
 * Tests for symlink-safe path containment (scripts/lib/paths.mjs) and the places that use it: the
 * docs handoff directory and the Chrome profile directory. Needs only Node. Prints PASS/FAIL lines
 * in the format tests/run-tests.sh counts. Symlink tests are skipped, and the skip is printed, only
 * when the operating system can't create symlinks.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalPath, isInside } from '../scripts/lib/paths.mjs';
import { validateConfig, TOOL_DIR } from '../scripts/lib/config.mjs';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'paths-test-')));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

let passed = 0, failed = 0, skipped = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`FAIL  ${name}`); console.log('        ' + String(e.message || e).split('\n').slice(0, 6).join('\n        ')); failed += 1; }
};

let symlinks = true;
try { symlinkSync(TMP, join(TMP, 'probe-link')); } catch { symlinks = false; }
const linkTest = (name, fn) => {
  if (symlinks) return test(name, fn);
  console.log(`SKIP  ${name} (this system can't create symlinks)`); skipped += 1;
};

const cfgFor = handoffDir => ({
  topic: 't', baseUrl: 'http://localhost:3000', projectName: 'P', workstream: 'w', pagePath: '/',
  chrome: { profileDir: join(TMP, 'profile'), cdpPort: 9555 },
  figma: { fileKey: 'AbAbAbAbAbAbAbAbAbAbAb' }, docs: { handoffDir, format: 'markdown' },
});
const handoffErrors = dir => validateConfig(cfgFor(dir), ['handoff']).errors.filter(e => e.key === 'docs.handoffDir');
const entries = d => readdirSync(d).sort();
const cli = (cfg, extraArgs = []) => {
  const cfgFile = join(TMP, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const run = join(TMP, 'run'); mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'capture-report.json'), '{}'); writeFileSync(join(run, 'figma-plan.json'), '{}');
  return spawnSync('node', [join(ROOT, 'scripts', 'handoff.mjs'), '--config', cfgFile, '--dir', run, '--release', 'x', '--skip-annotation', 'test-fixture', ...extraArgs], { encoding: 'utf-8', cwd: TMP });
};

console.log('== paths: canonical resolution and containment');
test('isInside compares whole segments: /tool contains /tool/a and itself, never /tool-other', () => {
  assert.equal(isInside('/x/tool', '/x/tool'), true);
  assert.equal(isInside('/x/tool/a/b', '/x/tool'), true);
  assert.equal(isInside('/x/tool-other', '/x/tool'), false);
  assert.equal(isInside('/x/tool-other/a', '/x/tool'), false);
  assert.equal(isInside('/x', '/x/tool'), false);
  assert.equal(isInside('/y/tool', '/x/tool'), false);
});
test('canonicalPath returns the real path of an existing directory, and appends missing segments for a new one', () => {
  mkdirSync(join(TMP, 'real-dir'));
  assert.equal(canonicalPath(join(TMP, 'real-dir')), join(TMP, 'real-dir'));
  assert.equal(canonicalPath(join(TMP, 'real-dir', 'new', 'deeper')), join(TMP, 'real-dir', 'new', 'deeper'));
  assert.equal(canonicalPath(join(TMP, 'real-dir', '..', 'real-dir', 'x')), join(TMP, 'real-dir', 'x'));
});
linkTest('canonicalPath resolves a symlink to its target, also when the child below it does not exist yet', () => {
  mkdirSync(join(TMP, 'target-a'));
  symlinkSync(join(TMP, 'target-a'), join(TMP, 'link-a'));
  assert.equal(canonicalPath(join(TMP, 'link-a')), join(TMP, 'target-a'));
  assert.equal(canonicalPath(join(TMP, 'link-a', 'child', 'grandchild')), join(TMP, 'target-a', 'child', 'grandchild'));
});
linkTest('a dangling symlink, a symlink loop, and a path through a file all fail closed', () => {
  symlinkSync(join(TMP, 'does-not-exist'), join(TMP, 'dangling'));
  assert.throws(() => canonicalPath(join(TMP, 'dangling')), /symlink to a path that does not exist/);
  assert.throws(() => canonicalPath(join(TMP, 'dangling', 'child')), /symlink to a path that does not exist/);
  symlinkSync(join(TMP, 'loop-b'), join(TMP, 'loop-a')); symlinkSync(join(TMP, 'loop-a'), join(TMP, 'loop-b'));
  assert.throws(() => canonicalPath(join(TMP, 'loop-a')), /cannot resolve/);
  writeFileSync(join(TMP, 'a-file'), 'x');
  assert.throws(() => canonicalPath(join(TMP, 'a-file', 'child')), /cannot resolve .*ENOTDIR/);
});

console.log('== paths: handoff directory validation');
test('a normal external handoff directory is accepted (existing or not yet created)', () => {
  mkdirSync(join(TMP, 'notes-ok'));
  assert.deepEqual(handoffErrors(join(TMP, 'notes-ok')), []);
  assert.deepEqual(handoffErrors(join(TMP, 'not-created-yet', 'notes')), []);
});
test('a relative external handoff directory is resolved against the working directory and accepted', () => {
  const old = process.cwd();
  process.chdir(TMP);
  try { assert.deepEqual(handoffErrors('rel-notes/out'), []); } finally { process.chdir(old); }
});
test('a directory inside the tool folder is rejected by its plain path', () => {
  const e = handoffErrors(join(TOOL_DIR, 'notes'));
  assert.equal(e.length, 1); assert.match(e[0].message, /inside this tool/);
  assert.equal(handoffErrors(TOOL_DIR).length, 1, 'the tool folder itself');
});
linkTest('an existing symlink that points into the tool folder is rejected', () => {
  symlinkSync(join(TOOL_DIR, 'templates'), join(TMP, 'link-into-tool'));
  const e = handoffErrors(join(TMP, 'link-into-tool'));
  assert.equal(e.length, 1); assert.match(e[0].message, /inside this tool.*after resolving symlinks/);
});
linkTest('a symlinked parent with a directory that does not exist yet is rejected', () => {
  symlinkSync(TOOL_DIR, join(TMP, 'link-to-tool-root'));
  const e = handoffErrors(join(TMP, 'link-to-tool-root', 'notes-that-do-not-exist'));
  assert.equal(e.length, 1); assert.match(e[0].message, /inside this tool/);
  assert.ok(!existsSync(join(TOOL_DIR, 'notes-that-do-not-exist')), 'validation creates nothing');
});
linkTest('a symlink that points outside the tool folder is accepted', () => {
  mkdirSync(join(TMP, 'elsewhere'));
  symlinkSync(join(TMP, 'elsewhere'), join(TMP, 'link-elsewhere'));
  assert.deepEqual(handoffErrors(join(TMP, 'link-elsewhere', 'notes')), []);
});
test('a directory that shares a textual prefix with the tool folder, but not a path boundary, is accepted', () => {
  const sibling = TOOL_DIR + '-other';
  assert.ok(sibling.startsWith(TOOL_DIR) && !sibling.startsWith(TOOL_DIR + sep));
  assert.deepEqual(handoffErrors(join(sibling, 'notes')), [], 'validation never creates it');
  assert.ok(!existsSync(sibling));
});
linkTest('a path that cannot be resolved (dangling link, loop, through a file) is an error, not a pass', () => {
  for (const bad of [join(TMP, 'dangling'), join(TMP, 'loop-a', 'x'), join(TMP, 'a-file', 'x')]) {
    const e = handoffErrors(bad);
    assert.equal(e.length, 1, bad); assert.match(e[0].message, /cannot resolve/);
  }
});
linkTest('the Chrome profile directory gets the same symlink check', () => {
  const c = cfgFor(join(TMP, 'notes-ok')); c.chrome.profileDir = join(TMP, 'link-into-tool', 'profile');
  const e = validateConfig(c, ['capture']).errors.filter(x => x.key === 'chrome.profileDir');
  assert.ok(e.some(x => /inside this tool/.test(x.message)), JSON.stringify(e));
});

console.log('== paths: the handoff command writes nothing when the destination is unsafe');
linkTest('a symlinked destination into the tool folder exits 1 with a clear reason and creates no note', () => {
  const before = entries(join(TOOL_DIR, 'templates'));
  const r = cli(cfgFor(join(TMP, 'link-into-tool')));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /inside this tool/);
  assert.deepEqual(entries(join(TOOL_DIR, 'templates')), before, 'nothing was written into the tool folder');
});
linkTest('a symlinked parent with a new child exits 1, creates no directory, and creates no note', () => {
  const r = cli(cfgFor(join(TMP, 'link-to-tool-root', 'fresh-notes')));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(!existsSync(join(TOOL_DIR, 'fresh-notes')), 'the directory was not created inside the tool folder');
});
linkTest('an unresolvable destination exits 1 and writes nothing', () => {
  const r = cli(cfgFor(join(TMP, 'dangling')));
  assert.equal(r.status, 1); assert.match(r.stderr, /cannot resolve/);
  assert.ok(!existsSync(join(TMP, 'does-not-exist')), 'the dangling link target was not created');
});
test('a destination inside the tool folder by plain path exits 1 and creates no note', () => {
  const r = cli(cfgFor(join(TOOL_DIR, 'notes-plain-path')));
  assert.equal(r.status, 1); assert.match(r.stderr, /inside this tool/);
  assert.ok(!existsSync(join(TOOL_DIR, 'notes-plain-path')));
});

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped (no symlink support)` : ''} (paths)`);
process.exit(failed ? 1 : 0);
