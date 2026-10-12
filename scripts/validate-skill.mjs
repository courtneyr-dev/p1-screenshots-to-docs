#!/usr/bin/env node
/**
 * p1-editor-screenshots / validate-skill
 *
 * Validates the skill's SKILL.md without any dependency, so CI can run it:
 *   - front matter exists, with a kebab-case `name` that equals the folder name and a `description`
 *     of 1 to 1024 characters that says when to use the skill;
 *   - the body is non-empty;
 *   - every relative path SKILL.md names in backticks (references/…, scripts/…, templates/…,
 *     examples/…, briefs/…) exists;
 *   - every file in references/ is linked from SKILL.md (orphans are errors: undocumented docs rot).
 *
 * Usage: node validate-skill.mjs [skill dir]    (default: this tool's folder)
 * Exit code 1 on any error.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { TOOL_DIR } from './lib/config.mjs';

const dir = resolve(process.argv[2] || TOOL_DIR);
const file = join(dir, 'SKILL.md');
const errors = [];
const warnings = [];

if (!existsSync(file)) {
  console.error(`FAIL: ${file} not found`);
  process.exit(1);
}
const text = readFileSync(file, 'utf-8');
const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!m) {
  console.error('FAIL: SKILL.md must start with a --- front matter block');
  process.exit(1);
}
const [, fm, body] = m;

const field = key => {
  const line = fm.split('\n').find(l => l.startsWith(`${key}:`));
  if (!line) return null;
  let v = line.slice(key.length + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
};

const skillName = field('name');
const description = field('description');
if (!skillName) errors.push('front matter has no `name`');
else {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) errors.push(`name "${skillName}" must be kebab-case`);
  if (skillName !== basename(dir)) errors.push(`name "${skillName}" doesn't match the folder name "${basename(dir)}"`);
}
if (!description) errors.push('front matter has no `description`');
else {
  if (description.length > 1024) errors.push(`description is ${description.length} characters; the limit is 1024`);
  if (!/^Use when\b/i.test(description)) warnings.push('description should start with "Use when" so it says when to use the skill');
}
if (body.trim().length < 200) errors.push('the body is empty or too short to be a skill');

// Relative paths named in backticks.
const refs = new Set();
for (const mm of body.matchAll(/`((?:references|scripts|templates|examples|briefs|tests)\/[^`\s<>*]+)`/g)) refs.add(mm[1].replace(/[.,;:]+$/, ''));
for (const r of refs) if (!existsSync(join(dir, r))) errors.push(`SKILL.md names \`${r}\`, which doesn't exist`);

// Every reference must be linked from SKILL.md.
const refDir = join(dir, 'references');
if (existsSync(refDir)) {
  for (const f of readdirSync(refDir)) if (!body.includes(`references/${f}`)) errors.push(`references/${f} isn't linked from SKILL.md`);
}

// Rules every run must follow. If someone edits SKILL.md and drops one, CI fails.
const REQUIRED = [
  ['## Always do, without asking', 'the "Always do, without asking" section'],
  ['Push the run to Figma', 'the always-push-to-Figma rule'],
  ['Annotation kit', 'the Annotation kit rule'],
  ['docs/how-to/annotate.md', 'the pointer to docs/how-to/annotate.md'],
  ['Never style marks by hand', 'the no hand-styled marks rule'],
  ['Redact avatars, names, emails, and IDs', 'the redaction rule'],
  ['built from Annotation kit instances only', 'the annotated-frame completion item'],
  ['record-annotation.mjs', 'the record-annotation step that the handoff gate needs'],
];
for (const [phrase, what] of REQUIRED) if (!body.includes(phrase)) errors.push(`SKILL.md is missing ${what} (looked for "${phrase}")`);

for (const w of warnings) console.log(`  ! ${w}`);
if (errors.length) {
  console.error(`SKILL.md is invalid: ${errors.length} problem${errors.length === 1 ? '' : 's'}.`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`SKILL.md OK: name "${skillName}", ${description.length}-character description, ${refs.size} paths checked.`);
