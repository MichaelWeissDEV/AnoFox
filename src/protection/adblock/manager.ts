/**
 * List manager: owns list state, persisted filters and the transactional application of compiled
 * rules. All side effects go through injected dependencies (storage, rule application, quota).
 *
 * Transaction: stage new filters -> compile -> apply to the browser -> commit state.
 * If applying fails, previously accepted filters are restored and re-applied.
 */
import { LIST_SOURCES, getSource } from './sources.ts';
import { updateList, newState, clampInterval } from './updater.ts';
import type { ListState, UpdaterDeps, UpdateOutcome } from './updater.ts';
import { compileFilters } from './compile-dnr.ts';
import type { CompiledRule, CompileStats } from './compile-dnr.ts';
import type { NetworkFilter, CosmeticFilter, ParseResult } from './parser.ts';

export const DNR_RULE_ADBLOCK_BASE = 100_000;
export const DNR_RULE_ADBLOCK_END = 199_999;
const KEY_STATES = 'adblock:states';
const keyFilters = (id: string) => `adblock:filters:${id}`;
const keyCosmetic = (id: string) => `adblock:cosmetic:${id}`;

export interface ManagerDeps {
  updater: UpdaterDeps;
  storage: { get(key: string): Promise<unknown>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string[]): Promise<void> };
  /** Replaces all AnoFox-list DNR rules atomically; must throw if the browser rejects them. */
  applyRules(rules: CompiledRule[]): Promise<void>;
  /** How many list rules may be active (browser quota minus other modules). Read at runtime. */
  ruleBudget(): Promise<number>;
  /** Browser check (isRegexSupported). Called once per distinct regex; capped by MAX_REGEX_CHECKS. */
  regexSupported?: (regex: string, caseSensitive: boolean) => Promise<boolean>;
  /** Called after the set of active lists/filters changed (rules applied and state committed). */
  onChanged?: () => void;
}

export const MAX_REGEX_CHECKS = 3000;

export interface RefreshSummary {
  outcomes: Record<string, UpdateOutcome['status'] | string>;
  errors: Record<string, string>;
  stats?: CompileStats;
  applied: boolean;
  rolledBack: boolean;
}

type StoredFilters = Array<Omit<NetworkFilter, 'raw'>>;
type StoredCosmetic = Array<Omit<CosmeticFilter, 'raw' | 'line' | 'kind'>>;
type Staged = Map<string, ParseResult>;

export class ListManager {
  private deps: ManagerDeps;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(deps: ManagerDeps) { this.deps = deps; }

