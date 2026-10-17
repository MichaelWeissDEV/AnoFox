/**
 * Builds the bundled list snapshots (static DNR rulesets) into build/rulesets/ by downloading the CURRENT lists.
 *
 *   npm run build:rulesets                     downloads EasyList + EasyPrivacy (needs internet), writes build/rulesets/
 *   node scripts/build-rulesets.mjs --fixture <dir>   tiny deterministic bundle for the end-to-end build (no network)
 *
 * The output is git-ignored. A normal `npm run build` includes it automatically when build/rulesets/ exists and ships
 * without bundled lists otherwise. Run this right before packaging a release so the snapshot date is as fresh as possible.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildBundle } from '../src/protection/adblock/bundle.ts';

const fixture = process.argv.includes('--fixture');
const outDir = new URL(`../${fixture ? process.argv[process.argv.indexOf('--fixture') + 1] : 'build/rulesets'}/`, import.meta.url);

const SOURCES = [
  { id: 'easylist', name: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt',
    license: 'GPL-3.0-or-later (gewählte Option der Doppellizenz GPLv3+ / CC BY-SA 3.0+)', attribution: 'The EasyList authors (https://easylist.to/)' },
  { id: 'easyprivacy', name: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt',
    license: 'GPL-3.0-or-later (gewählte Option der Doppellizenz GPLv3+ / CC BY-SA 3.0+)', attribution: 'The EasyList authors (https://easylist.to/)' }
];

const FIXTURE_TEXT = [
  '[Adblock Plus 2.0]', '! Version: 1', '! Title: AnoFox E2E fixture',
  '||anofox-t.net/bundled-ad.js', '||anofox-t.net/bundled-ok.js', '@@||anofox-t.net/bundled-ok.js',
  '##.bundled-ad', 'anofox-a.com##.bundled-site-ad'
].join('\n');

async function main() {
  const inputs = [];
  if (fixture) {
    inputs.push({ id: 'easylist', name: 'E2E-Fixture', sourceUrl: 'fixture://e2e', license: 'test', attribution: 'test', text: FIXTURE_TEXT,
      sha256: createHash('sha256').update(FIXTURE_TEXT).digest('hex'), fetchedAt: '2026-01-01T00:00:00.000Z' });
  } else {
    for (const s of SOURCES) {
      const res = await fetch(s.url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`${s.url}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      inputs.push({ id: s.id, name: s.name, sourceUrl: s.url, license: s.license, attribution: s.attribution,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), fetchedAt: new Date().toISOString() });
    }
  }
  const bundle = buildBundle(inputs);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const [id, rules] of Object.entries(bundle.rulesets)) await writeFile(new URL(`${id}.json`, outDir), JSON.stringify(rules));
  for (const [id, entries] of Object.entries(bundle.cosmetic)) await writeFile(new URL(`cosmetic-${id}.json`, outDir), JSON.stringify(entries));
  await writeFile(new URL('index.json', outDir), JSON.stringify(bundle.index, null, 2));
  for (const l of bundle.index.lists) console.log(`${l.id}: ${l.filters} filters -> ${l.rules} rules (${l.regexRules} regex), ${l.cosmetic} cosmetic, ${l.unsupported} unsupported, version ${l.version ?? '?'}`);
  console.log(`total ${bundle.index.totalRules}/30000 static rules, ${bundle.index.totalRegexRules}/1000 regex rules -> ${outDir.pathname}`);
}

main().catch((e) => { console.error('build-rulesets failed:', e.message); process.exit(1); });
