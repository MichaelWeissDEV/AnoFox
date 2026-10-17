/**
 * Static-ruleset feasibility study in real Firefox (Phase 11 follow-up): how many static rules can be enabled, how fast,
 * what happens above the guaranteed 30 000, how the regex cap applies, and whether static and dynamic rules coexist.
 * Rule sets are synthetic (sized like real lists); with STATIC_REAL_DIR=<dir with easylist.txt and easyprivacy.txt> the real lists
 * are compiled with AnoFox's own compiler and measured as well.
 *
 *   npm run test:firefox:static       (RESULT_OUT=file keeps the raw result)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const FIREFOX = process.env.FIREFOX_BIN ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const PORT = 18796;
if (!existsSync(FIREFOX)) { console.log(`SKIP: Firefox not found at ${FIREFOX}`); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'anofox-static-'));
const probeDir = join(dir, 'probe');
cpSync(join(here, 'probe'), probeDir, { recursive: true });

const manifest = JSON.parse(readFileSync(join(probeDir, 'manifest.template.json'), 'utf8'));
const ruleResources = [];
const sets = [];
const writeSet = (id, rules) => { writeFileSync(join(probeDir, `${id}.json`), JSON.stringify(rules)); ruleResources.push({ id, enabled: false, path: `${id}.json` }); };
const block = (i) => ({ id: i + 1, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/blocked.html' } }, condition: { urlFilter: `||s${i}.static.example^`, resourceTypes: ['main_frame'] } });
const synthetic = (n) => Array.from({ length: n }, (_, i) => block(i));
for (const n of [5000, 13000, 30000, 31000, 60000, 100000]) {
  writeSet(`s${n}`, synthetic(n));
  sets.push({ name: `static-${n}`, ids: [`s${n}`], rules: n, probes: { first: 's0.static.example', middle: `s${Math.floor(n / 2)}.static.example`, last: `s${n - 1}.static.example` } });
}
sets.push({ name: 'static-13000+30000-together', ids: ['s13000', 's30000'], rules: 43000 });
for (const n of [1000, 1001]) {
  writeSet(`r${n}`, Array.from({ length: n }, (_, i) => ({ id: i + 1, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/blocked.html' } }, condition: { regexFilter: `^https?://r${i}\\.regex\\.example/`, resourceTypes: ['main_frame'] } })));
  sets.push({ name: `regex-rules-${n}`, ids: [`r${n}`], rules: n, probes: { first: 'r0.regex.example', last: `r${n - 1}.regex.example` } });
}

if (process.env.STATIC_REAL_DIR) {
  const { parseList } = await import('../../../src/protection/adblock/parser.ts');
  const { compileFilters } = await import('../../../src/protection/adblock/compile-dnr.ts');
  const all = [];
  for (const f of ['easylist.txt', 'easyprivacy.txt']) all.push(...parseList(readFileSync(join(process.env.STATIC_REAL_DIR, f), 'utf8')).filters);
  const { rules, stats } = compileFilters(all, { idBase: 1, maxRules: 1_000_000 });
  const regexRules = rules.filter((r) => r.condition.regexFilter).length;
  console.log(`real lists: ${all.length} filters -> ${rules.length} rules (${regexRules} regex), file ${(JSON.stringify(rules).length / 1048576).toFixed(1)} MB`);
  writeSet('real', rules);
  sets.push({ name: `real EasyList+EasyPrivacy (${rules.length} rules, ${regexRules} regex)`, ids: ['real'], rules: rules.length });
}
manifest.declarative_net_request.rule_resources = ruleResources;
writeFileSync(join(probeDir, 'manifest.json'), JSON.stringify(manifest));
writeFileSync(join(probeDir, 'config.json'), JSON.stringify({ base: `http://127.0.0.1:${PORT}`, sets, coexist: { static: 's5000', staticHost: 's100.static.example' } }));
const resultFile = join(dir, 'result.json');

const server = spawn(process.execPath, ['--no-warnings', join(here, 'server.mjs'), resultFile], { env: { ...process.env, PROBE_PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const webext = spawn('npx', ['web-ext', 'run', '--source-dir', probeDir, '--firefox', FIREFOX, '--arg=-headless',
  '--pref=network.proxy.type=2', `--pref=network.proxy.autoconfig_url=http://127.0.0.1:${PORT}/proxy.pac`, '--no-reload', '--no-input', '--start-url', 'about:blank'],
  { stdio: 'ignore', cwd: join(here, '../../..'), detached: true });
const kill = () => { try { process.kill(-webext.pid, 'SIGTERM'); } catch {} try { server.kill(); } catch {} };
process.on('exit', kill);
const deadline = Date.now() + 600_000;
while (!existsSync(resultFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000));
kill();
if (!existsSync(resultFile)) { console.error('FAIL: no result from Firefox'); process.exit(1); }
const R = JSON.parse(readFileSync(resultFile, 'utf8'));
if (process.env.RESULT_OUT) writeFileSync(process.env.RESULT_OUT, JSON.stringify(R, null, 2));

console.log('limits:', JSON.stringify(R.limits), '| available at start:', R.availableAtStart);
for (const [name, s] of Object.entries(R.sets)) {
  const probes = s.probes ? ' probes ' + Object.entries(s.probes).map(([k, v]) => `${k}:${v.blocked ? 'blocked' : 'LOADED'}`).join(',') : '';
  console.log(`${name.padEnd(48)} enable ${String(s.enableMs).padStart(5)} ms  available ${String(s.available).padStart(6)}  ${s.error ? 'ERROR: ' + s.error.slice(0, 110) : 'ok'}${probes}`);
}
console.log('coexist:', JSON.stringify(R.coexist));

let failed = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); } };
check('static rulesets are NOT enabled until asked (nothing active at install)', () => assert.deepEqual(R.enabledAtStart, []));
check('13 000 static rules (EasyList+EasyPrivacy size) enable quickly and match first / middle / last', () => {
  const s = R.sets['static-13000'];
  assert.equal(s.error, null); assert.ok(s.enableMs < 3000, `${s.enableMs} ms`);
  for (const k of ['first', 'middle', 'last']) assert.equal(s.probes[k].blocked, true, k);
});
check('30 000 static rules (the guaranteed minimum) enable and match', () => {
  const s = R.sets['static-30000'];
  assert.equal(s.error, null);
  for (const k of ['first', 'middle', 'last']) assert.equal(s.probes[k].blocked, true, k);
});
check('rule data does not slow down navigation (30 000 static rules vs baseline within 80 ms)', () => {
  assert.ok(R.sets['static-30000'].clean.ms < R.baseline.ms + 80, `${R.sets['static-30000'].clean.ms} vs ${R.baseline.ms}`);
});
check('static and dynamic rules coexist; both sets match', () => {
  assert.equal(R.coexist.error, null); assert.equal(R.coexist.staticHit, true); assert.equal(R.coexist.dynamicHit, true);
});
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nstatic-ruleset checks passed (limits above are measured, not asserted)');
