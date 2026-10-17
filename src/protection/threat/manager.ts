/**
 * Threat list manager: download -> parse -> guards -> compile -> atomic apply per list -> commit state.
 * Domains are NOT stored (the installed DNR rules are the data; an update replaces a list's id range atomically, so a
 * failed update leaves the previous rules in force). Only small state objects are persisted.
 */
import { THREAT_SOURCES, getThreatSource } from './sources.ts';
import type { ThreatSource, ThreatKind } from './sources.ts';
import { parseDomainEntries } from './domains.ts';
import { compileThreatRules } from './compile.ts';
import { fetchListText, failOutcome, newState, clampInterval } from '../adblock/updater.ts';
import type { ListState, UpdaterDeps, UpdateStatus } from '../adblock/updater.ts';
import type { Level } from '../../core/policy-engine/policy.ts';

type DnrRule = browser.declarativeNetRequest.Rule;
const KEY_STATES = 'threat:states';

export const MIN_SHRINK = 0.4;
export const MAX_GROWTH = 3;
export const MAX_NEVER_BLOCK_RATIO = 0.05;

export interface ThreatState extends ListState {
  installed?: boolean;
  ruleCount?: number;
  invalid?: number;
  droppedNeverBlock?: number;
}

export interface ThreatManagerDeps {
  updater: UpdaterDeps;
  storage: { get(key: string): Promise<unknown>; set(items: Record<string, unknown>): Promise<void> };
  extensionOrigin: string;
  /** Atomically replaces all rules in the list's id range; throws if the browser rejects them (old rules stay). */
  replaceRules(listIndex: number, rules: DnrRule[]): Promise<void>;
  clearRules(listIndex: number): Promise<void>;
  /** Free quota for threat rules (dynamic rules, regex rules), already net of what this list currently uses. */
  budget(listIndex: number): Promise<{ rules: number; regexRules: number }>;
}

export interface ThreatRefreshSummary {
  outcomes: Record<string, UpdateStatus | string>;
  errors: Record<string, string>;
  applied: string[];
}

export class ThreatListManager {
  private deps: ThreatManagerDeps;
  private busy: Promise<unknown> = Promise.resolve();
  constructor(deps: ThreatManagerDeps) { this.deps = deps; }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  async getStates(): Promise<Record<string, ThreatState>> {
    const raw = (await this.deps.storage.get(KEY_STATES)) as Record<string, ThreatState> | undefined;
    const out: Record<string, ThreatState> = {};
    for (const s of THREAT_SOURCES) {
      const st = raw && typeof raw === 'object' ? raw[s.id] : undefined;
      const base = { ...newState(s.id), intervalMs: s.defaultIntervalMs };
      out[s.id] = st && st.id === s.id ? { ...base, ...st, intervalMs: clampInterval(st.intervalMs) } : base;
    }
    return out;
  }

  private save(states: Record<string, ThreatState>): Promise<void> {
    return this.deps.storage.set({ [KEY_STATES]: states });
  }

  private index(id: string): number { return THREAT_SOURCES.findIndex((s) => s.id === id); }

