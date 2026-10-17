/**
 * Versioned settings schema: defaults, validation and migration.
 * Pure functions only (no browser APIs) so they are unit-testable and shared by
 * background, UI and import/export.
 */

import { sanitizeDomainList } from '../domain-utils/domains.ts';
import { DEFAULT_PROVIDERS } from '../../embed-guard.ts';
import type { SocialEmbedProviders } from '../../embed-guard.ts';
import type { LogSeverity } from '../../logger.ts';
import type { NativeOverrides, NativeOverride } from '../../protection/fingerprint/native.ts';
import { sanitizeSitePolicies, clampGrace, DEFAULT_GRACE_MS } from '../../protection/storage/model.ts';
import type { SitePolicies } from '../../protection/storage/model.ts';
import { MODULE_ORDER, PROFILE_LEVELS } from '../policy-engine/policy.ts';
import type { Levels, Level, ModuleId, ProfileId, UserRule, Duration } from '../policy-engine/policy.ts';

export type ThemePreference = 'system' | 'dark' | 'light';

/** Bump when the stored shape changes and add a step to MIGRATIONS. */
export const SETTINGS_SCHEMA_VERSION = 2;

export interface AnoFoxSettings {
  schemaVersion: number;
  enabled: boolean;
  exceptions: string[];
  terminalLogging: boolean;
  logSeverity: LogSeverity;
  socialEmbedsEnabled: boolean;
  socialEmbedExceptions: string[];
  socialEmbedProviders: SocialEmbedProviders;
  theme: ThemePreference;
  statsEnabled: boolean;
  /**
   * Policy Engine state. `enabled` / `socialEmbedsEnabled` act as per-module kill switches on top of the
   * profile (tracking module / social module are forced off when their switch is off).
   */
  profile: ProfileId;
  customLevels: Levels;
  rules: UserRule[];
  /** Per native Firefox setting: follow the level (auto), force protective value (on) or never touch (off). */
  nativeOverrides: NativeOverrides;
  /** Cookie Vault: policy per host or registrable domain (most specific entry wins). */
  sitePolicies: SitePolicies;
  storageGraceMs: number;
}

export const DEFAULT_SETTINGS: AnoFoxSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  enabled: true,
  exceptions: [],
  terminalLogging: true,
  logSeverity: 'INFO',
  socialEmbedsEnabled: true,
  socialEmbedExceptions: [],
  socialEmbedProviders: { ...DEFAULT_PROVIDERS },
  theme: 'dark',
  statsEnabled: false,
  profile: 'balanced',
  customLevels: { ...PROFILE_LEVELS.balanced },
  rules: [],
  nativeOverrides: {},
  sitePolicies: {},
  storageGraceMs: DEFAULT_GRACE_MS
};

const SEVERITIES: readonly string[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'OFF'];
const THEMES: readonly string[] = ['system', 'dark', 'light'];
const MAX_DOMAINS = 2000;

export function defaultSettings(): AnoFoxSettings {
  return { ...DEFAULT_SETTINGS, exceptions: [], socialEmbedExceptions: [], socialEmbedProviders: { ...DEFAULT_PROVIDERS }, customLevels: { ...PROFILE_LEVELS.balanced }, rules: [], nativeOverrides: {}, sitePolicies: {}, storageGraceMs: DEFAULT_GRACE_MS };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function domainList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  return sanitizeDomainList(v.filter((x): x is string => typeof x === 'string').slice(0, MAX_DOMAINS));
}

const PROFILES: readonly string[] = ['balanced', 'strict', 'lockdown', 'custom'];
const LEVELS: readonly string[] = ['off', 'balanced', 'strict', 'lockdown'];
const DURATIONS: readonly string[] = ['once', 'tab', 'session', 'permanent'];
const MAX_RULES = 2000;
const NATIVE_IDS = ['resistFingerprinting', 'webRTCIPHandlingPolicy', 'referrersEnabled', 'networkPredictionEnabled', 'trackingProtectionMode', 'hyperlinkAuditingEnabled'];
const NATIVE_OVERRIDES: readonly string[] = ['auto', 'on', 'off'];

