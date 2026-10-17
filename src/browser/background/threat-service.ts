/**
 * Browser-facing part of the phishing/malware protection: list manager wiring, deceptive-URL rule, per-host bypass.
 * Everything is local; nothing about a visited URL is ever sent anywhere.
 */
import type { AnoFoxSettings } from '../../core/settings/settings.ts';
import { effectiveLevels } from '../../core/policy-engine/policy.ts';
import type { Level } from '../../core/policy-engine/policy.ts';
import { THREAT_SOURCES } from '../../protection/threat/sources.ts';
import type { ThreatKind } from '../../protection/threat/sources.ts';
import { ThreatListManager } from '../../protection/threat/manager.ts';
import {
  listIdRange, compileHeuristicRule, buildBypassRule, parseWarningUrl, compileThreatRules,
  DNR_RULE_THREAT_HEURISTIC, DNR_RULE_THREAT_BYPASS_BASE, DNR_RULE_THREAT_BYPASS_END
} from '../../protection/threat/compile.ts';
import { logger } from '../../logger.ts';

const KEY_BYPASS = 'threatBypass'; // storage.session: host -> expiresAt (0 = until the browser session ends)
const MAX_BYPASS = DNR_RULE_THREAT_BYPASS_END - DNR_RULE_THREAT_BYPASS_BASE + 1;
type DnrRule = browser.declarativeNetRequest.Rule;
type DnrApi = typeof browser.declarativeNetRequest & { MAX_NUMBER_OF_DYNAMIC_RULES?: number; MAX_NUMBER_OF_REGEX_RULES?: number };

