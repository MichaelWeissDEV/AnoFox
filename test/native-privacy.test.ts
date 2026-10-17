import test from 'node:test';
import assert from 'node:assert/strict';
import { planNative, applyNative, desiredValue, NATIVE_SETTINGS } from '../src/protection/fingerprint/native.ts';
import type { PrivacyApi, LevelOfControl } from '../src/protection/fingerprint/native.ts';
import { normalizeSettings, defaultSettings } from '../src/core/settings/settings.ts';
import { PROFILE_LEVELS } from '../src/core/policy-engine/policy.ts';

interface Cell { value: unknown; defaultValue: unknown; control: LevelOfControl; held: boolean; rejects?: boolean }
function fakeApi(initial: Record<string, Partial<Cell> | 'missing'>) {
  const cells = new Map<string, Cell>();
  const calls: string[] = [];
  for (const d of NATIVE_SETTINGS) {
    const i = initial[d.id];
    if (i === 'missing') continue;
    cells.set(`${d.group}.${d.name}`, { value: i?.value ?? null, defaultValue: i?.value ?? null, control: i?.control ?? 'controllable_by_this_extension', held: false, rejects: i?.rejects });
  }
  const api: PrivacyApi = {
    async get(g, n) {
      const c = cells.get(`${g}.${n}`);
      if (!c) return null;
      const control: LevelOfControl = c.control === 'controllable_by_this_extension' && c.held ? 'controlled_by_this_extension' : c.control;
      return { value: c.value, levelOfControl: control };
    },
    async set(g, n, v) { calls.push(`set ${n}=${JSON.stringify(v)}`); const c = cells.get(`${g}.${n}`)!; if (c.control !== 'controllable_by_this_extension') return; if (c.rejects) throw new Error('rejected'); c.value = v; c.held = true; },
    async clear(g, n) { calls.push(`clear ${n}`); const c = cells.get(`${g}.${n}`)!; c.value = c.defaultValue; c.held = false; }
  };
  return { api, calls, cells };
}
const defaults = { resistFingerprinting: { value: false }, webRTCIPHandlingPolicy: { value: 'default' }, referrersEnabled: { value: true },
  networkPredictionEnabled: { value: true }, trackingProtectionMode: { value: 'private_browsing' }, hyperlinkAuditingEnabled: { value: false } };
const byId = (st: Awaited<ReturnType<typeof planNative>>) => Object.fromEntries(st.map((s) => [s.id, s]));

test('profile levels map to the intended native values', () => {
  const v = (level: 'balanced' | 'strict' | 'lockdown') => Object.fromEntries(NATIVE_SETTINGS.map((d) => [d.id, desiredValue(d, level, undefined)]));
  assert.deepEqual(v('balanced'), { resistFingerprinting: undefined, webRTCIPHandlingPolicy: undefined, referrersEnabled: undefined, networkPredictionEnabled: undefined, trackingProtectionMode: undefined, hyperlinkAuditingEnabled: false });
  assert.equal(v('strict').resistFingerprinting, true);
  assert.equal(v('strict').webRTCIPHandlingPolicy, 'default_public_interface_only');
  assert.equal(v('strict').referrersEnabled, undefined, 'strict keeps Referer (breaks too many sites)');
  assert.equal(v('lockdown').webRTCIPHandlingPolicy, 'disable_non_proxied_udp');
  assert.equal(v('lockdown').referrersEnabled, false);
  assert.equal(PROFILE_LEVELS.strict.fingerprint, 'strict');
  const rfp = NATIVE_SETTINGS[0];
  assert.equal(desiredValue(rfp, 'off', 'on'), undefined, 'module off beats override');
  assert.equal(desiredValue(rfp, 'balanced', 'on'), true);
  assert.equal(desiredValue(rfp, 'lockdown', 'off'), undefined);
});

test('plan never takes control of values that already match, and never touches the unchanged', async () => {
  const { api } = fakeApi(defaults);
  const plan = byId(await planNative(api, 'balanced'));
  assert.equal(plan.hyperlinkAuditingEnabled.action, 'skip-already');
  assert.equal(plan.resistFingerprinting.action, 'keep');
  const strict = byId(await planNative(api, 'strict'));
  assert.equal(strict.resistFingerprinting.action, 'set');
  assert.equal(strict.networkPredictionEnabled.action, 'set');
  assert.equal(strict.referrersEnabled.action, 'keep');
});

