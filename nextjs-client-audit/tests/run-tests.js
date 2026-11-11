#!/usr/bin/env node
// Runs scripts/audit.js on every fixture under tests/fixtures with every parser that is available
// (typescript, @babel/parser, and the built-in regex fallback) and checks the result against expected.json.
//   node tests/run-tests.js            # all parsers found (set NODE_PATH to point at a folder with typescript/@babel/parser)
//   node tests/run-tests.js regex      # one parser
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const AUDIT = path.join(__dirname, '..', 'scripts', 'audit.js');
const FIX = path.join(__dirname, 'fixtures');
const has = (m) => { try { require.resolve(m); return true; } catch { return false; } };
const parsers = process.argv[2] ? [process.argv[2]] : [...(has('typescript') ? ['typescript'] : []), ...(has('@babel/parser') ? ['babel'] : []), 'regex'];

let pass = 0, fail = 0;
const failures = [];
const check = (ok, label) => { if (ok) pass++; else { fail++; failures.push(label); } };

for (const parser of parsers) {
  for (const fx of fs.readdirSync(FIX).sort()) {
    const dir = path.join(FIX, fx);
    const expPath = path.join(dir, 'expected.json');
    if (!fs.existsSync(expPath)) continue;
    const exp = JSON.parse(fs.readFileSync(expPath, 'utf8'));
    const tag = `[${parser}] ${fx}`;
    let out, code = 0;
    try { out = execFileSync('node', [AUDIT, dir, '--parser', parser], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { out = e.stdout; code = e.status; }
    const res = JSON.parse(out);
    if (exp.appRouter === false) { check(res.appRouter === false && code === exp.exitCode, `${tag}: expected "not App Router" with exit ${exp.exitCode}, got appRouter=${res.appRouter} exit=${code}`); continue; }
    check(res.parser.kind === parser, `${tag}: parser used was ${res.parser.kind}`);
    for (const [k, v] of Object.entries(exp.summary || {})) check(res.summary[k] === v, `${tag}: summary.${k} expected ${v}, got ${res.summary[k]}`);
    const byFile = Object.fromEntries(res.files.map((f) => [f.file, f]));
    for (const [file, e] of Object.entries(exp.files)) {
      const got = byFile[file];
      if (!got) { check(false, `${tag}: ${file} missing from results`); continue; }
      for (const key of ['status', 'fix', 'priority', 'confidence']) if (key in e) check(got[key] === e[key], `${tag}: ${file} ${key} expected ${e[key]}, got ${got[key]}`);
      if (e.fixTargets) check(JSON.stringify(got.fixTargets) === JSON.stringify(e.fixTargets), `${tag}: ${file} fixTargets expected ${e.fixTargets}, got ${got.fixTargets}`);
      if (e.packages) check(JSON.stringify(got.estimatedPackages) === JSON.stringify(e.packages), `${tag}: ${file} packages expected ${e.packages}, got ${got.estimatedPackages}`);
      if (e.minModules) check(got.estimatedModules >= e.minModules, `${tag}: ${file} estimatedModules ${got.estimatedModules} < ${e.minModules}`);
      for (const r of e.risksInclude || []) check(got.risks.some((x) => x.includes(r)), `${tag}: ${file} risks should mention "${r}"`);
    }
    for (const f of exp.notInReport || []) check(!byFile[f], `${tag}: ${f} must not be reported (false positive)`);
    for (const w of exp.warnings || []) check(res.warnings.some((x) => x.type === w.type && (!w.file || x.file === w.file)), `${tag}: missing warning ${w.type} ${w.file || ''}`);
    for (const d of exp.drafts || []) {
      if (d.astOnly && parser === 'regex') continue;
      const f = res.findings.find((x) => x.file === d.file);
      const block = f && f.draft && f.draft.after.find((a) => a.file === d.afterFile);
      if (!block) { check(false, `${tag}: draft for ${d.file} has no After block for ${d.afterFile}`); continue; }
      for (const s of d.includes || []) check(block.code.includes(s), `${tag}: draft ${d.afterFile} should include ${JSON.stringify(s)}`);
      for (const s of d.excludes || []) check(!block.code.includes(s), `${tag}: draft ${d.afterFile} should NOT include ${JSON.stringify(s)}`);
      if (d.startsWith) check(block.code.startsWith(d.startsWith), `${tag}: draft ${d.afterFile} should start with ${d.startsWith}`);
    }
  }
}
console.log(`parsers: ${parsers.join(', ')}`);
console.log(`${pass} checks passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
