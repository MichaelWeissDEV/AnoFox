import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tokensCss } from './src/ui/tokens.mjs';

// `node build.mjs`          -> dist/       (the extension)
// `node build.mjs --e2e`    -> dist-e2e/   (same extension + test driver page, used only by test/firefox/e2e)
const e2e = process.argv.includes('--e2e');
const outdir = e2e ? 'dist-e2e' : 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [
    'src/background.ts',
    'src/popup.ts',
    'src/options.ts',
    'src/content-embed-guard.ts',
    'src/content-cosmetic.ts',
    'src/content-consent.ts',
    'src/blocked.ts'
  ],
  outdir,
  bundle: true,
  format: 'iife',
  target: 'es2022',
  define: { __E2E__: String(e2e) } // test-only hooks are compiled out of the real extension
});

await cp('public', outdir, { recursive: true });
// inject the contrast-tested design tokens into the shared stylesheet
const ui = await readFile('public/ui.css', 'utf8');
await writeFile(`${outdir}/ui.css`, ui.replace('/* @tokens */', tokensCss()));

// Bundled list snapshots (static rulesets): shipped only if `npm run build:rulesets` produced them. The E2E build uses a tiny
// deterministic fixture bundle instead (never the real lists), so tests do not depend on the network.
let rulesDir = process.env.ANOFOX_NO_BUNDLE ? null : 'build/rulesets';
if (e2e) {
  rulesDir = 'build/rulesets-e2e';
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/build-rulesets.mjs', '--fixture', rulesDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('fixture ruleset build failed');
}
if (rulesDir && existsSync(`${rulesDir}/index.json`)) {
  await cp(rulesDir, `${outdir}/rulesets`, { recursive: true });
  const index = JSON.parse(await readFile(`${rulesDir}/index.json`, 'utf8'));
  const manifest = JSON.parse(await readFile(`${outdir}/manifest.json`, 'utf8'));
  // enabled:false -> nothing is active until the user opts in
  manifest.declarative_net_request = { rule_resources: index.lists.map((l) => ({ id: l.rulesetId, enabled: false, path: `rulesets/${l.rulesetId}.json` })) };
  await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2));
}

if (e2e) {
  await build({ entryPoints: ['test/firefox/e2e/driver.ts'], outfile: `${outdir}/e2e-driver.js`, bundle: true, format: 'iife', target: 'es2022', define: { __E2E__: 'true' } });
  await cp('test/firefox/e2e/driver.html', `${outdir}/e2e-driver.html`);
  // test-only boot script (e2e build only): opens the driver page once the background is up
  // (the event page restarts whenever it was idle; boot exactly once per browser session)
  await writeFile(`${outdir}/e2e-boot.js`, "(async () => { const f = await browser.storage.session.get('e2eBooted'); if (f.e2eBooted) return; await browser.storage.session.set({ e2eBooted: true }); setTimeout(() => browser.tabs.create({ url: browser.runtime.getURL('e2e-driver.html') }), 1500); })();\n");
  const manifest = JSON.parse(await readFile(`${outdir}/manifest.json`, 'utf8'));
  manifest.background.scripts = [...manifest.background.scripts, 'e2e-boot.js'];
  // E2E_DROP_PERMS=a,b removes permissions in the test build only (used to prove which ones the extension really needs)
  const drop = (process.env.E2E_DROP_PERMS ?? '').split(',').filter(Boolean);
  manifest.permissions = manifest.permissions.filter((p) => !drop.includes(p));
  // optional permissions cannot be granted without a user prompt: the e2e build treats them as granted, unless E2E_KEEP_OPTIONAL=1
  if (!process.env.E2E_KEEP_OPTIONAL) { manifest.permissions = [...manifest.permissions, ...(manifest.optional_permissions ?? [])]; delete manifest.optional_permissions; }
  await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2));
}
