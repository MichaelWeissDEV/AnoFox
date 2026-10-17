/**
 * AnoFox Background Service
 * Manages DeclarativeNetRequest dynamic rules, website exceptions,
 * Social Embed Guard blocking & click-to-load unblocking,
 * redirect loop protection, and terminal logging of privacy events.
 */

import { cleanUrlDetailed } from './url-cleaner.ts';
import { logger, LogSeverity } from './logger.ts';
import {
  syncDnrRules,
  syncPolicySessionRules,
  replaceListRules,
  listRuleBudget,
  loopGuard,
  sanitizeDomainList,
  allowEmbedTemporarily
} from './dnr-manager.ts';
import {
  DEFAULT_PROVIDERS
} from './embed-guard.ts';
import type { SocialEmbedProviders } from './embed-guard.ts';
import { privacyStats } from './stats.ts';

import { effectiveConsentMode } from './protection/consent/mode.ts';
import type { ConsentModeSetting } from './protection/consent/mode.ts';
import { ADAPTERS } from './protection/consent/adapters.ts';
import { getThreatSource } from './protection/threat/sources.ts';
import { createThreatService } from './browser/background/threat-service.ts';
import { createStorageService } from './browser/background/storage-service.ts';
import { planNative, applyNative } from './protection/fingerprint/native.ts';
import type { PrivacyApi, NativeStatus } from './protection/fingerprint/native.ts';
import { ListManager } from './protection/adblock/manager.ts';
import { LIST_SOURCES } from './protection/adblock/sources.ts';
import { CosmeticIndex, buildCss } from './protection/adblock/cosmetic.ts';
import { createStaticRulesetService } from './browser/background/static-rulesets.ts';
import { planDnr, policyStateOf } from './core/policy-engine/apply.ts';
import { pruneRules, effectiveLevels, pickRule } from './core/policy-engine/policy.ts';
import { DEFAULT_SETTINGS, defaultSettings, migrateSettings, normalizeSettings, parseImport } from './core/settings/settings.ts';
import type { AnoFoxSettings, ThemePreference } from './core/settings/settings.ts';

export { DEFAULT_SETTINGS };
export type { AnoFoxSettings, ThemePreference };

// Resolves once persisted settings are loaded and DNR rules are applied
let ready: Promise<void> = Promise.resolve();

// In-memory active settings
let activeSettings: AnoFoxSettings = defaultSettings();

// Cache to prevent duplicate log outputs for the same request
const recentlyLoggedUrls = new Map<string, number>();
const LOG_DEDUPLICATION_TTL_MS = 2500;

function isRecentlyLogged(url: string): boolean {
  const now = Date.now();
  // Clean expired entries
  for (const [cachedUrl, timestamp] of recentlyLoggedUrls.entries()) {
    if (now - timestamp > LOG_DEDUPLICATION_TTL_MS) {
      recentlyLoggedUrls.delete(cachedUrl);
    }
  }

  if (recentlyLoggedUrls.has(url)) {
    return true;
  }
  recentlyLoggedUrls.set(url, now);
  return false;
}

/**
 * Pushes the current settings to declarativeNetRequest. Serialized so overlapping
 * updates (message handlers + storage.onChanged) cannot interleave their rule updates.
 */
let policyQueue: Promise<unknown> = Promise.resolve();
let unsupportedPolicyRules: Array<{ ruleId: string; reason: string }> = [];
function applyPolicy(): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const plan = planDnr(activeSettings, Date.now(), new URL(browser.runtime.getURL('')).hostname);
    unsupportedPolicyRules = plan.unsupported;
    const okDynamic = await syncDnrRules(plan.options);
    const okSession = await syncPolicySessionRules(plan.session);
    await syncNative().catch((e) => logger.error('Native Einstellungen fehlgeschlagen:', e));
    await threatService.sync();
    await staticRulesets.sync();
    return okDynamic && okSession;
  };
  const next = policyQueue.then(run, run);
  policyQueue = next.catch(() => false);
  return next;
}

/**
 * Drops user rules that can no longer apply: expired ones and, on a fresh browser session,
 * 'session' and 'tab' rules. storage.session survives event-page suspension but not a browser restart.
 */
async function pruneRulesForSession(): Promise<void> {
  let sessionEnded = false;
  try {
    const flag = await browser.storage.session.get('anofoxSessionActive');
    if (!flag.anofoxSessionActive) {
      sessionEnded = true;
      await browser.storage.session.set({ anofoxSessionActive: true });
    }
  } catch (e) {
    logger.debug('storage.session nicht verfügbar:', e);
  }
  const pruned = pruneRules(activeSettings.rules, Date.now(), { sessionEnded, openTabIds: sessionEnded ? new Set() : undefined });
  if (pruned.length !== activeSettings.rules.length) {
    activeSettings.rules = pruned;
    await browser.storage.local.set({ rules: pruned });
  }
}