  /** One list: fetch, validate, compile, apply. Mutates `states[id]`; never throws. */
  private async updateOne(states: Record<string, ThreatState>, source: ThreatSource, manual: boolean): Promise<{ status: string; reason?: string; applied: boolean }> {
    const id = source.id;
    const state = states[id];
    const f = await fetchListText(source, state, this.deps.updater, { manual });
    if (f.status === 'done') { states[id] = { ...state, ...f.outcome.state }; return { status: f.outcome.status, reason: f.outcome.reason, applied: false }; }
    const now = f.now;
    const reject = (reason: string) => { states[id] = { ...state, ...failOutcome(state, now, 'rejected', reason).state }; return { status: 'rejected', reason, applied: false }; };

    if (state.current && state.current.sha256 === f.sha256 && state.installed) {
      states[id] = { ...state, current: { ...state.current, fetchedAt: now, etag: f.etag, lastModified: f.lastModified }, lastCheckAt: now, lastStatus: 'not-modified', lastError: undefined, nextCheckAt: now + state.intervalMs };
      return { status: 'not-modified', reason: 'same-hash', applied: false };
    }
    const parsed = parseDomainEntries(f.text);
    const total = parsed.domains.length + parsed.droppedNeverBlock;
    if (parsed.domains.length < 5) return reject('no-plausible-entries');
    if (parsed.droppedNeverBlock / Math.max(1, total) > MAX_NEVER_BLOCK_RATIO) return reject('suspicious-content');
    const prev = state.current?.filterCount ?? 0;
    if (prev > 0 && parsed.domains.length < prev * MIN_SHRINK) return reject('suspicious-shrink');
    if (prev >= 100 && parsed.domains.length > prev * MAX_GROWTH) return reject('suspicious-growth');

    const listIndex = this.index(id);
    const compiled = compileThreatRules(source, listIndex, parsed.domains, this.deps.extensionOrigin);
    const budget = await this.deps.budget(listIndex);
    if (compiled.rules.length > budget.rules || compiled.regexRules > budget.regexRules) return reject('quota-exceeded');
    try {
      await this.deps.replaceRules(listIndex, compiled.rules);
    } catch (e) {
      states[id] = { ...state, ...failOutcome(state, now, 'error', 'apply-failed').state };
      return { status: 'error', reason: e instanceof Error ? e.message.slice(0, 120) : 'apply-failed', applied: false };
    }
    states[id] = {
      ...state, installed: true, ruleCount: compiled.rules.length, invalid: parsed.invalid, droppedNeverBlock: parsed.droppedNeverBlock,
      current: { etag: f.etag, lastModified: f.lastModified, sha256: f.sha256, title: parsed.metadata.title, version: parsed.metadata.updated,
        fetchedAt: now, bytes: f.bytes, filterCount: parsed.domains.length, unsupportedCount: parsed.invalid, cosmeticCount: 0 },
      lastCheckAt: now, lastStatus: 'updated', lastError: undefined, nextCheckAt: now + state.intervalMs
    };
    return { status: 'updated', applied: true };
  }

  setEnabled(id: string, enabled: boolean, level: Level = 'balanced'): Promise<ThreatRefreshSummary> {
    return this.serial(async () => {
      const source = getThreatSource(id);
      const summary: ThreatRefreshSummary = { outcomes: {}, errors: {}, applied: [] };
      if (!source) { summary.errors[id] = 'unknown-list'; return summary; }
      const states = await this.getStates();
      states[id] = { ...states[id], enabled };
      if (!enabled) {
        await this.deps.clearRules(this.index(id));
        states[id] = { ...states[id], installed: false, ruleCount: 0, current: undefined, nextCheckAt: undefined, lastStatus: undefined, lastError: undefined };
        await this.save(states);
        return summary;
      }
      if (level !== 'off') {
        const r = await this.updateOne(states, source, true);
        summary.outcomes[id] = r.status;
        if (r.reason && r.status !== 'not-modified') summary.errors[id] = r.reason;
        if (r.applied) summary.applied.push(id);
      }
      await this.save(states);
      return summary;
    });
  }

  /** Checks all enabled lists of a kind whose module is not off. `manual` bypasses the schedule (not the cooldown). */
  refresh(levels: Record<ThreatKind, Level>, opts: { manual?: boolean } = {}): Promise<ThreatRefreshSummary> {
    return this.serial(async () => {
      const summary: ThreatRefreshSummary = { outcomes: {}, errors: {}, applied: [] };
      const states = await this.getStates();
      for (const s of THREAT_SOURCES) {
        if (!states[s.id].enabled || levels[s.kind] === 'off') continue;
        const r = await this.updateOne(states, s, Boolean(opts.manual));
        summary.outcomes[s.id] = r.status;
        if (r.reason && r.status !== 'not-modified') summary.errors[s.id] = r.reason;
        if (r.applied) summary.applied.push(s.id);
      }
      await this.save(states);
      return summary;
    });
  }

  /** Module level changed: remove rules of lists whose module is now off (their data is gone, re-enabling downloads again). */
  applyLevels(levels: Record<ThreatKind, Level>): Promise<{ cleared: string[]; needsRefresh: boolean }> {
    return this.serial(async () => {
      const states = await this.getStates();
      const cleared: string[] = [];
      let needsRefresh = false;
      for (const s of THREAT_SOURCES) {
        const st = states[s.id];
        if (!st.enabled) continue;
        if (levels[s.kind] === 'off' && st.installed) {
          await this.deps.clearRules(this.index(s.id));
          states[s.id] = { ...st, installed: false, ruleCount: 0, current: undefined, nextCheckAt: undefined };
          cleared.push(s.id);
        } else if (levels[s.kind] !== 'off' && !st.installed) {
          needsRefresh = true;
        }
      }
      if (cleared.length) await this.save(states);
      return { cleared, needsRefresh };
    });
  }
}
