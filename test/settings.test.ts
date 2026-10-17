import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSettings, normalizeSettings, migrateSettings, exportSettings, parseImport, SETTINGS_SCHEMA_VERSION
} from '../src/core/settings/settings.ts';

test('legacy flat settings (no schemaVersion) migrate to current schema', () => {
  const r = migrateSettings({ enabled: false, exceptions: ['https://Example.com/x'], theme: 'light' });
  assert.equal(r.fromVersion, 0);
  assert.equal(r.migrated, true);
  assert.equal(r.settings.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(r.settings.enabled, false);
  assert.deepEqual(r.settings.exceptions, ['example.com']);
  assert.equal(r.settings.theme, 'light');
  assert.equal(r.settings.socialEmbedsEnabled, true); // default kept
});

test('corrupt values fall back to safe defaults', () => {
  const s = normalizeSettings({
    enabled: 'yes', exceptions: 'x', logSeverity: 'LOUD', theme: 42,
    socialEmbedProviders: { youtube: 'no', vimeo: false, evil: true }, __proto__: { polluted: 1 }
  });
  const d = defaultSettings();
  assert.equal(s.enabled, d.enabled);
  assert.deepEqual(s.exceptions, []);
  assert.equal(s.logSeverity, d.logSeverity);
  assert.equal(s.theme, d.theme);
  assert.equal(s.socialEmbedProviders.youtube, true);
  assert.equal(s.socialEmbedProviders.vimeo, false);
  assert.equal('evil' in s.socialEmbedProviders, false);
  assert.equal(migrateSettings(null).settings.enabled, true);
  assert.equal(migrateSettings([1, 2]).settings.enabled, true);
});

test('newer schema is validated, flagged and not rewritten', () => {
  const r = migrateSettings({ schemaVersion: 99, enabled: false });
  assert.equal(r.fromFuture, true);
  assert.equal(r.migrated, false);
  assert.equal(r.settings.enabled, false);
});

test('export/import round trip and legacy bare import', () => {
  const s = normalizeSettings({ enabled: false, exceptions: ['a.example'] });
  const back = parseImport(exportSettings(s));
  assert.ok(back.ok && back.settings.enabled === false && back.settings.exceptions[0] === 'a.example');
  const legacy = parseImport(JSON.stringify({ enabled: false }));
  assert.ok(legacy.ok && legacy.settings.enabled === false);
  assert.equal(parseImport('not json').ok, false);
  assert.equal(parseImport('[]').ok, false);
  assert.equal(parseImport('x'.repeat(1_000_001)).ok, false);
});

test('defaultSettings returns independent copies', () => {
  const a = defaultSettings(); a.exceptions.push('x.y'); a.socialEmbedProviders.youtube = false;
  const b = defaultSettings();
  assert.deepEqual(b.exceptions, []);
  assert.equal(b.socialEmbedProviders.youtube, true);
});

test('site policies and grace are validated; unknown values never become persistent', async () => {
  const { normalizeSettings } = await import('../src/core/settings/settings.ts');
  const s = normalizeSettings({ sitePolicies: { 'Bank.Example.org': 'persistent', 'co.uk': 'persistent', 'x.test': 'whatever', 'a.example': 'ephemeral' }, storageGraceMs: 1e12 });
  assert.deepEqual(s.sitePolicies, { 'bank.example.org': 'persistent', 'a.example': 'ephemeral' });
  assert.equal(s.storageGraceMs, 24 * 3600_000);
  assert.deepEqual(normalizeSettings({ sitePolicies: 'nope' }).sitePolicies, {});
  assert.equal(normalizeSettings({}).storageGraceMs, 60_000);
});
