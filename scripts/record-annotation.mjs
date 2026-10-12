#!/usr/bin/env node
/**
 * p1-editor-screenshots / record-annotation
 *
 * Records that one shot of a run has an annotated frame in Figma, so `handoff.mjs` can check that
 * every shot was annotated before it writes the docs handoff note. It writes annotation-record.json
 * into the run folder.
 *
 * Recording is an attestation: this tool can't read Figma. By passing --kit-only and --redacted you
 * say that the marks are Annotation kit instances only (no hand-styled marks) and that avatars,
 * names, emails, and IDs are redacted. Both flags are required.
 *
 * Usage:
 *   node record-annotation.mjs --dir <out>/run1 --slug editor-shell --annotated-node-id 87:2 --kit-only --redacted
 *   Optional: --clean-node-id 84:13   (refused if it equals the annotated node ID)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    slug: { type: 'string' },
    'annotated-node-id': { type: 'string' },
    'clean-node-id': { type: 'string' },
    'kit-only': { type: 'boolean' },
    redacted: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const fail = msg => { console.error(`FAIL: ${msg}`); process.exit(1); };

if (values.help || !values.dir || !values.slug || !values['annotated-node-id']) {
  console.log(`Usage: node record-annotation.mjs --dir <run folder> --slug <shot slug> --annotated-node-id <id> --kit-only --redacted [--clean-node-id <id>]`);
  process.exit(values.help ? 0 : 1);
}

const NODE_ID = /^\d+[:-]\d+$/;
const annotated = values['annotated-node-id'];
const clean = values['clean-node-id'];
if (!NODE_ID.test(annotated)) fail(`--annotated-node-id "${annotated}" is not a Figma node ID (for example 87:2).`);
if (clean !== undefined && !NODE_ID.test(clean)) fail(`--clean-node-id "${clean}" is not a Figma node ID.`);
if (clean !== undefined && clean.replace('-', ':') === annotated.replace('-', ':')) fail('The annotated frame node ID must not be the clean frame node ID. The docs embed the annotated frame.');
if (!values['kit-only'] || !values.redacted) {
  fail('Recording an annotation is an attestation. Pass --kit-only (the marks are Annotation kit instances only, nothing hand-styled) and --redacted (avatars, names, emails, and IDs are covered). If either is not true, fix the frame first.');
}

const dir = resolve(values.dir);
const planFile = join(dir, 'figma-plan.json');
if (!existsSync(planFile)) fail(`${planFile} not found. Run scripts/figma-plan.mjs for this run first.`);
const plan = JSON.parse(readFileSync(planFile, 'utf-8'));
const slugs = [...new Set((plan.rows || []).map(r => r.slug))];
if (!slugs.includes(values.slug)) fail(`"${values.slug}" is not a shot in this run. Shots: ${slugs.join(', ')}.`);

const file = join(dir, 'annotation-record.json');
const rec = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : { runId: plan.runId, frames: {} };
rec.runId = plan.runId;
rec.frames[values.slug] = {
  annotatedNodeId: annotated.replace('-', ':'),
  ...(clean !== undefined ? { cleanNodeId: clean.replace('-', ':') } : {}),
  status: 'complete',
  kitOnly: true,
  redacted: true,
  recordedAt: new Date().toISOString(),
};
writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
const left = slugs.filter(s => !rec.frames[s]);
console.log(`Recorded ${values.slug} (annotated frame ${annotated}). ${left.length ? `Still to record: ${left.join(', ')}.` : 'All shots in this run are recorded.'}`);
