/**
 * Native Firefox privacy settings (browser.privacy.*), controlled through the module level of `fingerprint`.
 *
 * Principles (all verified against Firefox 158, see docs/architecture/fingerprinting-native.md):
 *  - These settings are BROWSER-WIDE, never per site. The UI must say so.
 *  - Read `levelOfControl` before every change; never fight another extension or an enterprise policy.
 *  - Never take control of a setting that already has the desired value (smaller footprint, no conflicts).
 *  - Give control back with `clear()`, never by `set(default)`: after set(default) the extension still
 *    "controls" the value (measured: levelOfControl stays controlled_by_this_extension).
 *  - Only clear what this extension actually controls.
 *  - Some settings are missing or not controllable in current Firefox; they are reported, not faked.
 */
import type { Level } from '../../core/policy-engine/policy.ts';

export type NativeSettingId =
  | 'resistFingerprinting' | 'webRTCIPHandlingPolicy' | 'referrersEnabled'
  | 'networkPredictionEnabled' | 'trackingProtectionMode' | 'hyperlinkAuditingEnabled';

export type LevelOfControl =
  | 'not_controllable' | 'controlled_by_other_extensions' | 'controllable_by_this_extension' | 'controlled_by_this_extension';

export interface NativeSettingDef {
  id: NativeSettingId;
  group: 'network' | 'websites';
  name: string;
  label: string;
  /** Visible side effects the user should know about. */
  sideEffects: string;
  /** Desired value per module level (undefined = leave alone). */
  byLevel: Partial<Record<Level, unknown>>;
  /** Value used when the user forces the setting "on" (true) – the level-independent protective value. */
  protective: unknown;
}

export const NATIVE_SETTINGS: readonly NativeSettingDef[] = [
  {
    id: 'resistFingerprinting', group: 'websites', name: 'resistFingerprinting', label: 'Firefox Fingerprinting-Schutz (resistFingerprinting)',
    sideEffects: 'Zeitzone wird UTC, helles Farbschema, gerundete/generische Fenstergröße, Canvas-Rauschen, generische GPU-Angabe. Kann Seiten, Karten und Zeitanzeigen stören.',
    byLevel: { strict: true, lockdown: true }, protective: true
  },
  {
    id: 'webRTCIPHandlingPolicy', group: 'network', name: 'webRTCIPHandlingPolicy', label: 'WebRTC-IP-Weitergabe',
    sideEffects: 'Strict: nur die öffentliche Schnittstelle. Lockdown: kein nicht-proxied UDP. Videoanrufe können fehlschlagen oder nur über Relays laufen.',
    byLevel: { strict: 'default_public_interface_only', lockdown: 'disable_non_proxied_udp' }, protective: 'default_public_interface_only'
  },
  {
    id: 'referrersEnabled', group: 'websites', name: 'referrersEnabled', label: 'Referer-Header senden',
    sideEffects: 'Aus: kein Referer mehr. Manche Seiten (Login, Hotlink-Schutz, CSRF-Prüfung) funktionieren dann nicht.',
    byLevel: { lockdown: false }, protective: false
  },
  {
    id: 'networkPredictionEnabled', group: 'network', name: 'networkPredictionEnabled', label: 'Vorab-Verbindungen (Prefetch/Preconnect)',
    sideEffects: 'Aus: minimal langsamere Seitenaufrufe.',
    byLevel: { strict: false, lockdown: false }, protective: false
  },
  {
    id: 'trackingProtectionMode', group: 'websites', name: 'trackingProtectionMode', label: 'Firefox Tracking-Schutz',
    sideEffects: 'Immer an (nicht nur in privaten Fenstern). Kann einzelne Seiten stören.',
    byLevel: { strict: 'always', lockdown: 'always' }, protective: 'always'
  },
  {
    id: 'hyperlinkAuditingEnabled', group: 'websites', name: 'hyperlinkAuditingEnabled', label: 'Hyperlink-Auditing (ping)',
    sideEffects: 'Aus: `ping`-Attribute werden nicht gesendet. In Firefox bereits standardmäßig aus.',
    byLevel: { balanced: false, strict: false, lockdown: false }, protective: false
  }
] as const;

