#!/usr/bin/env node
/**
 * screenshots-to-docs / figma-kit-check
 *
 * Proves the Annotation kit in a Figma file is the one this repository's token contract describes, before
 * anyone extracts or annotates with it. A kit built from an older plugin carries no stamp and old colors, and
 * nothing else flags that until an extraction comes back wrong.
 *
 *   node figma-kit-check.mjs --out snippet.js          write a read-only use_figma snippet
 *   node figma-kit-check.mjs --result result.json      verify what the snippet returned
 *
 * Run the snippet with `use_figma` in the review file, save its return value as JSON, then pass that file to
 * --result. The snippet reads: the file root's s2d stamp (tokensSchema, tokensHash), the s2d `kit` stamp of each
 * kit component, and every variable in the Annotation and Annotation primitives collections, resolved through
 * VARIABLE_ALIAS chains to a value (hex for colors). It writes nothing to the file.
 *
 * The contract is figma-plugin/annotation-tokens.json (override with --tokens). The kit's component names come
 * from figma-plugin/kit.json (override with --kit). Exit code: 0 when the kit matches, 1 otherwise.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TOKENS_FILE = join(TOOL_DIR, 'figma-plugin', 'annotation-tokens.json');
export const KIT_FILE = join(TOOL_DIR, 'figma-plugin', 'kit.json');
export const RESULT_SCHEMA = 'screenshots-to-docs/kit-check@1';
const PLUGIN_NS = 's2d';
const SEMANTIC = 'Annotation';
const PRIMITIVES = 'Annotation primitives';

export const FIX_STAMP = 'run Plugins > Development > Screenshot annotation kit in this file';
export const FIX_VARIABLES = 'repoint these variables to the brand primitives, or delete the old Annotation collection and re-run the plugin';

// ---------------------------------------------------------------- contract

const sha256 = s => createHash('sha256').update(s).digest('hex');

export function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/** The schema version and hash the plugin stamps on the file: a hash of the contract's canonical JSON. */
export function tokensIdentity(tokens) {
  return { schemaVersion: tokens.schemaVersion, hash: sha256(canonicalJson(tokens)) };
}

export function loadTokens(file = TOKENS_FILE) {
  if (!existsSync(file)) throw new Error(`the token contract ${file} was not found. Pass --tokens <file>, or run from a checkout that has figma-plugin/annotation-tokens.json.`);
  return JSON.parse(readFileSync(file, 'utf-8'));
}

export function kitComponentNames(file = KIT_FILE) {
  return JSON.parse(readFileSync(file, 'utf-8')).components.map(c => c.n);
}

const metric = (t, path) => path.split('.').reduce((o, k) => o?.[k], t.metrics);

/** What every variable in the two collections must hold. Colors are upper-case hex; `alias` is the first hop. */
export function expectedVariables(t) {
  const out = [];
  for (const col of t.figmaVariables.collections) {
    for (const v of col.vars) {
      if (v.type === 'COLOR' && v.brand) out.push({ collection: col.name, name: v.name, value: t.brand[v.brand].hex.toUpperCase() });
      else if (v.type === 'COLOR') {
        const brand = t.roles[v.role].color;
        out.push({ collection: col.name, name: v.name, value: t.brand[brand].hex.toUpperCase(), alias: `${PRIMITIVES}/brand/${brand}` });
      } else out.push({ collection: col.name, name: v.name, value: v.metric ? metric(t, v.metric) : v.value });
    }
  }
  return out;
}

// ---------------------------------------------------------------- snippet