/** Persists rule changes and re-applies DNR. Rolls the in-memory state back if storage fails. */
async function commitRules(rules: AnoFoxSettings['rules']): Promise<void> {
  const previous = activeSettings.rules;
  activeSettings.rules = rules;
  try {
    await browser.storage.local.set({ rules });
  } catch (e) {
    activeSettings.rules = previous;
    throw e;
  }
  await applyPolicy();
}

const staticRulesets = createStaticRulesetService(() => activeSettings, () => { cosmeticIndexPromise = null; });

// ---- Filter lists (opt-in, default off) -------------------------------------------------------
const listManager = new ListManager({
  updater: {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sha256: async (bytes) => {
      const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    }
  },
  storage: {
    get: async (key) => (await browser.storage.local.get(key))[key],
    set: (items) => browser.storage.local.set(items),
    remove: (keys) => browser.storage.local.remove(keys)
  },
  applyRules: (rules) => replaceListRules(rules as browser.declarativeNetRequest.Rule[]),
  ruleBudget: listRuleBudget,
  onChanged: () => { cosmeticIndexPromise = null; },
  regexSupported: async (regex, caseSensitive) => {
    try {
      const res = await browser.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive: caseSensitive });
      return res.isSupported;
    } catch {
      return false;
    }
  }
});

// ---- Cosmetic filtering (lists' element-hiding rules) --------------------------------------------
let cosmeticIndexPromise: Promise<CosmeticIndex> | null = null;
function getCosmeticIndex(): Promise<CosmeticIndex> {
  if (!cosmeticIndexPromise) {
    cosmeticIndexPromise = Promise.all([listManager.getCosmeticFilters(), staticRulesets.cosmeticFilters()]).then(([a, b]) => new CosmeticIndex([...a, ...b]));
    cosmeticIndexPromise.catch(() => { cosmeticIndexPromise = null; });
  }
  return cosmeticIndexPromise;
}

interface CosmeticTarget { tabId: number; frameId: number; frameHost: string; topHost: string }

function cosmeticTarget(sender: browser.runtime.MessageSender): CosmeticTarget | null {
  if (typeof sender.tab?.id !== 'number' || typeof sender.frameId !== 'number' || !sender.url || !sender.tab.url) return null;
  try {
    const frame = new URL(sender.url);
    const top = new URL(sender.tab.url);
    if (!['http:', 'https:'].includes(frame.protocol) || !['http:', 'https:'].includes(top.protocol)) return null;
    return { tabId: sender.tab.id, frameId: sender.frameId, frameHost: frame.hostname.toLowerCase(), topHost: top.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

/** Cosmetic filtering is skipped when the adblock module is off or the user paused it for this site/tab. */
function cosmeticAllowed(t: CosmeticTarget): boolean {
  if (effectiveLevels(policyStateOf(activeSettings)).adblock === 'off') return false;
  const rule = pickRule(activeSettings.rules, 'adblock', {
    topHost: t.topHost, targetUrl: `https://${t.topHost}/`, resourceType: 'main_frame', tabId: t.tabId
  }, t.topHost, Date.now());
  return !(rule && rule.effect === 'allow');
}

async function injectHidingCss(t: CosmeticTarget, selectors: string[]): Promise<void> {
  const css = buildCss(selectors);
  if (!css) return;
  await browser.scripting.insertCSS({ target: { tabId: t.tabId, frameIds: [t.frameId] }, css, origin: 'USER' });
}

// ---- Native Firefox privacy settings (browser-wide) -------------------------------------------------
const privacyApi: PrivacyApi = {
  async get(group, name) {
    const api = (browser.privacy as unknown as Record<string, Record<string, { get(d: object): Promise<{ value: unknown; levelOfControl: string }> } | undefined>>)[group]?.[name];
    if (!api) return null;
    const r = await api.get({});
    return { value: r.value, levelOfControl: r.levelOfControl as never };
  },
  async set(group, name, value) {
    const api = (browser.privacy as unknown as Record<string, Record<string, { set(d: object): Promise<unknown> }>>)[group][name];
    await api.set({ value });
  },
  async clear(group, name) {
    const api = (browser.privacy as unknown as Record<string, Record<string, { clear(d: object): Promise<unknown> }>>)[group][name];
    await api.clear({});
  }
};
let nativeStatus: NativeStatus[] = [];

async function syncNative(): Promise<void> {
  if (!browser.privacy) return;
  const level = effectiveLevels(policyStateOf(activeSettings)).fingerprint;
  const plan = await planNative(privacyApi, level, activeSettings.nativeOverrides);
  nativeStatus = await applyNative(privacyApi, plan);
  for (const s of nativeStatus) {
    if (s.action === 'error' || s.action === 'blocked') logger.warn(`Native Einstellung ${s.id}: ${s.action} (${s.detail ?? ''})`);
  }
}

// ---- Cookie Vault / storage cleanup ---------------------------------------------------------------
const storageService = createStorageService(() => activeSettings);
const STORAGE_ALARM = 'anofox-storage-cleanup';

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    void ready.then(() => storageService.onTabUpdated(tabId, tab.url, tab.cookieStoreId)).catch((e) => logger.error('Storage-Tabverfolgung fehlgeschlagen:', e));
  }
});
browser.tabs.onRemoved.addListener((tabId) => {
  void ready.then(() => storageService.onTabRemoved(tabId)).catch((e) => logger.error('Storage-Bereinigung fehlgeschlagen:', e));
});
browser.runtime.onStartup.addListener(() => {
  void ready.then(() => storageService.onBrowserStart()).catch((e) => logger.error('Start-Bereinigung fehlgeschlagen:', e));
});
if (browser.alarms) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === STORAGE_ALARM) void ready.then(() => storageService.processQueue()).catch((e) => logger.error('Bereinigungswarteschlange fehlgeschlagen:', e));
  });
}