export function createThreatService(getSettings: () => AnoFoxSettings) {
  const dnr = (): DnrApi => browser.declarativeNetRequest as DnrApi;
  const origin = () => browser.runtime.getURL('').replace(/\/$/, '');
  const levels = (): Record<ThreatKind, Level> => {
    const s = getSettings();
    const l = effectiveLevels({ profile: s.profile, customLevels: s.customLevels, rules: [] });
    return { malware: l.malware, phishing: l.phishing };
  };

  const manager = new ThreatListManager({
    updater: {
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      sha256: async (bytes) => {
        const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
        return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      }
    },
    storage: { get: async (key) => (await browser.storage.local.get(key))[key], set: (items) => browser.storage.local.set(items) },
    get extensionOrigin() { return origin(); },
    async replaceRules(listIndex, rules) {
      const [lo, hi] = listIdRange(listIndex);
      const existing = await dnr().getDynamicRules();
      await dnr().updateDynamicRules({ removeRuleIds: existing.map((r) => r.id).filter((id) => id >= lo && id <= hi), addRules: rules });
    },
    async clearRules(listIndex) {
      const [lo, hi] = listIdRange(listIndex);
      const existing = await dnr().getDynamicRules();
      const ids = existing.map((r) => r.id).filter((id) => id >= lo && id <= hi);
      if (ids.length) await dnr().updateDynamicRules({ removeRuleIds: ids });
    },
    async budget(listIndex) {
      const [lo, hi] = listIdRange(listIndex);
      const existing = await dnr().getDynamicRules();
      const others = existing.filter((r) => r.id < lo || r.id > hi);
      const limit = dnr().MAX_NUMBER_OF_DYNAMIC_RULES ?? 5000;
      const regexLimit = dnr().MAX_NUMBER_OF_REGEX_RULES ?? 1000;
      return { rules: Math.max(0, limit - others.length), regexRules: Math.max(0, regexLimit - others.filter((r) => r.condition.regexFilter).length) };
    }
  });

  async function syncHeuristic(): Promise<void> {
    const on = levels().phishing !== 'off';
    const existing = (await dnr().getDynamicRules()).some((r) => r.id === DNR_RULE_THREAT_HEURISTIC);
    if (on && !existing) await dnr().updateDynamicRules({ addRules: [compileHeuristicRule(origin())] });
    else if (!on && existing) await dnr().updateDynamicRules({ removeRuleIds: [DNR_RULE_THREAT_HEURISTIC] });
  }

  async function bypassMap(): Promise<Record<string, number>> {
    return ((await browser.storage.session.get(KEY_BYPASS))[KEY_BYPASS] as Record<string, number> | undefined) ?? {};
  }

  async function syncBypassRules(map: Record<string, number>): Promise<void> {
    const hosts = Object.keys(map).slice(0, MAX_BYPASS);
    const rules: DnrRule[] = hosts.map((h, i) => buildBypassRule(h, DNR_RULE_THREAT_BYPASS_BASE + i));
    const existing = await dnr().getSessionRules();
    await dnr().updateSessionRules({
      removeRuleIds: existing.map((r) => r.id).filter((id) => id >= DNR_RULE_THREAT_BYPASS_BASE && id <= DNR_RULE_THREAT_BYPASS_END),
      addRules: rules
    });
  }

  return {
    manager,
    levels,

    /** Called after every policy application: heuristic rule, level changes, bypass rules. Never throws. */
    async sync(): Promise<void> {
      try {
        await syncHeuristic();
        const r = await manager.applyLevels(levels());
        if (r.needsRefresh) await manager.refresh(levels(), { manual: true });
        await syncBypassRules(await bypassMap());
      } catch (e) {
        logger.error('Threat-Schutz: Synchronisierung fehlgeschlagen:', e);
      }
    },

    refresh: (manual: boolean) => manager.refresh(levels(), { manual }),

    /** The user chose "open anyway" on the warning page. The host comes from the sender's own URL, never from the message. */
    async bypass(senderUrl: string | undefined, tabId: number | undefined, duration: unknown): Promise<{ success: boolean; error?: string }> {
      if (!senderUrl || typeof tabId !== 'number' || !senderUrl.startsWith(`${origin()}/blocked.html`)) return { success: false, error: 'sender' };
      const parsed = parseWarningUrl(senderUrl);
      if (!parsed) return { success: false, error: 'url' };
      const map = await bypassMap();
      if (Object.keys(map).length >= MAX_BYPASS && !(parsed.target.hostname in map)) return { success: false, error: 'limit' };
      map[parsed.target.hostname] = duration === 'session' ? 0 : Date.now() + 10 * 60_000;
      await browser.storage.session.set({ [KEY_BYPASS]: map });
      await syncBypassRules(map);
      logger.info('[Threat] Freigabe für einen Host erteilt.');
      return { success: true };
    },

    /** Settings reset: all lists off (rules removed), all bypasses revoked. */
    async resetAll(): Promise<void> {
      for (const s of THREAT_SOURCES) await manager.setEnabled(s.id, false);
      await browser.storage.session.set({ [KEY_BYPASS]: {} });
      await syncBypassRules({});
    },

    async pruneBypass(): Promise<void> {
      const map = await bypassMap();
      const now = Date.now();
      const kept = Object.fromEntries(Object.entries(map).filter(([, exp]) => exp === 0 || exp > now));
      if (Object.keys(kept).length !== Object.keys(map).length) {
        await browser.storage.session.set({ [KEY_BYPASS]: kept });
        await syncBypassRules(kept);
      }
    },

    async status() {
      const states = await manager.getStates();
      return {
        levels: levels(),
        bypassActive: Object.keys(await bypassMap()).length,
        lists: THREAT_SOURCES.map((s) => ({
          id: s.id, kind: s.kind, name: s.name, description: s.description, license: s.license, attribution: s.attribution, approxEntries: s.approxEntries,
          maxBytes: s.maxBytes, state: states[s.id]
        }))
      };
    },

    /** Test hook, compiled in only for the end-to-end build. */
    async e2eApply(listId: string, domains: string[]): Promise<boolean> {
      const idx = THREAT_SOURCES.findIndex((s) => s.id === listId);
      if (idx < 0) return false;
      const compiled = compileThreatRules({ id: listId }, idx, domains, origin());
      const [lo, hi] = listIdRange(idx);
      const existing = await dnr().getDynamicRules();
      await dnr().updateDynamicRules({ removeRuleIds: existing.map((r) => r.id).filter((id) => id >= lo && id <= hi), addRules: compiled.rules });
      return true;
    }
  };
}