/** User override per setting: 'auto' = follow the level, 'on' = protective value, 'off' = never touch. */
export type NativeOverride = 'auto' | 'on' | 'off';
export type NativeOverrides = Partial<Record<NativeSettingId, NativeOverride>>;

export interface PrivacyApi {
  get(group: string, name: string): Promise<{ value: unknown; levelOfControl: LevelOfControl } | null>; // null = API missing
  set(group: string, name: string, value: unknown): Promise<void>;
  clear(group: string, name: string): Promise<void>;
}

export type NativeAction = 'set' | 'clear' | 'keep' | 'skip-already' | 'blocked' | 'unavailable' | 'error';

export interface NativeStatus {
  id: NativeSettingId;
  label: string;
  sideEffects: string;
  desired?: unknown;
  current?: unknown;
  levelOfControl?: LevelOfControl;
  action: NativeAction;
  detail?: string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function desiredValue(def: NativeSettingDef, level: Level, override: NativeOverride | undefined): unknown {
  if (level === 'off' || override === 'off') return undefined;
  if (override === 'on') return def.protective;
  return def.byLevel[level];
}

/**
 * Reads the current state and decides what to do, without changing anything.
 */
export async function planNative(api: PrivacyApi, level: Level, overrides: NativeOverrides = {}): Promise<NativeStatus[]> {
  const out: NativeStatus[] = [];
  for (const def of NATIVE_SETTINGS) {
    const base = { id: def.id, label: def.label, sideEffects: def.sideEffects };
    let cur: Awaited<ReturnType<PrivacyApi['get']>>;
    try {
      cur = await api.get(def.group, def.name);
    } catch (e) {
      out.push({ ...base, action: 'error', detail: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!cur) { out.push({ ...base, action: 'unavailable', detail: 'In dieser Firefox-Version nicht vorhanden' }); continue; }
    const desired = desiredValue(def, level, overrides[def.id]);
    const st: NativeStatus = { ...base, desired, current: cur.value, levelOfControl: cur.levelOfControl, action: 'keep' };
    if (desired === undefined) {
      // nothing wanted: release only what we hold
      st.action = cur.levelOfControl === 'controlled_by_this_extension' ? 'clear' : 'keep';
    } else if (cur.levelOfControl === 'not_controllable' || cur.levelOfControl === 'controlled_by_other_extensions') {
      st.action = 'blocked';
      st.detail = cur.levelOfControl === 'not_controllable' ? 'Nicht steuerbar (Richtlinie oder Firefox)' : 'Von einer anderen Erweiterung gesteuert';
    } else if (same(cur.value, desired)) {
      // already the desired value: nothing to change (and no control taken if we do not hold it yet)
      st.action = cur.levelOfControl === 'controlled_by_this_extension' ? 'keep' : 'skip-already';
    } else {
      st.action = 'set';
    }
    out.push(st);
  }
  return out;
}

/**
 * Applies a plan. Errors per setting never abort the others and are reported in `detail`.
 */
export async function applyNative(api: PrivacyApi, plan: NativeStatus[]): Promise<NativeStatus[]> {
  const result: NativeStatus[] = [];
  for (const st of plan) {
    const def = NATIVE_SETTINGS.find((d) => d.id === st.id)!;
    try {
      if (st.action === 'set') {
        await api.set(def.group, def.name, st.desired);
        const after = await api.get(def.group, def.name);
        if (after && !same(after.value, st.desired)) {
          result.push({ ...st, action: 'blocked', current: after.value, levelOfControl: after.levelOfControl, detail: 'Wert wurde nicht übernommen' });
          continue;
        }
        result.push({ ...st, current: after?.value ?? st.desired, levelOfControl: after?.levelOfControl });
      } else if (st.action === 'clear') {
        await api.clear(def.group, def.name);
        const after = await api.get(def.group, def.name);
        result.push({ ...st, current: after?.value, levelOfControl: after?.levelOfControl });
      } else {
        result.push(st);
      }
    } catch (e) {
      result.push({ ...st, action: 'error', detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