// ---- Phishing / malware protection ------------------------------------------------------------------
declare const __E2E__: boolean;
let consentStatsQueue: Promise<unknown> = Promise.resolve();
const threatService = createThreatService(() => activeSettings);
const THREAT_ALARM = 'anofox-threat-check';
if (browser.alarms) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === THREAT_ALARM) {
      void ready.then(async () => { await threatService.pruneBypass(); await threatService.refresh(false); }).catch((e) => logger.error('Threat-Listen fehlgeschlagen:', e));
    }
  });
}

const LIST_ALARM = 'anofox-list-check';
if (browser.alarms) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== LIST_ALARM) return;
    void ready.then(() => listManager.refresh()).catch((e) => logger.error('Listenaktualisierung fehlgeschlagen:', e));
  });
}

async function ensureListAlarm(): Promise<void> {
  if (!browser.alarms) return;
  const existing = await browser.alarms.get(LIST_ALARM);
  if (!existing) browser.alarms.create(LIST_ALARM, { delayInMinutes: 5, periodInMinutes: 60 });
  if (!(await browser.alarms.get(THREAT_ALARM))) browser.alarms.create(THREAT_ALARM, { delayInMinutes: 2, periodInMinutes: 30 });
  if (!(await browser.alarms.get(STORAGE_ALARM))) browser.alarms.create(STORAGE_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
}

/**
 * Loads settings from local storage and initializes DNR rules & logger.
 */
async function initializeSettings(): Promise<void> {
  try {
    const stored = await browser.storage.local.get(null);
    const migration = migrateSettings(stored);
    activeSettings = migration.settings;
    if (migration.fromFuture) {
      logger.warn(`Gespeicherte Einstellungen stammen aus neuerem Schema ${migration.fromVersion}; werte validiert übernommen.`);
    } else if (migration.migrated) {
      // Persist the upgraded shape only after successful validation
      await browser.storage.local.set(activeSettings);
    }

    await pruneRulesForSession();
    void ensureListAlarm();

    // Apply logger config & internal logging
    logger.setConfig({
      terminalLogging: activeSettings.terminalLogging,
      severity: activeSettings.logSeverity,
      internalLogging: activeSettings.statsEnabled
    });

    // Apply privacy stats state (strictly in-memory)
    privacyStats.setEnabled(activeSettings.statsEnabled);

    // Synchronize declarativeNetRequest dynamic rules
    await applyPolicy();

    logger.debug('AnoFox initialisiert mit Einstellungen:', activeSettings);
  } catch (error) {
    logger.error('Fehler bei der Initialisierung von AnoFox:', error);
  }
}

/**
 * Handles detection and logging when a URL was cleaned by DNR.
 */
function handleCleanedEvent(originalUrl: string, destinationUrl?: string): void {
  if (isRecentlyLogged(originalUrl)) {
    return;
  }

  try {
    const urlObj = new URL(originalUrl);
    const host = urlObj.hostname;

    // Check redirect loop guard
    if (!loopGuard.checkAndRecord(host)) {
      // Loop guard warned and blocked
      return;
    }

    const check = cleanUrlDetailed(originalUrl, { exceptions: activeSettings.exceptions });
    if (check.wasCleaned && check.removedParams.length > 0) {
      const targetUrl = destinationUrl || check.cleanedUrl;
      logger.logUrlCleaned(originalUrl, targetUrl, check.removedParams);
      privacyStats.recordUrlCleaned(host, originalUrl, check.removedParams);
    }
  } catch (e) {
    logger.debug('Fehler bei der Analyse der bereinigten URL:', e);
  }
}

// 1. Count/log cleaned URLs. This needs the OPTIONAL `webRequest` permission (observation only, no blocking): Firefox reports the
// DNR queryTransform redirect through webRequest.onBeforeRedirect (verified in the end-to-end suite). Without the permission AnoFox
// works unchanged, it just cannot count cleaned URLs. `declarativeNetRequestFeedback` is not needed and is not requested.
type RedirectDetails = { url: string; redirectUrl?: string };
const onRedirect = (details: RedirectDetails): void => {
  if (details.url && details.redirectUrl && details.url !== details.redirectUrl) {
    const check = cleanUrlDetailed(details.url, { exceptions: activeSettings.exceptions });
    if (check.wasCleaned) handleCleanedEvent(details.url, details.redirectUrl);
  }
};

function setRedirectLogging(on: boolean): void {
  const ev = browser.webRequest?.onBeforeRedirect;
  if (!ev) return; // permission not granted: the API does not exist
  if (on && !ev.hasListener(onRedirect)) ev.addListener(onRedirect, { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] });
  else if (!on && ev.hasListener(onRedirect)) ev.removeListener(onRedirect);
}