test('apply sets values, verifies them, and releases control with clear() when the level drops', async () => {
  const f = fakeApi(defaults);
  let res = await applyNative(f.api, await planNative(f.api, 'strict'));
  assert.equal(f.cells.get('websites.resistFingerprinting')!.value, true);
  assert.equal(res.find((r) => r.id === 'resistFingerprinting')!.levelOfControl, 'controlled_by_this_extension');
  f.calls.length = 0;
  // stable: second pass does nothing
  res = await applyNative(f.api, await planNative(f.api, 'strict'));
  assert.deepEqual(f.calls, []);
  // back to balanced: everything we hold is cleared (not set to default), nothing else touched
  res = await applyNative(f.api, await planNative(f.api, 'balanced'));
  assert.ok(f.calls.every((c) => c.startsWith('clear ')), f.calls.join());
  assert.equal(f.cells.get('websites.resistFingerprinting')!.value, false);
  assert.equal(f.cells.get('websites.resistFingerprinting')!.held, false);
  assert.ok(!f.calls.includes('clear hyperlinkAuditingEnabled'), 'never held, never cleared');
});

test('settings controlled elsewhere or not controllable are reported as blocked and left alone', async () => {
  const f = fakeApi({ ...defaults, resistFingerprinting: { value: false, control: 'controlled_by_other_extensions' }, webRTCIPHandlingPolicy: { value: 'default', control: 'not_controllable' } });
  const plan = byId(await planNative(f.api, 'strict'));
  assert.equal(plan.resistFingerprinting.action, 'blocked');
  assert.equal(plan.webRTCIPHandlingPolicy.action, 'blocked');
  await applyNative(f.api, Object.values(plan));
  assert.ok(!f.calls.some((c) => c.includes('resistFingerprinting') || c.includes('webRTC')));
  // and we never clear what we do not hold
  const off = await applyNative(f.api, await planNative(f.api, 'off'));
  assert.ok(!f.calls.some((c) => c.startsWith('clear resistFingerprinting')));
  assert.equal(off.find((r) => r.id === 'resistFingerprinting')!.action, 'keep');
});

test('missing APIs, rejected writes and unexpected values are reported, not hidden', async () => {
  const f = fakeApi({ ...defaults, trackingProtectionMode: 'missing', referrersEnabled: { value: true, rejects: true } });
  const plan = await planNative(f.api, 'lockdown');
  assert.equal(byId(plan).trackingProtectionMode.action, 'unavailable');
  const res = byId(await applyNative(f.api, plan));
  assert.equal(res.referrersEnabled.action, 'error');
  assert.equal(res.referrersEnabled.detail, 'rejected');
  assert.equal(res.resistFingerprinting.action, 'set', 'one failure does not stop the others');
  // set is silently ignored by the browser (value stays) -> reported blocked
  const g = fakeApi({ ...defaults, networkPredictionEnabled: { value: true, control: 'controllable_by_this_extension' } });
  const origSet = g.api.set; g.api.set = async (grp, n, v) => { if (n === 'networkPredictionEnabled') return; await origSet(grp, n, v); };
  const r2 = byId(await applyNative(g.api, await planNative(g.api, 'strict')));
  assert.equal(r2.networkPredictionEnabled.action, 'blocked');
});

test('overrides are validated and "auto" is not stored', () => {
  const s = normalizeSettings({ nativeOverrides: { resistFingerprinting: 'on', referrersEnabled: 'off', trackingProtectionMode: 'auto', bogus: 'on', webRTCIPHandlingPolicy: 'sometimes' } });
  assert.deepEqual(s.nativeOverrides, { resistFingerprinting: 'on', referrersEnabled: 'off' });
  assert.deepEqual(defaultSettings().nativeOverrides, {});
  assert.deepEqual(normalizeSettings({ nativeOverrides: 'x' }).nativeOverrides, {});
});
