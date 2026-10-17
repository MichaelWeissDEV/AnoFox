/**
 * Real-Firefox capacity and semantics check for the threat-list design (Phase 8): how many domains fit into
 * declarativeNetRequest rules, what matching does with subdomains / IPs / punycode, and how the redirect to the
 * extension's warning page carries the original URL.
 *
 *   npm run test:firefox:threat      (FIREFOX_BIN to override; RESULT_OUT=file to keep the raw result)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const FIREFOX = process.env.FIREFOX_BIN ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const PORT = 18795;
if (!existsSync(FIREFOX)) { console.log(`SKIP: Firefox not found at ${FIREFOX}`); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'anofox-threat-'));
cpSync(join(here, 'probe'), join(dir, 'probe'), { recursive: true });
writeFileSync(join(dir, 'probe', 'config.json'), JSON.stringify({ base: `http://127.0.0.1:${PORT}` }));
const resultFile = join(dir, 'result.json');
const server = spawn(process.execPath, ['--no-warnings', join(here, 'server.mjs'), resultFile], { env: { ...process.env, PROBE_PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const webext = spawn('npx', ['web-ext', 'run', '--source-dir', join(dir, 'probe'), '--firefox', FIREFOX, '--arg=-headless',
  '--pref=network.proxy.type=2', `--pref=network.proxy.autoconfig_url=http://127.0.0.1:${PORT}/proxy.pac`, '--no-reload', '--no-input', '--start-url', 'about:blank'],
  { stdio: 'ignore', cwd: join(here, '../../..'), detached: true });
const kill = () => { try { process.kill(-webext.pid, 'SIGTERM'); } catch {} try { server.kill(); } catch {} };
process.on('exit', kill);
const deadline = Date.now() + 300_000;
while (!existsSync(resultFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1500));
kill();
if (!existsSync(resultFile)) { console.error('FAIL: no result from Firefox'); process.exit(1); }
const R = JSON.parse(readFileSync(resultFile, 'utf8'));
if (process.env.RESULT_OUT) writeFileSync(process.env.RESULT_OUT, JSON.stringify(R, null, 2));

let failed = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); } };
const warn = (x) => x.title === 'blocked' && /^moz-extension:\/\/[^/]+\/blocked\.html\?u=http:\/\//.test(x.url ?? '');

check('quota facts are readable: dynamic 5000, regex 1000, static 30000 guaranteed (Firefox 158)', () => {
  assert.equal(R.limits.MAX_NUMBER_OF_DYNAMIC_RULES, 5000);
  assert.equal(R.limits.MAX_NUMBER_OF_REGEX_RULES, 1000);
  assert.equal(R.limits.GUARANTEED_MINIMUM_STATIC_RULES, 30000);
});
for (const [set, domains] of [['1x5000', 5000], ['60x500=30k', 30000], ['800x500=400k', 400000]]) {
  check(`${domains} domains install (${set}) and match first / middle / last / subdomain`, () => {
    const s = R.sets[set];
    assert.equal(s.install.error, null);
    assert.ok(s.install.installMs < 5000, `install took ${s.install.installMs} ms`);
    for (const k of ['first', 'middle', 'last', 'subdomain']) assert.ok(warn(s.hits[k]), `${k}: ${JSON.stringify(s.hits[k])}`);
  });
  check(`${domains} domains: lookalikes and unlisted hosts are NOT matched (exact host + subdomains only)`, () => {
    const s = R.sets[set];
    assert.match(s.misses.unlisted.title, /^reached /);
    assert.match(s.misses.lookalike.title, /^reached /);
    assert.match(s.hits.ipLikeHostNotListed.title, /^reached /);
  });
}
check('400k domains cost no measurable navigation latency (within 60 ms of the unprotected baseline)', () => {
  const base = Math.max(...R.baselineNav.map((x) => x.ms));
  const withRules = Math.max(...R.sets['800x500=400k'].latency);
  assert.ok(withRules < base + 60, `baseline ${base} ms, with 400k domains ${withRules} ms`);
});
check('IPv4 literals and punycode hosts can be listed; the warning URL carries the full original URL', () => {
  assert.ok(warn(R.ipAndIdn.ip) && R.ipAndIdn.ip.url.endsWith('?u=http://10.9.8.7/x'));
  assert.ok(warn(R.ipAndIdn.idn) && R.ipAndIdn.idn.url.endsWith('?u=http://xn--e1afmkfd.xn--p1ai/x'));
  assert.ok(warn(R.sets['800x500=400k'].hits.first) && R.sets['800x500=400k'].hits.first.url.endsWith('/path?a=1&b=2#frag'), 'query and fragment survive the redirect');
});
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall Firefox threat-capacity checks passed');