setRedirectLogging(true); // no-op until the optional permission exists
browser.permissions.onAdded.addListener((p) => { if (p.permissions?.includes('webRequest')) setRedirectLogging(true); });
browser.permissions.onRemoved.addListener((p) => { if (p.permissions?.includes('webRequest')) setRedirectLogging(false); });

// 3. Listen for runtime messages from popup UI, options page, and content scripts
browser.runtime.onMessage.addListener(async (message, sender) => {
  if (!message || typeof message !== 'object') return;
  await ready; // never answer or mutate settings before they were loaded from storage

  switch (message.type) {
    case 'GET_SETTINGS': {
      return { success: true, settings: activeSettings };
    }

    case 'SET_PROTECTION': {
      const newEnabled = Boolean(message.enabled);
      activeSettings.enabled = newEnabled;
      await browser.storage.local.set({ enabled: newEnabled });
      await applyPolicy();
      return { success: true, enabled: newEnabled };
    }

    case 'GET_STATS_AND_LOGS': {
      return {
        success: true,
        statsEnabled: activeSettings.statsEnabled,
        statistics: privacyStats.getStats(),
        internalLogs: logger.getInternalLogs()
      };
    }

    case 'CLEAR_STATS_AND_LOGS': {
      privacyStats.clear();
      logger.clearInternalLogs();
      return { success: true };
    }

    case 'UPDATE_SETTINGS': {
      const { rules: _ignoredRules, ...updates } = (message.settings ?? {}) as Partial<AnoFoxSettings>; // rules only change via *_USER_RULE messages
      if (updates && typeof updates === 'object') {
        const previous = activeSettings;
        const merged = normalizeSettings(
          { ...previous, ...updates, socialEmbedProviders: { ...previous.socialEmbedProviders, ...(updates.socialEmbedProviders ?? {}) } },
          previous
        );
        activeSettings = merged;
        if (merged.statsEnabled !== previous.statsEnabled) {
          privacyStats.setEnabled(merged.statsEnabled);
          logger.setInternalLogging(merged.statsEnabled);
        }

        await browser.storage.local.set(activeSettings);

        logger.setConfig({
          terminalLogging: activeSettings.terminalLogging,
          severity: activeSettings.logSeverity,
          internalLogging: activeSettings.statsEnabled
        });

        await applyPolicy();

        logger.info(`AnoFox Einstellungen aktualisiert (Level: ${activeSettings.logSeverity}, Konsole: ${activeSettings.terminalLogging ? 'EIN' : 'AUS'}, Stats: ${activeSettings.statsEnabled ? 'EIN' : 'AUS'}).`);
      }
      return { success: true, settings: activeSettings };
    }

    case 'TOGGLE_EXCEPTION': {
      const rawDomain = String(message.domain || '');
      const sanitized = sanitizeDomainList([rawDomain])[0];
      if (!sanitized) {
        return { success: false, error: 'Ungültige Domain' };
      }

      const existingIndex = activeSettings.exceptions.indexOf(sanitized);
      if (existingIndex >= 0) {
        activeSettings.exceptions.splice(existingIndex, 1);
      } else {
        activeSettings.exceptions.push(sanitized);
      }

      await browser.storage.local.set({ exceptions: activeSettings.exceptions });
      await applyPolicy();

      return {
        success: true,
        isException: activeSettings.exceptions.includes(sanitized),
        exceptions: activeSettings.exceptions
      };
    }

    case 'TOGGLE_EMBED_EXCEPTION': {
      const rawDomain = String(message.domain || '');
      const sanitized = sanitizeDomainList([rawDomain])[0];
      if (!sanitized) {
        return { success: false, error: 'Ungültige Domain' };
      }

      const existingIndex = activeSettings.socialEmbedExceptions.indexOf(sanitized);
      if (existingIndex >= 0) {
        activeSettings.socialEmbedExceptions.splice(existingIndex, 1);
      } else {
        activeSettings.socialEmbedExceptions.push(sanitized);
      }

      await browser.storage.local.set({ socialEmbedExceptions: activeSettings.socialEmbedExceptions });
      await applyPolicy();

      return {
        success: true,
        isException: activeSettings.socialEmbedExceptions.includes(sanitized),
        socialEmbedExceptions: activeSettings.socialEmbedExceptions
      };
    }

    case 'ADD_EMBED_EXCEPTION': {
      const rawDomain = String(message.domain || '');
      const sanitized = sanitizeDomainList([rawDomain])[0];
      if (!sanitized) {
        return { success: false, error: 'Ungültige Domain' };
      }

      if (!activeSettings.socialEmbedExceptions.includes(sanitized)) {
        activeSettings.socialEmbedExceptions.push(sanitized);
        await browser.storage.local.set({ socialEmbedExceptions: activeSettings.socialEmbedExceptions });
        await applyPolicy();
      }

      return {
        success: true,
        isException: true,
        socialEmbedExceptions: activeSettings.socialEmbedExceptions
      };
    }

    case 'ALLOW_EMBED_URL': {
      const url = String(message.url || '');
      if (!url) return { success: false, error: 'URL fehlt' };

      const ok = await allowEmbedTemporarily(url);
      logger.info(`Social Embed temporär freigegeben: ${url}`);
      return { success: ok };
    }

    case 'LOG_EMBED_EVENT': {
      const provider = String(message.provider || 'Unbekannt');
      const action = String(message.action || 'INTERCEPTED');
      const site = String(message.site || 'Website');
      const url = String(message.url || '');
      const providerId = String(message.providerId || provider.toLowerCase());

      if (action === 'BLOCKED') {
        logger.info(`[Social Embed Guard] ${provider}-Inhalt auf "${site}" blockiert vor Netzwerkverbindung.`);
        logger.logInternal(
          'INFO',
          'EMBED_GUARD',
          `${provider}-Inhalt auf "${site}" blockiert vor Netzwerkverbindung`,
          url ? `URL: ${url}` : undefined
        );
        privacyStats.recordEmbedBlocked(provider, providerId, site, url);
      } else if (action === 'LOADED') {
        logger.info(`[Social Embed Guard] ${provider}-Inhalt auf "${site}" bewusst nachgeladen: ${url}`);
        logger.logInternal(
          'INFO',
          'EMBED_GUARD',
          `${provider}-Inhalt auf "${site}" bewusst nachgeladen`,
          url
        );
      }
      return { success: true };
    }

    case 'SET_PROFILE': {
      if (!['balanced', 'strict', 'lockdown', 'custom'].includes(message.profile)) {
        return { success: false, error: 'Unbekanntes Profil' };
      }
      // Profile change never touches user rules
      activeSettings = normalizeSettings({ ...activeSettings, profile: message.profile }, activeSettings);
      await browser.storage.local.set({ profile: activeSettings.profile });
      await applyPolicy();
      return { success: true, profile: activeSettings.profile };
    }

    case 'SET_MODULE_LEVEL': {
      const next = normalizeSettings({
        ...activeSettings,
        profile: 'custom',
        customLevels: { ...effectiveLevels(policyStateOf(activeSettings)), [String(message.module)]: message.level }
      }, activeSettings);
      activeSettings = next;
      await browser.storage.local.set({ profile: next.profile, customLevels: next.customLevels });
      await applyPolicy();
      return { success: true, profile: next.profile, customLevels: next.customLevels };
    }

    case 'ADD_USER_RULE': {
      if (activeSettings.rules.length >= 2000) return { success: false, error: 'Zu viele Regeln' };
      const candidate = normalizeSettings({
        ...activeSettings,
        rules: [{ ...(message.rule ?? {}), id: crypto.randomUUID(), createdAt: Date.now() }]
      }, { ...activeSettings, rules: [] });
      const rule = candidate.rules[0];
      if (!rule) return { success: false, error: 'Ungültige Regel' };
      await commitRules([...activeSettings.rules, rule]);
      return { success: true, rule, unsupported: unsupportedPolicyRules.filter((u) => u.ruleId === rule.id) };
    }

    case 'REMOVE_USER_RULE': {
      await commitRules(activeSettings.rules.filter((r) => r.id !== String(message.id)));
      return { success: true };
    }

    case 'GET_POLICY_STATUS': {
      return { success: true, unsupported: unsupportedPolicyRules };
    }

    case 'IMPORT_SETTINGS': {
      const result = parseImport(String(message.text ?? ''));
      if (!result.ok) return { success: false, error: result.error };
      const backup = activeSettings;
      try {
        await browser.storage.local.set({ settingsBackup: backup });
        activeSettings = result.settings;
        await browser.storage.local.set(activeSettings);
        logger.setConfig({ terminalLogging: activeSettings.terminalLogging, severity: activeSettings.logSeverity, internalLogging: activeSettings.statsEnabled });
        privacyStats.setEnabled(activeSettings.statsEnabled);
        if (!(await applyPolicy())) throw new Error('Regeln konnten nicht angewendet werden');
        return { success: true, settings: activeSettings };
      } catch (e) {
        // rollback to the previous, known-good configuration
        activeSettings = backup;
        await browser.storage.local.set(backup);
        await applyPolicy();
        return { success: false, error: e instanceof Error ? e.message : 'Import fehlgeschlagen' };
      }
    }

    case 'COSMETIC_INIT':
    case 'COSMETIC_QUERY': {
      const target = cosmeticTarget(sender);
      if (!target) return { success: false };
      if (!cosmeticAllowed(target)) return { success: true, active: false };
      const index = await getCosmeticIndex();
      if (index.isEmpty()) return { success: true, active: false };
      let selectors: string[];
      if (message.type === 'COSMETIC_INIT') {
        selectors = index.hostSelectors(target.frameHost);
      } else {
        const clean = (v: unknown): string[] => Array.isArray(v)
          ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 100).slice(0, 300) : [];
        selectors = index.tokenSelectors(target.frameHost, { classes: clean(message.classes), ids: clean(message.ids) });
      }
      try {
        await injectHidingCss(target, selectors);
      } catch (e) {
        logger.debug('insertCSS fehlgeschlagen:', e);
        return { success: false };
      }
      return { success: true, active: true };
    }

    case 'THREAT_BYPASS': {
      return threatService.bypass(sender.url, sender.tab?.id, message.duration);
    }

    case 'GET_THREAT_STATUS': {
      return { success: true, ...(await threatService.status()) };
    }

    case 'SET_THREAT_LIST_ENABLED': {
      const source = getThreatSource(String(message.id));
      if (!source) return { success: false, error: 'unknown-list' };
      const summary = await threatService.manager.setEnabled(source.id, Boolean(message.enabled), threatService.levels()[source.kind]);
      const err = summary.errors[String(message.id)];
      return { success: !err, summary, error: err };
    }

    case 'UPDATE_THREATS_NOW': {
      return { success: true, summary: await threatService.refresh(true) };
    }

    case 'E2E_APPLY_THREAT_DOMAINS': {
      if (!__E2E__) return { success: false };
      return { success: await threatService.e2eApply(String(message.listId), (message.domains as string[]) ?? []) };
    }

    case 'CONSENT_GET_CONFIG': {
      const url = sender.tab?.url;
      let host: string | null = null;
      try { const u = new URL(url ?? ''); host = u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null; } catch { host = null; }
      if (!host || sender.frameId !== 0 || typeof sender.tab?.id !== 'number') return { success: false };
      const level = effectiveLevels(policyStateOf(activeSettings)).consent;
      const mode = effectiveConsentMode(activeSettings.consentMode, level);
      // a user rule (module consent, allow) switches the automation off for a site / tab
      const paused = pickRule(activeSettings.rules, 'consent', { topHost: host, targetUrl: `https://${host}/`, resourceType: 'main_frame', tabId: sender.tab.id }, host, Date.now());
      return { success: true, mode, active: mode !== 'manual' && !(paused && paused.effect === 'allow') };
    }

    case 'CONSENT_REPORT': {
      const adapter = String(message.adapter ?? '');
      const action = String(message.action ?? '');
      if (!ADAPTERS.some((a) => a.id === adapter) || !['rejected', 'hidden', 'failed', 'wall-left-visible'].includes(action)) return { success: false };
      // read-modify-write must be serialized: reports from several tabs arrive concurrently and would overwrite each other
      consentStatsQueue = consentStatsQueue.then(async () => {
        const current = ((await browser.storage.session.get('consentStats')).consentStats as Record<string, Record<string, number>> | undefined) ?? {};
        current[adapter] = { ...(current[adapter] ?? {}), [action]: ((current[adapter] ?? {})[action] ?? 0) + 1 };
        await browser.storage.session.set({ consentStats: current });
      }).catch(() => undefined);
      await consentStatsQueue;
      logger.info(`[Consent] ${adapter}: ${action}`);
      return { success: true };
    }

    case 'GET_CONSENT_STATUS': {
      const level = effectiveLevels(policyStateOf(activeSettings)).consent;
      const stats = ((await browser.storage.session.get('consentStats')).consentStats as Record<string, Record<string, number>> | undefined) ?? {};
      return {
        success: true, setting: activeSettings.consentMode, level, mode: effectiveConsentMode(activeSettings.consentMode, level), stats,
        adapters: ADAPTERS.map((a) => ({ id: a.id, name: a.name, family: a.family }))
      };
    }

    case 'SET_CONSENT_MODE': {
      const normalized = normalizeSettings({ ...activeSettings, consentMode: message.mode as ConsentModeSetting }, activeSettings);
      if (normalized.consentMode !== message.mode) return { success: false, error: 'Unbekannter Modus' };
      activeSettings = normalized;
      await browser.storage.local.set({ consentMode: normalized.consentMode });
      return { success: true, consentMode: normalized.consentMode };
    }

    case 'GET_STORAGE_STATUS': {
      return { success: true, status: await storageService.status(typeof message.host === 'string' ? message.host : undefined), sitePolicies: activeSettings.sitePolicies };
    }

    case 'SET_SITE_POLICY': {
      const site = String(message.site ?? '').toLowerCase();
      const next = { ...activeSettings.sitePolicies };
      if (message.policy === null) delete next[site];
      else next[site] = message.policy;
      const normalized = normalizeSettings({ ...activeSettings, sitePolicies: next }, activeSettings);
      if (message.policy !== null && !normalized.sitePolicies[site]) return { success: false, error: 'Ungültige Domain oder Richtlinie' };
      activeSettings = normalized;
      await browser.storage.local.set({ sitePolicies: normalized.sitePolicies });
      return { success: true, sitePolicies: normalized.sitePolicies };
    }

    case 'SET_STORAGE_GRACE': {
      activeSettings = normalizeSettings({ ...activeSettings, storageGraceMs: Number(message.ms) }, activeSettings);
      await browser.storage.local.set({ storageGraceMs: activeSettings.storageGraceMs });
      return { success: true, storageGraceMs: activeSettings.storageGraceMs };
    }

    case 'CLEAN_SITE_NOW': {
      const site = String(message.site ?? '');
      if (!site) return { success: false, error: 'Website fehlt' };
      const result = await storageService.cleanNow(site);
      return { success: true, result };
    }

    case 'GET_NATIVE_STATUS': {
      if (!browser.privacy) return { success: true, status: [] };
      const level = effectiveLevels(policyStateOf(activeSettings)).fingerprint;
      return { success: true, level, overrides: activeSettings.nativeOverrides, status: await planNative(privacyApi, level, activeSettings.nativeOverrides) };
    }

    case 'SET_NATIVE_OVERRIDE': {
      const next = { ...activeSettings.nativeOverrides };
      if (message.override === 'auto') delete (next as Record<string, unknown>)[String(message.id)];
      else (next as Record<string, unknown>)[String(message.id)] = message.override;
      const normalized = normalizeSettings({ ...activeSettings, nativeOverrides: next }, activeSettings);
      activeSettings = normalized;
      await browser.storage.local.set({ nativeOverrides: normalized.nativeOverrides });
      await applyPolicy();
      return { success: true, overrides: normalized.nativeOverrides };
    }

    case 'GET_LISTS': {
      const states = await listManager.getStates();
      return {
        success: true,
        lists: LIST_SOURCES.map((s) => ({
          id: s.id, name: s.name, description: s.description, license: s.license, attribution: s.attribution,
          state: states[s.id]
        }))
      };
    }

    case 'SET_LIST_ENABLED': {
      // a list is either shipped (snapshot) or downloaded, never both: same id, same rules twice would only waste quota
      if (message.enabled && await staticRulesets.isWanted(String(message.id))) await staticRulesets.setWanted(String(message.id), false);
      const summary = await listManager.setEnabled(String(message.id), Boolean(message.enabled));
      const err = summary.errors[String(message.id)];
      return { success: !err || summary.applied, summary, error: err };
    }

    case 'GET_STATIC_LISTS': {
      return { success: true, ...(await staticRulesets.status()) };
    }

    case 'SET_STATIC_LIST': {
      const id = String(message.id);
      const on = Boolean(message.enabled);
      if (on) await listManager.setEnabled(id, false);
      const error = await staticRulesets.setWanted(id, on);
      return { success: !error, error: error ?? undefined };
    }

    case 'SET_LIST_INTERVAL': {
      await listManager.setInterval(String(message.id), Number(message.intervalMs));
      return { success: true };
    }

    case 'UPDATE_LISTS_NOW': {
      const summary = await listManager.refresh({ manual: true });
      return { success: true, summary };
    }

    case 'OPEN_OPTIONS': {
      try {
        if (browser.runtime.openOptionsPage) {
          await browser.runtime.openOptionsPage();
        } else {
          await browser.tabs.create({ url: browser.runtime.getURL('options.html') });
        }
        return { success: true };
      } catch (e) {
        await browser.tabs.create({ url: 'options.html' });
        return { success: true };
      }
    }

    case 'RESET_SETTINGS': {
      activeSettings = defaultSettings();
      privacyStats.clear();
      privacyStats.setEnabled(false);
      logger.clearInternalLogs();
      logger.setInternalLogging(false);

      // list rules live outside the settings; turn lists off first so no orphaned DNR rules remain
      for (const l of LIST_SOURCES) await listManager.setEnabled(l.id, false);
      await threatService.resetAll();
      await staticRulesets.clear();
      await browser.storage.local.clear();
      await browser.storage.local.set(activeSettings);
      await applyPolicy();
      logger.setConfig({
        terminalLogging: activeSettings.terminalLogging,
        severity: activeSettings.logSeverity,
        internalLogging: false
      });
      logger.info('AnoFox Einstellungen auf Standardwerte zurückgesetzt.');
      return { success: true, settings: activeSettings };
    }

    default:
      return { success: false, error: 'Unbekannter Nachrichtentyp' };
  }
});

