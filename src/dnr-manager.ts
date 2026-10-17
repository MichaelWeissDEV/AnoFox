/**
 * DeclarativeNetRequest Rule Manager for AnoFox URL Tracking Cleaner.
 * Manages dynamic rules for query transformation (stripping tracking params before network requests),
 * website exceptions, and signed/auth link bypass rules.
 */

import {
  generateDnrRemoveParams,
  generateAuthParamRegex,
  generateTrackingParamRegexes
} from './url-cleaner.ts';
import { logger } from './logger.ts';
import {
  SUPPORTED_EMBED_PROVIDERS,
  DEFAULT_PROVIDERS,
  identifyEmbedProvider
} from './embed-guard.ts';
import type { SocialEmbedProviders } from './embed-guard.ts';
import { sanitizeDomainList } from './core/domain-utils/domains.ts';

export { sanitizeDomainList };

// Rule ID namespaces (stable, never derived from runtime counters)
export const DNR_RULE_REDIRECT_TRACKING = 1001; // 1001..1019: one redirect rule per parameter chunk
export const DNR_RULE_REDIRECT_TRACKING_MAX = 1019;
export const DNR_RULE_ALLOW_EXCEPTIONS = 1020;
export const DNR_RULE_ALLOW_AUTH_SIGNED = 1021;

export const DNR_RULE_BLOCK_EMBED_BASE = 2100; // + providerIndex * 10 + filterIndex
export const DNR_RULE_ALLOW_TEMP_EMBED_BASE = 3000; // session rules only

/**
 * Priority bands. An allow wins over block only at EQUAL priority, so a band must be
 * strictly higher to override a lower one. Cleaner allow rules (band 10) must never
 * override Embed Guard blocks (band 60).
 */
export const PRIORITY_CLEANER = 6; // above adblock-pause (5) so pausing adblock never disables the URL cleaner
export const PRIORITY_CLEANER_ALLOW = 10;
export const PRIORITY_EMBED_BLOCK = 60; // above all user-rule bands (21..32), see protection/network/compile.ts
export const PRIORITY_EMBED_ALLOW_TEMP = 70;

const DNR_OWNED_ID_LIMIT = 10000;
const MAX_TEMP_RULES = 100;
const MAX_TEMP_URL_LENGTH = 1500;

export interface DnrSyncOptions {
  enabled: boolean;
  exceptions: string[];
  socialEmbedsEnabled?: boolean;
  socialEmbedExceptions?: string[];
  socialEmbedProviders?: SocialEmbedProviders;
  /** Pre-compiled dynamic rules from the Policy Engine (network/scripts). */
  policyRules?: browser.declarativeNetRequest.Rule[];
}

export function isTrackingRedirectRuleId(id: number): boolean {
  return id >= DNR_RULE_REDIRECT_TRACKING && id <= DNR_RULE_REDIRECT_TRACKING_MAX;
}

async function isRegexUsable(regex: string): Promise<boolean> {
  if (typeof browser === 'undefined' || !browser.declarativeNetRequest?.isRegexSupported) {
    return true;
  }
  try {
    const check = await browser.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive: false });
    return check.isSupported;
  } catch {
    return true;
  }
}

/**
 * Builds the DeclarativeNetRequest dynamic rules to be registered with the browser.
 */