  /** Serialises all mutating operations so updates, toggles and recompiles never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  async getStates(): Promise<Record<string, ListState>> {
    const raw = (await this.deps.storage.get(KEY_STATES)) as Record<string, ListState> | undefined;
    const out: Record<string, ListState> = {};
    for (const s of LIST_SOURCES) {
      const st = raw && typeof raw === 'object' ? raw[s.id] : undefined;
      out[s.id] = st && st.id === s.id ? { ...newState(s.id), ...st, intervalMs: clampInterval(st.intervalMs) } : newState(s.id);
    }
    return out;
  }

  private async saveStates(states: Record<string, ListState>): Promise<void> {
    await this.deps.storage.set({ [KEY_STATES]: states });
  }

  private async loadFilters(id: string): Promise<NetworkFilter[]> {
    const stored = (await this.deps.storage.get(keyFilters(id))) as StoredFilters | undefined;
    return Array.isArray(stored) ? stored.map((f) => ({ ...f, raw: '' } as NetworkFilter)) : [];
  }

  private async compileAndApply(states: Record<string, ListState>, overrides: Staged): Promise<CompileStats> {
    const all: NetworkFilter[] = [];
    for (const s of LIST_SOURCES) {
      if (!states[s.id].enabled) continue;
      all.push(...(overrides.get(s.id)?.filters ?? (await this.loadFilters(s.id))));
    }
    const budget = Math.max(0, await this.deps.ruleBudget());
    let regexOk: ((r: string, cs: boolean) => boolean) | undefined;
    if (this.deps.regexSupported) {
      const verdicts = new Map<string, boolean>();
      for (const f of all) {
        if (f.pattern?.type !== 'regex') continue;
        const key = `${f.matchCase ? 1 : 0}:${f.pattern.value}`;
        if (verdicts.has(key)) continue;
        verdicts.set(key, verdicts.size < MAX_REGEX_CHECKS ? await this.deps.regexSupported(f.pattern.value, f.matchCase).catch(() => false) : false);
      }
      regexOk = (r, cs) => verdicts.get(`${cs ? 1 : 0}:${r}`) ?? false;
    }
    const { rules, stats } = compileFilters(all, {
      idBase: DNR_RULE_ADBLOCK_BASE, maxRules: Math.min(budget, DNR_RULE_ADBLOCK_END - DNR_RULE_ADBLOCK_BASE + 1),
      regexSupported: regexOk
    });
    await this.deps.applyRules(rules);
    return stats;
  }

  setEnabled(id: string, enabled: boolean): Promise<RefreshSummary> {
    return this.serial(async () => {
      const source = getSource(id);
      if (!source) return { outcomes: {}, errors: { [id]: 'unknown-list' }, applied: false, rolledBack: false };
      const states = await this.getStates();
      states[id] = { ...states[id], enabled };
      const summary: RefreshSummary = { outcomes: {}, errors: {}, applied: false, rolledBack: false };
      const staged: Staged = new Map();
      if (enabled && !states[id].current) {
        const out = await this.updateOne(states, id, true, staged);
        summary.outcomes[id] = out.status;
        if (out.reason) summary.errors[id] = out.reason;
      }
      try {
        summary.stats = await this.compileAndApply(states, staged);
        summary.applied = true;
      } catch (e) {
        summary.errors[id] = e instanceof Error ? e.message : 'apply-failed';
        return summary; // states are not committed
      }
      await this.persist(staged);
      if (!enabled) await this.deps.storage.remove([keyFilters(id), keyCosmetic(id)]);
      if (!enabled) states[id] = { ...states[id], current: undefined, lastStatus: undefined, lastError: undefined, nextCheckAt: undefined };
      await this.saveStates(states);
      this.deps.onChanged?.();
      return summary;
    });
  }

  private async persist(staged: Staged): Promise<void> {
    for (const [id, parsed] of staged) {
      const net: StoredFilters = parsed.filters.map(({ raw: _raw, ...rest }) => rest);
      const cos: StoredCosmetic = parsed.cosmetic.map(({ raw: _r, line: _l, kind: _k, ...rest }) => rest);
      await this.deps.storage.set({ [keyFilters(id)]: net, [keyCosmetic(id)]: cos });
    }
  }

  /** Cosmetic filters of all enabled lists (from storage). */
  async getCosmeticFilters(): Promise<StoredCosmetic> {
    const states = await this.getStates();
    const out: StoredCosmetic = [];
    for (const s of LIST_SOURCES) {
      if (!states[s.id].enabled) continue;
      const stored = (await this.deps.storage.get(keyCosmetic(s.id))) as StoredCosmetic | undefined;
      if (Array.isArray(stored)) out.push(...stored);
    }
    return out;
  }

  setInterval(id: string, ms: number): Promise<void> {
    return this.serial(async () => {
      const states = await this.getStates();
      if (!states[id]) return;
      states[id] = { ...states[id], intervalMs: clampInterval(ms) };
      await this.saveStates(states);
    });
  }

  private async updateOne(states: Record<string, ListState>, id: string, manual: boolean, staged?: Staged): Promise<UpdateOutcome> {
    const source = getSource(id)!;
    const out = await updateList(source, states[id], this.deps.updater, { manual });
    states[id] = out.state;
    if (out.status === 'updated' && out.parsed) {
      staged?.set(id, out.parsed);
    }
    return out;
  }

  /** Checks all enabled lists that are due (or all, if manual) and applies changes transactionally. */
  refresh(opts: { manual?: boolean } = {}): Promise<RefreshSummary> {
    return this.serial(async () => {
      const states = await this.getStates();
      const before = JSON.parse(JSON.stringify(states)) as Record<string, ListState>;
      const staged: Staged = new Map();
      const summary: RefreshSummary = { outcomes: {}, errors: {}, applied: false, rolledBack: false };

      for (const s of LIST_SOURCES) {
        if (!states[s.id].enabled) continue;
        const out = await this.updateOne(states, s.id, Boolean(opts.manual), staged);
        summary.outcomes[s.id] = out.status;
        if (out.reason && out.status !== 'not-modified') summary.errors[s.id] = out.reason;
      }

      if (staged.size === 0) {
        await this.saveStates(states); // timestamps / errors only
        return summary;
      }

      try {
        summary.stats = await this.compileAndApply(states, staged);
        summary.applied = true;
      } catch (e) {
        // Rollback: previous states and filters remain authoritative; re-apply them.
        summary.rolledBack = true;
        summary.applied = false;
        for (const id of staged.keys()) summary.errors[id] = e instanceof Error ? e.message : 'apply-failed';
        try { await this.compileAndApply(before, new Map() as Staged); } catch { /* keep going: previous rules are still active in the browser */ }
        const rolledStates = { ...before };
        for (const id of staged.keys()) {
          rolledStates[id] = { ...before[id], lastCheckAt: states[id].lastCheckAt, lastStatus: 'error', lastError: 'apply-failed' };
        }
        await this.saveStates(rolledStates);
        return summary;
      }

      // Commit: persist filters (without raw text) and states
      await this.persist(staged);
      await this.saveStates(states);
      this.deps.onChanged?.();
      return summary;
    });
  }
}