// 4. Listen for storage changes
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  let needsDnrSync = false;
  let needsLoggerSync = false;

  if (changes.enabled) {
    activeSettings.enabled = Boolean(changes.enabled.newValue);
    needsDnrSync = true;
  }
  if (changes.exceptions) {
    activeSettings.exceptions = Array.isArray(changes.exceptions.newValue)
      ? changes.exceptions.newValue
      : [];
    needsDnrSync = true;
  }
  if (changes.terminalLogging) {
    activeSettings.terminalLogging = Boolean(changes.terminalLogging.newValue);
    needsLoggerSync = true;
  }
  if (changes.logSeverity) {
    activeSettings.logSeverity = changes.logSeverity.newValue as LogSeverity;
    needsLoggerSync = true;
  }
  if (changes.statsEnabled) {
    activeSettings.statsEnabled = Boolean(changes.statsEnabled.newValue);
    privacyStats.setEnabled(activeSettings.statsEnabled);
    logger.setInternalLogging(activeSettings.statsEnabled);
    needsLoggerSync = true;
  }
  if (changes.socialEmbedsEnabled) {
    activeSettings.socialEmbedsEnabled = Boolean(changes.socialEmbedsEnabled.newValue);
    needsDnrSync = true;
  }
  if (changes.socialEmbedExceptions) {
    activeSettings.socialEmbedExceptions = Array.isArray(changes.socialEmbedExceptions.newValue)
      ? changes.socialEmbedExceptions.newValue
      : [];
    needsDnrSync = true;
  }
  if (changes.socialEmbedProviders) {
    activeSettings.socialEmbedProviders = {
      ...DEFAULT_PROVIDERS,
      ...changes.socialEmbedProviders.newValue
    };
    needsDnrSync = true;
  }
  if (changes.theme) {
    activeSettings.theme = changes.theme.newValue as ThemePreference;
  }

  if (needsLoggerSync) {
    logger.setConfig({
      terminalLogging: activeSettings.terminalLogging,
      severity: activeSettings.logSeverity,
      internalLogging: activeSettings.statsEnabled
    });
  }

  if (needsDnrSync) {
    void applyPolicy();
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  void ready.then(() => {
    if (activeSettings.rules.some((r) => r.duration === 'tab' && r.tabId === tabId)) {
      return commitRules(activeSettings.rules.filter((r) => !(r.duration === 'tab' && r.tabId === tabId)));
    }
  }).catch((e) => logger.error('Bereinigung von Tab-Regeln fehlgeschlagen:', e));
});

// Run startup initialization; message handlers wait on `ready`
ready = initializeSettings();
