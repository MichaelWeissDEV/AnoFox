/**
 * Compiles parsed network filters into declarativeNetRequest rules.
 *
 * Priority (adblock band, all below policy/embed bands, see protection/network/compile.ts):
 *   1  block / exception (equal priority: DNR lets allow win, matching ABP "exceptions beat blocks")
 *   2  $important blocks (beat ordinary exceptions)
 *   3  $document exceptions (allowAllRequests) - beats important blocks inside that page
 *
 * Optimisations that keep semantics identical:
 *   - `||host^` filters with equal options are merged into one rule using requestDomains
 *   - exact duplicates are dropped; `$badfilter` cancels its target
 * Limits: the caller supplies `maxRules` (read from the browser at runtime, never assumed).
 */

import type { NetworkFilter, DnrResourceType } from './parser.ts';

export const PRIORITY_ADBLOCK = 1;
export const PRIORITY_ADBLOCK_IMPORTANT = 2;
export const PRIORITY_ADBLOCK_ALLOW_ALL = 3;

export interface CompiledRule {
  id: number;
  priority: number;
  action: { type: 'block' | 'allow' | 'allowAllRequests' };
  condition: {
    urlFilter?: string;
    regexFilter?: string;
    isUrlFilterCaseSensitive?: boolean;
    resourceTypes?: DnrResourceType[];
    excludedResourceTypes?: DnrResourceType[];
    domainType?: 'thirdParty' | 'firstParty';
    initiatorDomains?: string[];
    excludedInitiatorDomains?: string[];
    requestDomains?: string[];
  };
}

export interface CompileOptions {
  /** First rule id to use. */
  idBase: number;
  /** Maximum number of rules to emit (browser quota minus what other modules use). */
  maxRules: number;
  /** Max domains merged into one requestDomains rule. */
  maxDomainsPerRule?: number;
  /** Returns false for regexes the browser engine rejects (isRegexSupported). */
  regexSupported?: (regex: string, caseSensitive: boolean) => boolean;
}

export interface CompileStats {
  input: number;
  badfiltered: number;
  duplicates: number;
  mergedDomains: number;
  regexRejected: number;
  emitted: number;
  /** Filters dropped because maxRules was reached (blocks are dropped before exceptions). */
  truncated: number;
  /** True if truncation happened: the list is only partially enforced. */
  partial: boolean;
}

export interface CompileResult {
  rules: CompiledRule[];
  stats: CompileStats;
  /** Lines that were valid filters but could not be compiled, with reason. */
  rejected: Array<{ line: number; raw: string; reason: string }>;
}

const SIMPLE_HOST = /^\|\|([a-z0-9][a-z0-9.-]*[a-z0-9])\^$/;

function normalizeKey(f: NetworkFilter): string {
  return JSON.stringify([
    f.exception, f.pattern, f.resourceTypes?.slice().sort(), f.excludedResourceTypes?.slice().sort(),
    f.domainType, f.initiatorDomains?.slice().sort(), f.excludedInitiatorDomains?.slice().sort(),
    f.matchCase, f.important, f.allowAll
  ]);
}

function priorityOf(f: NetworkFilter): number {
  if (f.allowAll) return PRIORITY_ADBLOCK_ALLOW_ALL;
  if (!f.exception && f.important) return PRIORITY_ADBLOCK_IMPORTANT;
  return PRIORITY_ADBLOCK;
}

function baseCondition(f: NetworkFilter): CompiledRule['condition'] {
  const c: CompiledRule['condition'] = {};
  if (f.pattern?.type === 'urlFilter') c.urlFilter = f.pattern.value;
  if (f.pattern?.type === 'regex') c.regexFilter = f.pattern.value;
  if (f.matchCase) c.isUrlFilterCaseSensitive = true;
  if (f.allowAll) {
    c.resourceTypes = ['main_frame', 'sub_frame'];
  } else {
    if (f.resourceTypes) c.resourceTypes = f.resourceTypes;
    if (f.excludedResourceTypes) c.excludedResourceTypes = f.excludedResourceTypes;
  }
  if (f.domainType) c.domainType = f.domainType;
  if (f.initiatorDomains) c.initiatorDomains = f.initiatorDomains;
  if (f.excludedInitiatorDomains) c.excludedInitiatorDomains = f.excludedInitiatorDomains;
  return c;
}

