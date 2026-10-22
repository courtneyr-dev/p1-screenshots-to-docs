#!/usr/bin/env node
/**
 * Tests for scripts/figma-kit-check.mjs and its wiring into preflight. No Figma access: the snippet runs against
 * a small in-memory model of the Figma plugin API, and saved results are checked against a fixture contract.
 *
 * Fixtures (tests/fixtures/kit-check/):
 *   annotation-tokens.json  the contract: brand colors, roles, metrics, and the Figma variables built from them
 *   good-result.json        what the snippet returns for a file built from that contract
 *   stale-result.json       what it returned on 2026-10-21 for the older kit: no stamps, colors aliasing a remote
 *                           library, no color/redact (variables are the old kit's, from figma-plugin/kit.json)
 *
 * Prints PASS/FAIL lines in the format tests/run-tests.sh counts.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { snippetCode, verifyKitResult, kitComponentNames, tokensIdentity, FIX_STAMP, FIX_VARIABLES } from '../scripts/figma-kit-check.mjs';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const FX = join(ROOT, 'tests', 'fixtures', 'kit-check');
const TOKENS = join(FX, 'annotation-tokens.json');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'kit-check-test-')));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`FAIL  ${name}`); console.log('        ' + String(e.message || e).split('\n').slice(0, 8).join('\n        ')); failed += 1; }
};

const tokens = JSON.parse(readFileSync(TOKENS, 'utf-8'));
const componentNames = kitComponentNames();
const HASH = tokensIdentity(tokens).hash;
// good-result.json holds $KIT_HASH where the contract's hash goes (see its $comment); fill it in.
const withHash = text => text.replaceAll('$KIT_HASH', HASH);
const good = JSON.parse(withHash(readFileSync(join(FX, 'good-result.json'), 'utf-8')));
delete good.$comment;
const stale = JSON.parse(readFileSync(join(FX, 'stale-result.json'), 'utf-8'));
const clone = o => JSON.parse(JSON.stringify(o));
const verify = r => verifyKitResult(r, { tokens, componentNames });
const cli = (...args) => spawnSync('node', [join(ROOT, 'scripts', 'figma-kit-check.mjs'), ...args], { encoding: 'utf-8' });
const save = (name, obj) => { const f = join(TMP, name); writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const GOOD_FILE = () => save('good-filled.json', good);
const variable = (r, label) => r.variables.find(v => `${v.collection}/${v.name}` === label);

// ---------- the snippet ----------

// A minimal model of the plugin API the snippet calls, built from a result so the two can be compared.
function mockFigma(result) {
  const rgb = h => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
  const collections = [], vars = new Map();
  let n = 0;
  for (const v of result.variables) {
    let col = collections.find(c => c.name === v.collection);
    if (!col) collections.push(col = { id: `C${++n}`, name: v.collection, defaultModeId: 'm', variableIds: [] });
  }
  const raw = v => (typeof v.value === 'number' ? v.value : rgb(v.value));
  const mk = (id, v, extra = {}) => ({ id, name: v.name, resolvedType: v.type, valuesByMode: { m: raw(v) }, remote: false, ...extra });
  // Direct variables first, then aliases that point at them (or at a remote library variable).
  for (const v of result.variables) if (!v.alias.length) vars.set(`${v.collection}/${v.name}`, mk(`V${++n}`, v, { variableCollectionId: collections.find(c => c.name === v.collection).id }));
  for (const v of result.variables) {
    if (!v.alias.length) continue;
    const [target] = v.alias;
    let t = vars.get(target);
    if (!t) { // a remote library variable: it has no local collection
      t = { id: `R${++n}`, name: target.replace(/^\(library\)\//, ''), resolvedType: v.type, valuesByMode: { lib: raw(v) }, remote: true, variableCollectionId: 'remote' };
      vars.set(target, t);
    }
    vars.set(`${v.collection}/${v.name}`, { id: `V${++n}`, name: v.name, resolvedType: v.type, valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: t.id } }, remote: false, variableCollectionId: collections.find(c => c.name === v.collection).id });
  }
  const byId = new Map([...vars.values()].map(v => [v.id, v]));
  for (const v of result.variables) collections.find(c => c.name === v.collection).variableIds.push(vars.get(`${v.collection}/${v.name}`).id);
  const stamps = { tokensSchema: result.root.tokensSchema, tokensHash: result.root.tokensHash };
  const node = (name, kit) => ({ type: 'COMPONENT_SET', name, parent: null, getSharedPluginData: (ns, key) => (ns === 's2d' && key === 'kit' && kit) || '' });
  const page = { findAllWithCriteria: () => result.components.flatMap(c => c.kits.map(k => node(c.name, k))) };
  return {
    loadAllPagesAsync: async () => {},
    root: { children: [page], getSharedPluginData: (ns, key) => (ns === 's2d' ? stamps[key] || '' : '') },
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      getVariableByIdAsync: async id => byId.get(id) || null,
      getVariableCollectionByIdAsync: async id => collections.find(c => c.id === id) || null,
    },
  };
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runSnippet = figma => new AsyncFunction('figma', snippetCode({ componentNames }))(figma);

await test('the snippet only reads: no write calls, and it names all 13 kit components and both collections', () => {
  const code = snippetCode({ componentNames });
  assert.equal(componentNames.length, 13);
  for (const n of componentNames) assert.ok(code.includes(JSON.stringify(n)), n);
  assert.ok(code.includes('"Annotation primitives"') && code.includes('"Annotation"'));
  assert.doesNotMatch(code, /\.(set[A-Z]\w*|create\w*|remove|delete|appendChild|insertChild|import\w*)\s*\(/, 'a write or create call');
  assert.doesNotMatch(code, /\bfigma\.(createVariable|createComponent|notify|closePlugin)/);
  assert.match(code, /getSharedPluginData/);
});

await test('the snippet returns what the file holds: a good model round-trips to the good fixture', async () => {
  assert.deepEqual(clone(await runSnippet(mockFigma(good))), good);
});

await test('the snippet follows alias chains and library variables: the stale model round-trips to the stale fixture', async () => {
  const out = clone(await runSnippet(mockFigma(stale)));
  assert.deepEqual(out, stale);
  assert.deepEqual(variable(out, 'Annotation/color/mark').alias, ['(library)/primitive/discovery/600']);
  assert.equal(variable(out, 'Annotation/color/mark').value, '#7952A8');
});

await test('the snippet sees a stamp removed from one component, and verification then names it', async () => {
  const m = clone(good); m.components.find(c => c.name === 'Redact').kits = [null];
  const out = clone(await runSnippet(mockFigma(m)));
  assert.deepEqual(out.components.find(c => c.name === 'Redact').kits, [null]);
  const v = verify(out);
  assert.ok(!v.ok && v.stamp.some(s => s.includes('"Redact"')), v.stamp.join('\n'));
});

await test('--out writes a snippet that parses as an async function body', () => {
  const f = join(TMP, 'snippet.js');
  const r = cli('--out', f);
  assert.equal(r.status, 0, r.stderr);
  new AsyncFunction('figma', readFileSync(f, 'utf-8'));
  assert.match(r.stdout, /use_figma/);
});

// ---------- verification ----------

await test('a result for a file built from the contract passes', () => {
  const v = verify(good);
  assert.ok(v.ok, JSON.stringify(v));
  const r = cli('--result', GOOD_FILE(), '--tokens', TOKENS);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /passed/);
});

await test('the stale kit from 2026-10-21 fails with both remedies and the values that were wrong', () => {
  const r = cli('--result', join(FX, 'stale-result.json'), '--tokens', TOKENS);
  assert.equal(r.status, 1);
  const out = r.stdout;
  assert.ok(out.includes(FIX_STAMP) && out.includes(FIX_VARIABLES), out);
  assert.match(out, /tokensHash is empty/);
  assert.match(out, /color\/mark is #7952A8 .*primitive\/discovery\/600.*contract says #3017A1/);
  assert.match(out, /color\/ink is #4A4844 .*contract says #23232D/);
  assert.match(out, /Annotation\/color\/redact is missing/);
  assert.match(out, /"Step badge" has no kit stamp/);
  assert.ok(out.indexOf(FIX_VARIABLES) < out.indexOf(FIX_STAMP), 'variables are fixed first');
});

// Mutation controls: one change to a good result, and the check must fail for that reason only.
await test('MUTATION: changing one color fails the variables check, names it, and does not blame the stamps', () => {
  const m = clone(good); variable(m, 'Annotation primitives/brand/purple').value = '#3017A2';
  const v = verify(m);
  assert.ok(!v.ok && v.stamp.length === 0 && v.variables.length === 1, JSON.stringify(v));
  assert.match(v.variables[0], /brand\/purple is #3017A2.*contract says #3017A1/);
  const f = save('m-color.json', m);
  const r = cli('--result', f, '--tokens', TOKENS);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(FIX_VARIABLES) && !r.stdout.includes(FIX_STAMP));
});

await test('MUTATION: a semantic variable resolving to the wrong color fails (color/mark)', () => {
  const m = clone(good); variable(m, 'Annotation/color/mark').value = '#7952A8';
  const v = verify(m);
  assert.ok(!v.ok && v.variables.some(x => /color\/mark is #7952A8/.test(x)), JSON.stringify(v.variables));
});

await test('MUTATION: dropping one component stamp fails the stamp check, names it, and does not blame the variables', () => {
  const m = clone(good); m.components.find(c => c.name === 'Arrow').kits = [null];
  const v = verify(m);
  assert.ok(!v.ok && v.variables.length === 0 && v.stamp.length === 1 && v.stamp[0].includes('"Arrow"'), JSON.stringify(v));
  const r = cli('--result', save('m-stamp.json', m), '--tokens', TOKENS);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(FIX_STAMP) && !r.stdout.includes(FIX_VARIABLES));
});

await test('MUTATION: a component stamped by another token hash fails and names both hashes', () => {
  const m = clone(good); m.components.find(c => c.name === 'Underline').kits = ['0'.repeat(64)];
  const v = verify(m);
  assert.ok(v.stamp.length === 1 && new RegExp(`"Underline" was built from token hash 000000000000, not ${HASH.slice(0, 12)}`).test(v.stamp[0]), JSON.stringify(v.stamp));
});

await test('MUTATION: a component missing from the file, or present twice with one old stamp, fails', () => {
  const missing = clone(good); missing.components.find(c => c.name === 'Cursor').found = 0; missing.components.find(c => c.name === 'Cursor').kits = [];
  assert.ok(verify(missing).stamp.some(s => s.includes('"Cursor" is not in the file')));
  const dup = clone(good); dup.components.find(c => c.name === 'Note box').kits.push('1'.repeat(64));
  assert.ok(verify(dup).stamp.some(s => s.includes('"Note box" was built from token hash 111111111111')));
});

await test('MUTATION: a wrong or empty root hash, or a wrong schema, fails the stamp check', () => {
  const wrong = clone(good); wrong.root.tokensHash = 'f'.repeat(64);
  assert.ok(verify(wrong).stamp.some(s => /token hash ffffffffffff is not this repository's/.test(s)));
  const empty = clone(good); empty.root.tokensHash = '';
  assert.ok(verify(empty).stamp.some(s => /no kit stamp/.test(s)));
  const schema = clone(good); schema.root.tokensSchema = '0';
  assert.ok(verify(schema).stamp.some(s => /schema is 0, not 1/.test(s)));
});

await test('MUTATION: a color variable that aliases a library variable, or another collection, fails even with the right value', () => {
  const lib = clone(good); variable(lib, 'Annotation/color/ink').alias = ['(library)/primitive/warm/900'];
  const v = verify(lib);
  assert.ok(!v.ok && v.variables.length === 1 && /color\/ink aliases \(library\)\/primitive\/warm\/900, the contract says Annotation primitives\/brand\/black/.test(v.variables[0]), JSON.stringify(v.variables));
  const other = clone(good); variable(other, 'Annotation/color/do').alias = ['Annotation/color/mark'];
  assert.ok(verify(other).variables.some(s => /color\/do aliases Annotation\/color\/mark/.test(s)));
  const none = clone(good); variable(none, 'Annotation/color/dont').alias = [];
  assert.ok(verify(none).variables.some(s => /color\/dont aliases nothing/.test(s)));
});

await test('MUTATION: a missing variable (color/redact) and a changed number (size/stroke) fail', () => {
  const miss = clone(good); miss.variables = miss.variables.filter(v => v.name !== 'color/redact');
  assert.deepEqual(verify(miss).variables, ['Annotation/color/redact is missing']);
  const num = clone(good); variable(num, 'Annotation/size/stroke').value = 4;
  assert.deepEqual(verify(num).variables, ['Annotation/size/stroke is 4, the contract says 6']);
});

await test('colors compare case-insensitively, and extra variables outside the contract are ignored', () => {
  const m = clone(good); variable(m, 'Annotation/color/mark').value = '#3017a1';
  m.variables.push({ collection: 'Annotation', name: 'color/caution', type: 'COLOR', value: '#B15C16', alias: ['(library)/primitive/warning/700'] });
  assert.ok(verify(m).ok);
});

await test('input that is not a kit-check result is refused with how to make one; a result wrapped under "result" is accepted', () => {
  for (const bad of [{}, { schema: 'other' }, { ...good, variables: 'x' }, null]) {
    const v = verify(bad);
    assert.ok(!v.ok && /kit-check result/.test(v.shape[0]), JSON.stringify(bad));
  }
  assert.ok(verify({ result: good }).ok);
  const r = cli('--result', save('garbage.json', 'not json {'), '--tokens', TOKENS);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read the kit-check result/);
});

await test('a missing token contract is reported with the flag that fixes it', () => {
  const r = cli('--result', GOOD_FILE(), '--tokens', join(TMP, 'nope.json'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /token contract .*nope\.json was not found.*--tokens/);
});

await test('the hash is over the canonical contract: key order does not matter, a value does', () => {
  const reordered = Object.fromEntries(Object.entries(tokens).reverse());
  assert.equal(tokensIdentity(reordered).hash, tokensIdentity(tokens).hash);
  const edited = clone(tokens); edited.brand.purple.hex = '#3017A2';
  assert.notEqual(tokensIdentity(edited).hash, tokensIdentity(tokens).hash);
  assert.equal(tokensIdentity(tokens).hash, good.root.tokensHash);
  assert.ok(!readFileSync(join(FX, 'good-result.json'), 'utf-8').includes(HASH), 'the fixture holds the placeholder, not the hash');
});

// ---------- preflight ----------

const cfg = join(TMP, 'cfg.json');
mkdirSync(join(TMP, 'profile'));
writeFileSync(cfg, JSON.stringify({
  topic: 'kit-check', baseUrl: 'http://localhost:3000', projectName: 'QA Project', workstream: 'qa-workstream', pagePath: '/',
  chrome: { profileDir: join(TMP, 'profile'), cdpPort: 9555 }, figma: { fileKey: 'QaQaQaQaQaQaQaQaQaQaQa' }, docs: { handoffDir: join(TMP, 'notes') },
}));
const preflight = (...args) => spawnSync('node', [join(ROOT, 'scripts', 'preflight.mjs'), '--config', cfg, ...args], { encoding: 'utf-8' });

await test('preflight --need figma prints the kit-check steps instead of claiming the kit is fine, and still exits 0 for a good config', () => {
  const r = preflight('--need', 'figma');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Kit check not done: preflight can't call Figma/);
  assert.match(r.stdout, /figma-kit-check\.mjs --out/);
  assert.match(r.stdout, /--kit-result <saved file>/);
});

await test('preflight without the figma stage says nothing about the kit', () => {
  const r = preflight('--need', 'capture');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /Kit check/);
});

await test('preflight --kit-result passes a good result and reports it', () => {
  const r = preflight('--need', 'figma', '--kit-result', GOOD_FILE(), '--kit-tokens', TOKENS);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Kit check passed/);
  assert.doesNotMatch(r.stdout, /Kit check not done/);
});

await test('preflight --kit-result exits 1 on the stale kit and prints both remedies', () => {
  const r = preflight('--need', 'figma', '--kit-result', join(FX, 'stale-result.json'), '--kit-tokens', TOKENS);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(FIX_STAMP) && r.stdout.includes(FIX_VARIABLES), r.stdout);
});

await test('MUTATION: preflight --kit-result exits 1 for a good result with one color changed', () => {
  const m = clone(good); variable(m, 'Annotation/color/halo').value = '#FFFFFE';
  const r = preflight('--need', 'figma', '--kit-result', save('pf-m.json', m), '--kit-tokens', TOKENS);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /color\/halo is #FFFFFE/);
});

await test('preflight --kit-result with a missing contract exits 1 and says why', () => {
  const r = preflight('--need', 'figma', '--kit-result', GOOD_FILE(), '--kit-tokens', join(TMP, 'nope.json'));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Kit check could not run: .*was not found/);
});

console.log(`\nkit-check tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