export async function buildDnrRules(options: DnrSyncOptions): Promise<browser.declarativeNetRequest.Rule[]> {
  const rules: browser.declarativeNetRequest.Rule[] = [];

  // 1. URL Tracking Cleaner: only requests that actually carry a tracking parameter match.
  if (options.enabled) {
    const sanitizedExceptions = sanitizeDomainList(options.exceptions);
    const removeParams = generateDnrRemoveParams();

    let ruleId = DNR_RULE_REDIRECT_TRACKING;
    for (const regex of generateTrackingParamRegexes()) {
      if (ruleId > DNR_RULE_REDIRECT_TRACKING_MAX) break;
      if (!(await isRegexUsable(regex))) {
        logger.warn('Tracking-Parameter-Regex wird vom Browser nicht unterstützt; Chunk übersprungen.');
        continue;
      }
      const redirectRule: browser.declarativeNetRequest.Rule = {
        id: ruleId++,
        priority: PRIORITY_CLEANER,
        action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams } } } },
        condition: {
          regexFilter: regex,
          isUrlFilterCaseSensitive: false,
          resourceTypes: ['main_frame', 'sub_frame']
        }
      };
      if (sanitizedExceptions.length > 0) {
        redirectRule.condition.excludedRequestDomains = sanitizedExceptions;
      }
      rules.push(redirectRule);
    }

    if (sanitizedExceptions.length > 0) {
      rules.push({
        id: DNR_RULE_ALLOW_EXCEPTIONS,
        priority: PRIORITY_CLEANER_ALLOW,
        action: { type: 'allow' },
        condition: { requestDomains: sanitizedExceptions, resourceTypes: ['main_frame', 'sub_frame'] }
      });
    }

    // Signed / auth URLs must not be modified. Regex is generated from the same lists as the JS cleaner.
    const authRegex = generateAuthParamRegex();
    if (await isRegexUsable(authRegex)) {
      rules.push({
        id: DNR_RULE_ALLOW_AUTH_SIGNED,
        priority: PRIORITY_CLEANER_ALLOW,
        action: { type: 'allow' },
        condition: {
          regexFilter: authRegex,
          isUrlFilterCaseSensitive: false,
          resourceTypes: ['main_frame', 'sub_frame']
        }
      });
    }
  }

  // 2. Social Embed Guard. Site exceptions match the INITIATOR (embedding page), not the embed host.
  if (options.socialEmbedsEnabled) {
    const sanitizedEmbedExceptions = sanitizeDomainList(options.socialEmbedExceptions || []);
    const providersConfig = options.socialEmbedProviders || DEFAULT_PROVIDERS;

    SUPPORTED_EMBED_PROVIDERS.forEach((provider, providerIndex) => {
      if (!(providersConfig[provider.id] ?? true)) return;

      provider.dnrFilters.forEach((filter, filterIndex) => {
        const blockRule: browser.declarativeNetRequest.Rule = {
          id: DNR_RULE_BLOCK_EMBED_BASE + providerIndex * 10 + filterIndex,
          priority: PRIORITY_EMBED_BLOCK,
          action: { type: 'block' },
          condition: {
            urlFilter: filter,
            resourceTypes: ['sub_frame', 'script', 'xmlhttprequest']
          }
        };
        if (sanitizedEmbedExceptions.length > 0) {
          blockRule.condition.excludedInitiatorDomains = sanitizedEmbedExceptions;
        }
        rules.push(blockRule);
      });
    });
    // No separate allow rule: site exceptions are expressed via excludedInitiatorDomains on the block
    // rules, so an exception can never unblock anything except the embed URLs themselves.
  }

  if (options.policyRules) rules.push(...options.policyRules);

  return rules;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a session-scoped allow rule for exactly one known embed URL.
 * Returns null if the URL is not an http(s) embed URL of a known provider.
 */
export function buildTempEmbedAllowRule(url: string, id: number): browser.declarativeNetRequest.Rule | null {
  if (!url || url.length > MAX_TEMP_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!identifyEmbedProvider(parsed.href)) return null;

  return {
    id,
    priority: PRIORITY_EMBED_ALLOW_TEMP,
    action: { type: 'allow' },
    condition: {
      regexFilter: '^' + escapeRegexLiteral(parsed.href) + '$',
      isUrlFilterCaseSensitive: true,
      resourceTypes: ['sub_frame', 'script', 'xmlhttprequest']
    }
  };
}

/**
 * Allows a single embed URL until the browser session ends (session rules are never persisted).
 */
export async function allowEmbedTemporarily(url: string): Promise<boolean> {
  const api = typeof browser !== 'undefined' ? browser.declarativeNetRequest : undefined;
  if (!api?.updateSessionRules || !api.getSessionRules) return false;

  try {
    const existing = (await api.getSessionRules())
      .filter((r) => r.id >= DNR_RULE_ALLOW_TEMP_EMBED_BASE && r.id < DNR_RULE_ALLOW_TEMP_EMBED_BASE + MAX_TEMP_RULES)
      .sort((a, b) => a.id - b.id);
    const used = new Set(existing.map((r) => r.id));
    let id = -1;
    for (let i = 0; i < MAX_TEMP_RULES; i++) {
      if (!used.has(DNR_RULE_ALLOW_TEMP_EMBED_BASE + i)) { id = DNR_RULE_ALLOW_TEMP_EMBED_BASE + i; break; }
    }
    const removeRuleIds: number[] = [];
    if (id === -1) { // full: evict the lowest id
      id = existing[0].id;
      removeRuleIds.push(id);
    }
    const rule = buildTempEmbedAllowRule(url, id);
    if (!rule) return false;
    await api.updateSessionRules({ removeRuleIds, addRules: [rule] });
    return true;
  } catch (err) {
    logger.debug('Konnte temporäre Allow-Regel für Embed nicht setzen:', err);
    return false;
  }
}

/**
 * Atomically replaces all filter-list rules (ids 100000..199999). Throws if the browser rejects them,
 * in which case the previous list rules stay active.
 */
export async function replaceListRules(rules: Array<browser.declarativeNetRequest.Rule>): Promise<void> {
  const api = browser.declarativeNetRequest;
  const existing = await api.getDynamicRules();
  const remove = existing.map((r) => r.id).filter((id) => id >= 100_000 && id <= 199_999);
  await api.updateDynamicRules({ removeRuleIds: remove, addRules: rules });
}

