/**
 * Bundled ("static") filter list snapshots (pure).
 *
 * Why: dynamic rules are capped at 5 000 in Firefox, so EasyList + EasyPrivacy (13 025 rules after optimisation) only fit
 * partially. Static rulesets share a separate pool of 30 000 rules (GUARANTEED_MINIMUM_STATIC_RULES; the 31 000th rule makes
 * enabling fail, measured in Firefox 158) and enable in ~0.1 s. The price: a static ruleset is a SNAPSHOT that only changes with
 * an extension release. The UI says so and shows the snapshot date.
 *
 * Only lists whose licence allows redistribution inside a GPL-3.0-or-later project are bundled (EasyList and EasyPrivacy, under
 * their GPLv3+ option). AdGuard lists (GPL-3.0 only) are NOT bundled. See docs/architecture/static-rulesets.md.
 */
import { parseList } from './parser.ts';
import { compileFilters } from './compile-dnr.ts';
import type { CompiledRule } from './compile-dnr.ts';

export const STATIC_RULE_LIMIT = 30_000; // GUARANTEED_MINIMUM_STATIC_RULES
export const STATIC_REGEX_LIMIT = 1_000; // MAX_NUMBER_OF_REGEX_RULES (shared with dynamic rules)
export const BUNDLED_PREFIX = 'bundled-';

export interface BundleInput {
  id: string; // same id as the dynamic list source (easylist, easyprivacy): the two are mutually exclusive
  name: string;
  sourceUrl: string;
  license: string;
  attribution: string;
  text: string;
  sha256: string;
  fetchedAt: string; // ISO
}

export interface BundledListMeta {
  id: string;
  rulesetId: string;
  name: string;
  sourceUrl: string;
  version?: string;
  title?: string;
  fetchedAt: string;
  sha256: string;
  filters: number;
  rules: number;
  regexRules: number;
  unsupported: number;
  cosmetic: number;
  license: string;
  attribution: string;
}

export interface BundleIndex { schema: 1; builtAt: string; lists: BundledListMeta[]; totalRules: number; totalRegexRules: number }

export interface CosmeticEntry { exception: boolean; selector: string; domains: string[]; excludedDomains: string[] }

export interface BuiltBundle {
  index: BundleIndex;
  rulesets: Record<string, CompiledRule[]>;
  cosmetic: Record<string, CosmeticEntry[]>;
}

/**
 * Compiles list texts into rulesets. Throws if anything would not fit or would be silently incomplete: a truncated snapshot
 * would be indistinguishable from a complete one at runtime.
 */
export function buildBundle(inputs: BundleInput[], builtAt: string = new Date().toISOString()): BuiltBundle {
  const lists: BundledListMeta[] = [];
  const rulesets: Record<string, CompiledRule[]> = {};
  const cosmetic: Record<string, CosmeticEntry[]> = {};
  let total = 0;
  let totalRegex = 0;
  for (const input of inputs) {
    const parsed = parseList(input.text, 'abp');
    const { rules, stats } = compileFilters(parsed.filters, { idBase: 1, maxRules: STATIC_RULE_LIMIT });
    if (stats.partial) throw new Error(`${input.id}: ${stats.truncated} filters do not fit into the static rule limit`);
    const regexRules = rules.filter((r) => r.condition.regexFilter).length;
    total += rules.length;
    totalRegex += regexRules;
    if (total > STATIC_RULE_LIMIT) throw new Error(`bundle exceeds ${STATIC_RULE_LIMIT} static rules (${total})`);
    if (totalRegex > STATIC_REGEX_LIMIT) throw new Error(`bundle exceeds ${STATIC_REGEX_LIMIT} regex rules (${totalRegex})`);
    const rulesetId = `${BUNDLED_PREFIX}${input.id}`;
    rulesets[rulesetId] = rules;
    cosmetic[input.id] = parsed.cosmetic.map((c) => ({ exception: c.exception, selector: c.selector, domains: c.domains, excludedDomains: c.excludedDomains }));
    lists.push({
      id: input.id, rulesetId, name: input.name, sourceUrl: input.sourceUrl, version: parsed.metadata.version, title: parsed.metadata.title,
      fetchedAt: input.fetchedAt, sha256: input.sha256, filters: parsed.filters.length, rules: rules.length, regexRules,
      unsupported: parsed.unsupported.length, cosmetic: parsed.cosmetic.length, license: input.license, attribution: input.attribution
    });
  }
  return { index: { schema: 1, builtAt, lists, totalRules: total, totalRegexRules: totalRegex }, rulesets, cosmetic };
}

/** Validates an index read from the extension package; null if it is not usable. */
export function validateIndex(x: unknown): BundleIndex | null {
  if (typeof x !== 'object' || x === null) return null;
  const i = x as Partial<BundleIndex>;
  if (i.schema !== 1 || !Array.isArray(i.lists) || typeof i.builtAt !== 'string') return null;
  const ok = i.lists.every((l) => l && typeof l.id === 'string' && /^[a-z0-9-]{1,40}$/.test(l.id) && l.rulesetId === `${BUNDLED_PREFIX}${l.id}`
    && typeof l.rules === 'number' && typeof l.name === 'string' && typeof l.fetchedAt === 'string' && typeof l.license === 'string');
  return ok ? (i as BundleIndex) : null;
}
