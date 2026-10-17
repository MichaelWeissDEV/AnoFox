/**
 * Browser-facing part of the bundled list snapshots (static DNR rulesets, see docs/architecture/static-rulesets.md).
 * The package either contains rulesets/index.json (built by `npm run build:rulesets`) or nothing; without it every
 * method is a harmless no-op and the UI says that no snapshot is shipped.
 */
import type { AnoFoxSettings } from '../../core/settings/settings.ts';
import { effectiveLevels } from '../../core/policy-engine/policy.ts';
import { validateIndex } from '../../protection/adblock/bundle.ts';
import type { BundleIndex, CosmeticEntry } from '../../protection/adblock/bundle.ts';
import { logger } from '../../logger.ts';

const KEY_WANTED = 'static:wanted';
type DnrApi = typeof browser.declarativeNetRequest & {
  getAvailableStaticRuleCount?: () => Promise<number>;
  updateEnabledRulesets: (o: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }) => Promise<void>;
};

export function createStaticRulesetService(getSettings: () => AnoFoxSettings, onCosmeticChanged: () => void) {
  const dnr = (): DnrApi => browser.declarativeNetRequest as DnrApi;
  let indexPromise: Promise<BundleIndex | null> | null = null;

  function loadIndex(): Promise<BundleIndex | null> {
    indexPromise ??= (async () => {
      try {
        const res = await fetch(browser.runtime.getURL('rulesets/index.json'));
        if (!res.ok) return null;
        return validateIndex(await res.json());
      } catch {
        return null;
      }
    })();
    return indexPromise;
  }

  async function wanted(): Promise<string[]> {
    const v = (await browser.storage.local.get(KEY_WANTED))[KEY_WANTED];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  /** Ruleset ids that should be active now: the user's choice, and only while the adblock module is not off. */
  async function desired(index: BundleIndex): Promise<string[]> {
    const s = getSettings();
    if (effectiveLevels({ profile: s.profile, customLevels: s.customLevels, rules: [] }).adblock === 'off') return [];
    const want = new Set(await wanted());
    return index.lists.filter((l) => want.has(l.id)).map((l) => l.rulesetId);
  }

  async function syncNow(): Promise<boolean> {
    const index = await loadIndex();
    if (!index) return true;
    const want = new Set(await desired(index));
    const have = new Set(await dnr().getEnabledRulesets());
    const all = index.lists.map((l) => l.rulesetId);
    const enable = all.filter((id) => want.has(id) && !have.has(id));
    const disable = all.filter((id) => !want.has(id) && have.has(id));
    if (!enable.length && !disable.length) return true;
    try {
      await dnr().updateEnabledRulesets({ enableRulesetIds: enable, disableRulesetIds: disable });
      onCosmeticChanged();
      return true;
    } catch (e) {
      logger.error('Gebündelte Listen konnten nicht umgeschaltet werden:', e);
      return false;
    }
  }

  return {
    sync: () => serial(syncNow),

    /** Marks a snapshot list as wanted/unwanted and applies it. Returns an error text on failure. */
    setWanted(id: string, on: boolean): Promise<string | null> {
      return serial(async () => {
        const index = await loadIndex();
        if (!index?.lists.some((l) => l.id === id)) return 'unknown-list';
        const set = new Set(await wanted());
        if (on) set.add(id); else set.delete(id);
        await browser.storage.local.set({ [KEY_WANTED]: [...set] });
        return (await syncNow()) ? null : 'apply-failed';
      });
    },

    isWanted: async (id: string) => (await wanted()).includes(id),

    async clear(): Promise<void> {
      await serial(async () => { await browser.storage.local.remove(KEY_WANTED); await syncNow(); });
    },

    /** Cosmetic filters of the snapshot lists that are currently active. */
    async cosmeticFilters(): Promise<CosmeticEntry[]> {
      const index = await loadIndex();
      if (!index) return [];
      const active = new Set(await dnr().getEnabledRulesets());
      const out: CosmeticEntry[] = [];
      for (const l of index.lists) {
        if (!active.has(l.rulesetId)) continue;
        try {
          const res = await fetch(browser.runtime.getURL(`rulesets/cosmetic-${l.id}.json`));
          const data = await res.json();
          if (Array.isArray(data)) out.push(...(data as CosmeticEntry[]));
        } catch (e) {
          logger.debug('Kosmetikfilter des Schnappschusses nicht lesbar:', e);
        }
      }
      return out;
    },

    async status() {
      const index = await loadIndex();
      if (!index) return { available: false as const };
      const active = new Set(await dnr().getEnabledRulesets());
      const want = new Set(await wanted());
      return {
        available: true as const,
        builtAt: index.builtAt,
        totalRules: index.totalRules,
        availableStaticRules: await dnr().getAvailableStaticRuleCount?.().catch(() => undefined),
        lists: index.lists.map((l) => ({ ...l, wanted: want.has(l.id), active: active.has(l.rulesetId) }))
      };
    }
  };
}
