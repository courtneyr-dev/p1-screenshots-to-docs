#!/usr/bin/env node
/**
 * p1-editor-screenshots / preflight
 *
 * Checks the per-run config (and optionally a brief) and reports every missing or invalid value
 * at once. It never opens a browser. With --check-chrome it makes one HTTP request to the Chrome
 * debugging endpoint to see whether the dedicated Chrome is running.
 *
 * Usage:
 *   node preflight.mjs --config p1-editor.config.json
 *   node preflight.mjs --config p1-editor.config.json --need capture,figma,handoff
 *   node preflight.mjs --config p1-editor.config.json --brief briefs/p1-editor.json --check-chrome
 *   node preflight.mjs --config p1-editor.config.json --need figma --kit-result kit-check-result.json
 *
 * The figma stage also needs the Annotation kit in the Figma file to match the token contract. Preflight can't
 * call Figma, so without --kit-result it prints the next step; with --kit-result it verifies a saved result of
 * scripts/figma-kit-check.mjs and exits 1 on a mismatch.
 *
 * Exit code: 0 when everything required is present, 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig, applyOverrides, validateConfig, formatValidation, deriveParams, applyParams } from './lib/config.mjs';
import { checkResultFile, formatKitReport, TOKENS_FILE } from './figma-kit-check.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    need: { type: 'string', default: 'capture,figma,handoff' },
    brief: { type: 'string' },
    set: { type: 'string', multiple: true },
    'check-chrome': { type: 'boolean' },
    'kit-result': { type: 'string' },
    'kit-tokens': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || !values.config) {
  console.log(`Usage: node preflight.mjs --config <file> [--need capture,figma,handoff] [--brief <brief.json>] [--set key=value] [--check-chrome]

--need      Which parts of the workflow this run uses (default: capture,figma,handoff; Figma and the handoff are part of every run).
--brief     Also check that every {{placeholder}} in the brief has a value, and list shots that will be skipped.
--check-chrome  Ask the Chrome debugging endpoint whether it is running (one HTTP request; opens no browser).
--kit-result    Verify a saved result of scripts/figma-kit-check.mjs against the Annotation token contract.
--kit-tokens    Use another token contract file (default figma-plugin/annotation-tokens.json).`);
  process.exit(values.help ? 0 : 1);
}

const stages = values.need.split(',').map(s => s.trim()).filter(Boolean);
const bad = stages.filter(s => !['capture', 'figma', 'handoff'].includes(s));
if (bad.length) {
  console.error(`FAIL: unknown --need value(s): ${bad.join(', ')}. Use capture, figma, handoff.`);
  process.exit(1);
}

let cfg;
try {
  cfg = applyOverrides(loadConfig(values.config), values.set || []);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
}

const result = validateConfig(cfg, stages);
const lines = [formatValidation(result, `Configuration for ${stages.join(' + ')}`)];
let ok = result.errors.length === 0;

if (values.brief) {
  try {
    const brief = JSON.parse(readFileSync(resolve(values.brief), 'utf-8'));
    const params = deriveParams(cfg);
    const skipped = [];
    const shots = (brief.shots || []).filter(s => {
      const lacking = (s.requires || []).filter(k => !(k in params));
      const anyOk = !s.requiresAny?.length || s.requiresAny.some(k => k in params);
      if (lacking.length || !anyOk) { skipped.push(`${s.slug} (needs ${lacking.length ? lacking.join(', ') : 'one of ' + s.requiresAny.join(', ')})`); return false; }
      return true;
    });
    const { unresolved } = applyParams({ ...brief, shots }, params);
    if (unresolved.length) {
      ok = false;
      lines.push(`Brief ${values.brief} needs values that aren't set:`);
      for (const k of unresolved) lines.push(`  ✗ {{${k}}}: add "${k}" to the config`);
    } else {
      lines.push(`Brief ${values.brief} OK: ${shots.length} shot${shots.length === 1 ? '' : 's'} will run.`);
    }
    // Only the variants this config satisfies count; report a slug skipped only when no variant runs.
    const running = new Set(shots.map(s => s.slug));
    const reallySkipped = skipped.filter(x => !running.has(x.split(' ')[0]));
    for (const s of reallySkipped) lines.push(`  ! skipped: ${s}`);
  } catch (e) {
    ok = false;
    lines.push(`Brief ${values.brief} could not be read: ${e.message}`);
  }
}

if (values['kit-result']) {
  try {
    const kit = checkResultFile(values['kit-result'], { tokensFile: values['kit-tokens'] || TOKENS_FILE });
    lines.push(formatKitReport(kit));
    if (!kit.ok) ok = false;
  } catch (e) {
    ok = false;
    lines.push(`Kit check could not run: ${e.message}`);
  }
} else if (stages.includes('figma')) {
  lines.push(`  ! Kit check not done: preflight can't call Figma, and a kit built from an older plugin gives wrong colors. Next:
      node scripts/figma-kit-check.mjs --out kit-check.js
    Run that file with use_figma in the review file (it only reads), save the JSON it returns, then:
      node scripts/preflight.mjs --config ${values.config} --need figma --kit-result <saved file>`);
}

if (values['check-chrome'] && result.errors.every(e => !e.key.startsWith('chrome.'))) {
  const url = `http://127.0.0.1:${cfg.chrome?.cdpPort}/json/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const info = await res.json();
    lines.push(`Chrome debugging endpoint is up on port ${cfg.chrome.cdpPort} (${info.Browser}).`);
  } catch {
    lines.push(`  ! Nothing is listening on port ${cfg.chrome?.cdpPort}. Start the dedicated Chrome first: node scripts/chrome.mjs --config ${values.config}`);
  }
}

console.log(lines.join('\n'));
process.exit(ok ? 0 : 1);