function normalizeNativeOverrides(v: unknown, fallback: NativeOverrides): NativeOverrides {
  if (!isRecord(v)) return fallback;
  const out: NativeOverrides = {};
  for (const id of NATIVE_IDS) {
    const o = v[id];
    if (typeof o === 'string' && NATIVE_OVERRIDES.includes(o) && o !== 'auto') (out as Record<string, NativeOverride>)[id] = o as NativeOverride;
  }
  return out;
}

function normalizeLevels(v: unknown, base: Levels): Levels {
  const out = { ...base };
  if (isRecord(v)) {
    for (const m of MODULE_ORDER) {
      const l = v[m];
      if (typeof l === 'string' && LEVELS.includes(l)) out[m] = l as Level;
    }
  }
  return out;
}

function normalizeRule(v: unknown): UserRule | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== 'string' || v.id.length === 0 || v.id.length > 64) return null;
  if (typeof v.module !== 'string' || !(MODULE_ORDER as readonly string[]).includes(v.module)) return null;
  if (v.effect !== 'allow' && v.effect !== 'block') return null;
  if (typeof v.duration !== 'string' || !DURATIONS.includes(v.duration)) return null;
  let scope: UserRule['scope'] = { kind: 'global' };
  if (isRecord(v.scope) && v.scope.kind === 'site') {
    const site = typeof v.scope.site === 'string' ? sanitizeDomainList([v.scope.site])[0] : undefined;
    if (!site) return null; // a site rule without a valid site must not silently become global
    scope = { kind: 'site', site };
  } else if (isRecord(v.scope) && v.scope.kind !== 'global') {
    return null;
  }
  const rule: UserRule = {
    id: v.id, module: v.module as ModuleId, scope, effect: v.effect, duration: v.duration as Duration,
    createdAt: typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) ? v.createdAt : 0
  };
  if (v.target !== undefined) {
    const t = typeof v.target === 'string' ? sanitizeDomainList([v.target])[0] : undefined;
    if (!t) return null;
    rule.target = t;
  }
  if (typeof v.tabId === 'number' && Number.isInteger(v.tabId)) rule.tabId = v.tabId;
  if (typeof v.expiresAt === 'number' && Number.isFinite(v.expiresAt)) rule.expiresAt = v.expiresAt;
  if (typeof v.cookieStoreId === 'string' && v.cookieStoreId.length <= 128) rule.cookieStoreId = v.cookieStoreId;
  return rule;
}

function normalizeRules(v: unknown, fallback: UserRule[]): UserRule[] {
  if (!Array.isArray(v)) return fallback;
  const seen = new Set<string>();
  const out: UserRule[] = [];
  for (const item of v.slice(0, MAX_RULES)) {
    const r = normalizeRule(item);
    if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
  }
  return out;
}

/**
 * Validates untrusted input (storage, import file, runtime message) field by field.
 * Unknown keys are dropped; invalid fields fall back to `base` (default: safe defaults).
 */