/** Remaining dynamic rule quota for filter lists: browser limit minus rules of other modules, minus a reserve for policy rules. */
export async function listRuleBudget(): Promise<number> {
  const api = browser.declarativeNetRequest as unknown as { MAX_NUMBER_OF_DYNAMIC_RULES?: number; getDynamicRules(): Promise<Array<{ id: number }>> };
  const limit = typeof api.MAX_NUMBER_OF_DYNAMIC_RULES === 'number' ? api.MAX_NUMBER_OF_DYNAMIC_RULES : 5000; // conservative fallback
  const existing = await api.getDynamicRules();
  const others = existing.filter((r) => r.id < 100_000 || r.id > 199_999).length;
  return Math.max(0, limit - others - 1000); // reserve: policy user rules (<=900) + cleaner/embed rules
}

/**
 * Replaces the Policy Engine's session rules (ids 6000..6999). Embed temp allows (3000..3099) are untouched.
 */
export async function syncPolicySessionRules(rules: browser.declarativeNetRequest.Rule[]): Promise<boolean> {
  const api = typeof browser !== 'undefined' ? browser.declarativeNetRequest : undefined;
  if (!api?.updateSessionRules || !api.getSessionRules) return false;
  try {
    const existing = await api.getSessionRules();
    const remove = existing.filter((r) => r.id >= 6000 && r.id <= 6999).map((r) => r.id);
    await api.updateSessionRules({ removeRuleIds: remove, addRules: rules });
    return true;
  } catch (error) {
    logger.error('Fehler beim Aktualisieren der Session-Regeln:', error);
    return false;
  }
}

/**
 * Synchronizes declarativeNetRequest dynamic rules according to current settings.
 * updateDynamicRules is atomic: on failure the previously active rule set stays in force.
 * Returns true on success.
 */
export async function syncDnrRules(options: DnrSyncOptions): Promise<boolean> {
  if (typeof browser === 'undefined' || !browser.declarativeNetRequest?.updateDynamicRules) {
    logger.debug('declarativeNetRequest is not available in current environment');
    return false;
  }

  try {
    const existing = await browser.declarativeNetRequest.getDynamicRules();
    // Remove everything AnoFox owns (includes legacy "temporary" rules from <=0.1.0 in 3000..3099).
    const ruleIdsToRemove = existing.map((r) => r.id).filter((id) => id < DNR_OWNED_ID_LIMIT);

    const rulesToAdd = await buildDnrRules(options);
    const ids = rulesToAdd.map((r) => r.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error('Doppelte DNR-Regel-IDs erkannt; Aktualisierung abgebrochen.');
    }

    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ruleIdsToRemove,
      addRules: rulesToAdd
    });

    const activeParts: string[] = [];
    if (options.enabled) activeParts.push('URL-Tracking-Bereinigung');
    if (options.socialEmbedsEnabled) activeParts.push('Social Embed Guard');

    if (activeParts.length > 0) {
      logger.info(
        `declarativeNetRequest Regeln aktiv: ${rulesToAdd.length} Regeln geladen (${activeParts.join(', ')}).`
      );
    } else {
      logger.info('Alle Module deaktiviert. declarativeNetRequest Regeln entfernt.');
    }
    return true;
  } catch (error) {
    logger.error('Fehler beim Aktualisieren der declarativeNetRequest Regeln (vorherige Regeln bleiben aktiv):', error);
    return false;
  }
}

/**
 * Sliding-window tracker to prevent redirect loops.
 */
export class RedirectLoopGuard {
  private history = new Map<string, number[]>();
  private maxRedirectsInWindow = 3;
  private windowMs = 2000;
  private blockedDomains = new Set<string>();

  public checkAndRecord(domain: string): boolean {
    const now = Date.now();
    const timestamps = (this.history.get(domain) || []).filter((t) => now - t < this.windowMs);
    timestamps.push(now);
    this.history.set(domain, timestamps);

    if (timestamps.length > this.maxRedirectsInWindow) {
      this.blockedDomains.add(domain);
      logger.warn(
        `Mögliche Redirect-Schleife für Domain "${domain}" erkannt (${timestamps.length} Redirects in ${this.windowMs}ms). Bereinigung für diese Domain vorübergehend ausgesetzt.`
      );
      return false; // Loop detected!
    }

    return true; // Safe
  }

  public isLoopBlocked(domain: string): boolean {
    return this.blockedDomains.has(domain);
  }

  public resetDomain(domain: string): void {
    this.history.delete(domain);
    this.blockedDomains.delete(domain);
  }

  public clear(): void {
    this.history.clear();
    this.blockedDomains.clear();
  }
}

export const loopGuard = new RedirectLoopGuard();