/** The use_figma code. It only reads. */
export function snippetCode({ componentNames }) {
  return `const NS = ${JSON.stringify(PLUGIN_NS)};
const KIT = ${JSON.stringify(componentNames)};
const COLLECTIONS = ${JSON.stringify([SEMANTIC, PRIMITIVES])};
const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

// Kit stamps: the s2d "kit" value on each top-level kit component (a set, or a component outside a set).
try { await figma.loadAllPagesAsync(); } catch (e) {}
const tops = [];
for (const page of figma.root.children) {
  for (const n of page.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })) {
    if (n.type === 'COMPONENT_SET' || !n.parent || n.parent.type !== 'COMPONENT_SET') tops.push(n);
  }
}
const components = KIT.map(name => {
  const nodes = tops.filter(n => n.name === name);
  return { name, found: nodes.length, kits: nodes.map(n => n.getSharedPluginData(NS, 'kit') || null) };
});

// Variables, followed through VARIABLE_ALIAS chains to a value. alias lists each hop as "<collection>/<name>";
// a variable from a remote library shows as "(library)/<name>".
const variables = [];
for (const col of await figma.variables.getLocalVariableCollectionsAsync()) {
  if (!COLLECTIONS.includes(col.name)) continue;
  for (const id of col.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (!v) continue;
    const alias = [];
    let val = v.valuesByMode[col.defaultModeId];
    for (let hops = 0; val && val.type === 'VARIABLE_ALIAS' && hops < 10; hops++) {
      const next = await figma.variables.getVariableByIdAsync(val.id);
      if (!next) { alias.push('(unresolved)/' + val.id); val = null; break; }
      const nextCol = next.remote ? null : await figma.variables.getVariableCollectionByIdAsync(next.variableCollectionId);
      alias.push((nextCol ? nextCol.name : '(library)') + '/' + next.name);
      val = next.valuesByMode[nextCol ? nextCol.defaultModeId : Object.keys(next.valuesByMode)[0]];
    }
    const value = val && typeof val === 'object' && 'r' in val ? hex(val) : typeof val === 'number' ? val : null;
    variables.push({ collection: col.name, name: v.name, type: v.resolvedType, value, alias });
  }
}

return {
  schema: ${JSON.stringify(RESULT_SCHEMA)},
  root: { tokensSchema: figma.root.getSharedPluginData(NS, 'tokensSchema') || '', tokensHash: figma.root.getSharedPluginData(NS, 'tokensHash') || '' },
  components,
  variables,
};
`;
}

// ---------------------------------------------------------------- verification

const short = h => (h ? String(h).slice(0, 12) : 'none');

/**
 * Checks a saved snippet result against the contract.
 * Returns { ok, stamp: [messages], variables: [messages], shape: [messages], identity }.
 */
export function verifyKitResult(result, { tokens, componentNames }) {
  const id = tokensIdentity(tokens);
  const out = { ok: false, shape: [], stamp: [], variables: [], identity: id };
  const r = result && !result.schema && result.result ? result.result : result;
  if (!r || r.schema !== RESULT_SCHEMA || !r.root || !Array.isArray(r.components) || !Array.isArray(r.variables)) {
    out.shape.push(`this isn't a kit-check result (expected schema "${RESULT_SCHEMA}", a root stamp, components, and variables). Generate the snippet with --out, run it with use_figma, and save what it returns.`);
    return out;
  }

  // Stamps: the file root, then each kit component.
  const { tokensSchema, tokensHash } = r.root;
  if (!tokensHash) out.stamp.push('the file has no kit stamp (tokensHash is empty), so it was never built by the plugin that stamps kits');
  else if (tokensHash !== id.hash) out.stamp.push(`the file's token hash ${short(tokensHash)} is not this repository's ${short(id.hash)}`);
  if (String(tokensSchema || '') !== String(id.schemaVersion)) out.stamp.push(`the file's token schema is ${tokensSchema || 'unset'}, not ${id.schemaVersion}`);
  const byName = new Map(r.components.map(c => [c.name, c]));
  for (const name of componentNames) {
    const c = byName.get(name);
    if (!c || !c.found) { out.stamp.push(`"${name}" is not in the file`); continue; }
    const kits = Array.isArray(c.kits) ? c.kits : [];
    if (!kits.length || kits.some(k => !k)) out.stamp.push(`"${name}" has no kit stamp`);
    else if (kits.some(k => k !== id.hash)) out.stamp.push(`"${name}" was built from token hash ${short(kits.find(k => k !== id.hash))}, not ${short(id.hash)}`);
  }

  // Variables: each contract variable must exist, hold the contract value, and (colors in the Annotation
  // collection) alias the matching brand primitive.
  const have = new Map(r.variables.map(v => [`${v.collection}/${v.name}`, v]));
  for (const want of expectedVariables(tokens)) {
    const label = `${want.collection}/${want.name}`;
    const v = have.get(label);
    if (!v) { out.variables.push(`${label} is missing`); continue; }
    const same = typeof want.value === 'number' ? typeof v.value === 'number' && Math.abs(v.value - want.value) < 1e-6 : typeof v.value === 'string' && v.value.toUpperCase() === want.value;
    const via = v.alias?.length ? ` (via ${v.alias.join(' > ')})` : '';
    if (!same) out.variables.push(`${label} is ${v.value ?? 'unresolved'}${via}, the contract says ${want.value}`);
    else if (want.alias && v.alias?.[0] !== want.alias) out.variables.push(`${label} aliases ${v.alias?.[0] ?? 'nothing'}, the contract says ${want.alias}`);
  }

  out.ok = !out.stamp.length && !out.variables.length;
  return out;
}