export function normalizeSettings(raw: unknown, base: AnoFoxSettings = defaultSettings()): AnoFoxSettings {
  if (!isRecord(raw)) return base;
  const providers: SocialEmbedProviders = { ...base.socialEmbedProviders };
  if (isRecord(raw.socialEmbedProviders)) {
    for (const key of Object.keys(DEFAULT_PROVIDERS) as Array<keyof SocialEmbedProviders>) {
      const value = raw.socialEmbedProviders[key];
      if (typeof value === 'boolean') providers[key] = value;
    }
  }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    exceptions: domainList(raw.exceptions, base.exceptions),
    terminalLogging: typeof raw.terminalLogging === 'boolean' ? raw.terminalLogging : base.terminalLogging,
    logSeverity: typeof raw.logSeverity === 'string' && SEVERITIES.includes(raw.logSeverity)
      ? (raw.logSeverity as LogSeverity) : base.logSeverity,
    socialEmbedsEnabled: typeof raw.socialEmbedsEnabled === 'boolean' ? raw.socialEmbedsEnabled : base.socialEmbedsEnabled,
    socialEmbedExceptions: domainList(raw.socialEmbedExceptions, base.socialEmbedExceptions),
    socialEmbedProviders: providers,
    theme: typeof raw.theme === 'string' && THEMES.includes(raw.theme) ? (raw.theme as ThemePreference) : base.theme,
    statsEnabled: typeof raw.statsEnabled === 'boolean' ? raw.statsEnabled : base.statsEnabled,
    profile: typeof raw.profile === 'string' && PROFILES.includes(raw.profile) ? (raw.profile as ProfileId) : base.profile,
    customLevels: normalizeLevels(raw.customLevels, base.customLevels),
    rules: normalizeRules(raw.rules, base.rules),
    nativeOverrides: normalizeNativeOverrides(raw.nativeOverrides, base.nativeOverrides),
    sitePolicies: raw.sitePolicies === undefined ? base.sitePolicies : sanitizeSitePolicies(raw.sitePolicies),
    storageGraceMs: raw.storageGraceMs === undefined ? base.storageGraceMs : clampGrace(raw.storageGraceMs)
  };
}

/** Each step upgrades from version N to N+1 on the raw object. */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  // 0 -> 1: legacy flat keys without schemaVersion; shape is identical, version is added.
  0: (raw) => ({ ...raw }),
  // 1 -> 2: adds profile / customLevels / rules; absent keys take safe defaults in normalizeSettings.
  1: (raw) => ({ ...raw })
};

export interface MigrationResult {
  settings: AnoFoxSettings;
  fromVersion: number;
  migrated: boolean;
  /** true if the stored version is newer than this build understands (downgrade); values are validated, not migrated */
  fromFuture: boolean;
}

export function migrateSettings(raw: unknown): MigrationResult {
  if (!isRecord(raw)) {
    return { settings: defaultSettings(), fromVersion: 0, migrated: false, fromFuture: false };
  }
  const v = typeof raw.schemaVersion === 'number' && Number.isInteger(raw.schemaVersion) && raw.schemaVersion >= 0
    ? raw.schemaVersion : 0;
  if (v > SETTINGS_SCHEMA_VERSION) {
    return { settings: normalizeSettings(raw), fromVersion: v, migrated: false, fromFuture: true };
  }
  let current: Record<string, unknown> = raw;
  for (let step = v; step < SETTINGS_SCHEMA_VERSION; step++) {
    const fn = MIGRATIONS[step];
    if (!fn) throw new Error(`Keine Migration von Schema ${step}`);
    current = fn(current);
  }
  return { settings: normalizeSettings(current), fromVersion: v, migrated: v < SETTINGS_SCHEMA_VERSION, fromFuture: false };
}

/** Export envelope; import accepts it or a bare settings object (legacy backups). */
export function exportSettings(settings: AnoFoxSettings): string {
  return JSON.stringify({ format: 'anofox-settings', schemaVersion: SETTINGS_SCHEMA_VERSION, settings }, null, 2);
}

export function parseImport(text: string): { ok: true; settings: AnoFoxSettings } | { ok: false; error: string } {
  if (text.length > 1_000_000) return { ok: false, error: 'Datei zu groß' };
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'Kein gültiges JSON' }; }
  if (!isRecord(data)) return { ok: false, error: 'Unerwartetes Format' };
  const payload = data.format === 'anofox-settings' && isRecord(data.settings) ? data.settings : data;
  try {
    return { ok: true, settings: migrateSettings(payload).settings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Migration fehlgeschlagen' };
  }
}