function actionOf(f: NetworkFilter): CompiledRule['action'] {
  if (f.allowAll) return { type: 'allowAllRequests' };
  return { type: f.exception ? 'allow' : 'block' };
}

export function compileFilters(filters: NetworkFilter[], opts: CompileOptions): CompileResult {
  const stats: CompileStats = {
    input: filters.length, badfiltered: 0, duplicates: 0, mergedDomains: 0, regexRejected: 0,
    emitted: 0, truncated: 0, partial: false
  };
  const rejected: CompileResult['rejected'] = [];
  const maxDomains = opts.maxDomainsPerRule ?? 500;

  // 1. $badfilter: cancels the filter with identical key (minus badfilter flag)
  const bad = new Set<string>();
  for (const f of filters) if (f.badfilter) bad.add(normalizeKey({ ...f, badfilter: false }));
  const active: NetworkFilter[] = [];
  for (const f of filters) {
    if (f.badfilter) { stats.badfiltered++; continue; }
    if (bad.has(normalizeKey(f))) { stats.badfiltered++; continue; }
    active.push(f);
  }

  // 2. dedupe + 3. group simple host filters
  const seen = new Set<string>();
  type Group = { template: NetworkFilter; hosts: string[] };
  const groups = new Map<string, Group>();
  const singles: NetworkFilter[] = [];
  for (const f of active) {
    const key = normalizeKey(f);
    if (seen.has(key)) { stats.duplicates++; continue; }
    seen.add(key);

    if (f.pattern?.type === 'regex') {
      if (opts.regexSupported && !opts.regexSupported(f.pattern.value, f.matchCase)) {
        stats.regexRejected++;
        rejected.push({ line: f.line, raw: f.raw, reason: 'regex-not-supported-by-browser' });
        continue;
      }
    }
    const m = f.pattern?.type === 'urlFilter' ? f.pattern.value.match(SIMPLE_HOST) : null;
    if (m && !f.allowAll && !f.matchCase) {
      const gKey = JSON.stringify([f.exception, f.resourceTypes?.slice().sort(), f.excludedResourceTypes?.slice().sort(),
        f.domainType, f.initiatorDomains?.slice().sort(), f.excludedInitiatorDomains?.slice().sort(), f.important]);
      let g = groups.get(gKey);
      if (!g) { g = { template: f, hosts: [] }; groups.set(gKey, g); }
      g.hosts.push(m[1]);
    } else {
      singles.push(f);
    }
  }

  // 4. materialise (exceptions first so that truncation drops blocks, never exceptions)
  const emit: Array<Omit<CompiledRule, 'id'> & { exception: boolean; weight: number }> = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.hosts.length; i += maxDomains) {
      const hosts = g.hosts.slice(i, i + maxDomains);
      const c = baseCondition({ ...g.template, pattern: undefined });
      if (hosts.length === 1) c.urlFilter = `||${hosts[0]}^`;
      else { c.requestDomains = hosts; stats.mergedDomains += hosts.length; }
      emit.push({ priority: priorityOf(g.template), action: actionOf(g.template), condition: c, exception: g.template.exception, weight: hosts.length });
    }
  }
  for (const f of singles) {
    emit.push({ priority: priorityOf(f), action: actionOf(f), condition: baseCondition(f), exception: f.exception || f.allowAll, weight: 1 });
  }
  emit.sort((a, b) => Number(b.exception) - Number(a.exception));

  const rules: CompiledRule[] = [];
  for (const e of emit) {
    if (rules.length >= opts.maxRules) { stats.truncated += e.weight; continue; }
    rules.push({ id: opts.idBase + rules.length, priority: e.priority, action: e.action, condition: e.condition });
  }
  stats.emitted = rules.length;
  stats.partial = stats.truncated > 0;
  return { rules, stats, rejected };
}
