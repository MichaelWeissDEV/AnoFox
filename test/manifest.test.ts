import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));

// Every permission needs a documented reason (docs/architecture/permissions.md, README). Adding one must be a conscious change.
const ALLOWED_PERMISSIONS = ['storage', 'declarativeNetRequest', 'alarms', 'privacy', 'cookies', 'browsingData', 'tabs', 'scripting'];

test('permissions are exactly the documented set; nothing observes traffic by default', () => {
  assert.deepEqual([...manifest.permissions].sort(), [...ALLOWED_PERMISSIONS].sort());
  assert.deepEqual(manifest.optional_permissions, ['webRequest'], 'webRequest only as an optional permission (cleaned-URL counting)');
  assert.ok(!manifest.permissions.includes('declarativeNetRequestFeedback'), 'debug feedback is not needed (measured)');
  assert.ok(!manifest.permissions.some((p: string) => /webRequestBlocking|history|bookmarks|downloads|clipboard|geolocation|nativeMessaging|management|proxy/.test(p)));
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
});

test('manifest v3, minimum Firefox 140 (data_collection_permissions), no data collection declared', () => {
  assert.equal(manifest.manifest_version, 3);
  const gecko = manifest.browser_specific_settings.gecko;
  assert.ok(parseFloat(gecko.strict_min_version) >= 140, 'data_collection_permissions exists from Firefox 140');
  assert.deepEqual(gecko.data_collection_permissions, { required: ['none'] });
});

test('content scripts run on web pages only and the only web-accessible resource is the warning page', () => {
  for (const cs of manifest.content_scripts) {
    for (const m of cs.matches) assert.ok(m === 'http://*/*' || m === 'https://*/*', `content script match ${m}`);
  }
  assert.deepEqual(manifest.web_accessible_resources, [{ resources: ['blocked.html'], matches: ['<all_urls>'] }]);
  assert.equal(manifest.content_security_policy, undefined, 'default extension CSP (no unsafe-eval / remote code)');
});

test('icons exist and every script the manifest names is a build output', () => {
  assert.ok(manifest.icons['48'] && manifest.icons['96']);
  const built = ['background.js', 'content-embed-guard.js', 'content-cosmetic.js', 'content-consent.js'];
  const named = [...manifest.background.scripts, ...manifest.content_scripts.flatMap((c: { js: string[] }) => c.js)];
  for (const f of named) assert.ok(built.includes(f), `${f} must be produced by build.mjs`);
});