const LIST_MAX = 30;
const list = items => [...items.slice(0, LIST_MAX).map(m => `  - ${m}`), ...(items.length > LIST_MAX ? [`  - and ${items.length - LIST_MAX} more`] : [])];

/** Plain-text report for verifyKitResult(): what is wrong and the remedy for each kind of problem. */
export function formatKitReport(v) {
  if (v.shape.length) return ['Kit check failed.', ...list(v.shape)].join('\n');
  if (v.ok) return `Kit check passed: the file's kit matches token schema ${v.identity.schemaVersion}, hash ${short(v.identity.hash)}.`;
  const lines = ['Kit check failed: the Figma kit is not the one this repository describes. Extracting from it would give wrong colors.'];
  if (v.variables.length) {
    lines.push(`Variables (${v.variables.length}):`, ...list(v.variables));
    lines.push(`Fix: ${FIX_VARIABLES}.`);
  }
  if (v.stamp.length) {
    lines.push(`Kit stamps (${v.stamp.length}):`, ...list(v.stamp));
    lines.push(`Fix: ${FIX_STAMP}.${v.variables.length ? ' Do the variables first: the plugin reuses variables that already exist, so re-running it alone stamps the file but keeps the old values.' : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- command line

export function checkResultFile(file, { tokensFile = TOKENS_FILE, kitFile = KIT_FILE } = {}) {
  let result;
  try { result = JSON.parse(readFileSync(resolve(file), 'utf-8')); } catch (e) { throw new Error(`cannot read the kit-check result ${file}: ${e.message}`); }
  return verifyKitResult(result, { tokens: loadTokens(tokensFile), componentNames: kitComponentNames(kitFile) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, result: { type: 'string' }, tokens: { type: 'string' }, kit: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help || (!values.out && !values.result)) {
    console.log(`Usage:
  node figma-kit-check.mjs --out snippet.js        write the read-only use_figma snippet
  node figma-kit-check.mjs --result result.json    verify what the snippet returned (exit 1 on a mismatch)
Options: --tokens <file> (default figma-plugin/annotation-tokens.json), --kit <file> (default figma-plugin/kit.json)`);
    process.exit(values.help ? 0 : 1);
  }
  try {
    if (values.out) {
      writeFileSync(resolve(values.out), snippetCode({ componentNames: kitComponentNames(values.kit || KIT_FILE) }));
      console.log(`Wrote ${values.out}. Run it with use_figma in the review file (it only reads), save the returned JSON, then:\n  node scripts/figma-kit-check.mjs --result <saved file>`);
    }
    if (values.result) {
      const v = checkResultFile(values.result, { tokensFile: values.tokens || TOKENS_FILE, kitFile: values.kit || KIT_FILE });
      console.log(formatKitReport(v));
      process.exit(v.ok ? 0 : 1);
    }
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }
}
