/**
 * Filter list updater. Pure logic with injected `fetch`, clock and hashing so it is fully testable.
 *
 * Guarantees
 *  - Only allowlisted HTTPS sources, final (post-redirect) URL re-validated.
 *  - Request carries no cookies, no referrer, no user data, no visited URLs; only conditional headers.
 *  - Timeout and streaming size cap; oversized bodies are aborted, not buffered.
 *  - Body must look like a filter list (not HTML, parseable, plausible size vs. previous version).
 *  - On ANY failure the previously accepted list stays untouched (rollback by construction).
 *  - Lists are unsigned: integrity = HTTPS + SHA-256 recorded for audit/change detection, not authenticity.
 */
import type { ListSource } from './sources.ts';
import { isUrlAllowedForSource } from './sources.ts';
import { parseList } from './parser.ts';
import type { ParseResult } from './parser.ts';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_INTERVAL_MS = 6 * 3600_000;
export const MAX_INTERVAL_MS = 30 * 24 * 3600_000;
export const DEFAULT_INTERVAL_MS = 4 * 24 * 3600_000;
export const MANUAL_COOLDOWN_MS = 5 * 60_000;
/** A new version with fewer than this fraction of the previous network filters is rejected as suspicious. */
export const MIN_SHRINK_RATIO = 0.5;

export interface ListMeta {
  etag?: string;
  lastModified?: string;
  sha256: string;
  version?: string;
  title?: string;
  fetchedAt: number;
  bytes: number;
  filterCount: number;
  unsupportedCount: number;
  cosmeticCount: number;
}

export interface ListState {
  id: string;
  enabled: boolean;
  /** Accepted list (metadata only; filters live in the compiled store). */
  current?: ListMeta;
  lastCheckAt?: number;
  nextCheckAt?: number;
  lastStatus?: UpdateStatus;
  lastError?: string;
  intervalMs: number;
}

export type UpdateStatus = 'updated' | 'not-modified' | 'rejected' | 'error' | 'cooldown' | 'disabled';

export interface UpdateOutcome {
  status: UpdateStatus;
  reason?: string;
  meta?: ListMeta;
  parsed?: ParseResult;
  state: ListState;
}

export interface UpdaterDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sha256: (bytes: Uint8Array) => Promise<string>;
  timeoutMs?: number;
}

export function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}

export function newState(id: string): ListState {
  return { id, enabled: false, intervalMs: DEFAULT_INTERVAL_MS };
}

/** Parses "! Expires: 4 days" / "12 hours" into ms, bounded. */
export function parseExpires(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = value.match(/^(\d+)\s*(hour|hours|h|day|days|d)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = n * (unit.startsWith('h') ? 3600_000 : 24 * 3600_000);
  return clampInterval(ms);
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | { error: string }> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { error: 'too-large' };
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? { error: 'too-large' } : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) { await reader.cancel().catch(() => undefined); return { error: 'timeout' }; }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); return { error: 'too-large' }; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function fail(state: ListState, now: number, status: UpdateStatus, reason: string): UpdateOutcome {
  // `current` is intentionally untouched
  const interval = state.intervalMs;
  const next: ListState = {
    ...state, lastCheckAt: now, lastStatus: status, lastError: reason,
    // retry sooner than a full interval after failures, but never faster than the minimum
    nextCheckAt: now + Math.min(interval, Math.max(MIN_INTERVAL_MS, interval / 4))
  };
  return { status, reason, state: next };
}

export async function updateList(
  source: ListSource, state: ListState, deps: UpdaterDeps, opts: { manual?: boolean } = {}
): Promise<UpdateOutcome> {
  const now = deps.now();
  if (!state.enabled) return { status: 'disabled', state };
  if (opts.manual && state.lastCheckAt !== undefined && now - state.lastCheckAt < MANUAL_COOLDOWN_MS) {
    return { status: 'cooldown', reason: 'manual-cooldown', state };
  }
  if (!opts.manual && state.nextCheckAt !== undefined && now < state.nextCheckAt) {
    return { status: 'not-modified', reason: 'not-due', state };
  }
  if (!isUrlAllowedForSource(source.url, source)) return fail(state, now, 'rejected', 'source-url-not-allowed');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'text/plain,*/*;q=0.1' };
    if (state.current?.etag) headers['If-None-Match'] = state.current.etag;
    if (state.current?.lastModified) headers['If-Modified-Since'] = state.current.lastModified;

    let res: Response;
    try {
      res = await deps.fetch(source.url, {
        method: 'GET', headers, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        redirect: 'follow', signal: controller.signal
      });
    } catch (e) {
      return fail(state, now, 'error', controller.signal.aborted ? 'timeout' : 'network');
    }

    if (res.url && !isUrlAllowedForSource(res.url, source)) return fail(state, now, 'rejected', 'redirect-target-not-allowed');

    if (res.status === 304) {
      const next: ListState = { ...state, lastCheckAt: now, lastStatus: 'not-modified', lastError: undefined, nextCheckAt: now + state.intervalMs };
      return { status: 'not-modified', state: next };
    }
    if (!res.ok) return fail(state, now, 'error', `http-${res.status}`);

    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct && !ct.startsWith('text/plain') && !ct.startsWith('application/octet-stream')) {
      return fail(state, now, 'rejected', 'unexpected-content-type');
    }

    const body = await readCapped(res, source.maxBytes, controller.signal);
    if (!(body instanceof Uint8Array)) return fail(state, now, body.error === 'timeout' ? 'error' : 'rejected', body.error);

    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return fail(state, now, 'rejected', 'invalid-utf8'); }
    const head = text.slice(0, 512).trimStart().toLowerCase();
    if (head.startsWith('<') || head.startsWith('{')) return fail(state, now, 'rejected', 'not-a-filter-list');

    const parsed = parseList(text, source.format);
    const total = parsed.filters.length + parsed.cosmetic.length + parsed.unsupported.length;
    if (parsed.filters.length === 0 || total < 10) return fail(state, now, 'rejected', 'no-plausible-filters');
    const prevCount = state.current?.filterCount ?? 0;
    if (prevCount > 0 && parsed.filters.length < prevCount * MIN_SHRINK_RATIO) {
      return fail(state, now, 'rejected', 'suspicious-shrink');
    }

    const sha256 = await deps.sha256(body);
    // the user's interval is authoritative; `Expires` metadata is only informational (see parseExpires)
    const interval = state.intervalMs;
    const meta: ListMeta = {
      etag: res.headers.get('etag') ?? undefined,
      lastModified: res.headers.get('last-modified') ?? undefined,
      sha256, version: parsed.metadata.version, title: parsed.metadata.title, fetchedAt: now, bytes: body.byteLength,
      filterCount: parsed.filters.length, unsupportedCount: parsed.unsupported.length, cosmeticCount: parsed.cosmetic.length
    };
    // Unchanged content despite a 200 (servers without conditional support): keep, no recompile needed.
    if (state.current && state.current.sha256 === sha256) {
      const next: ListState = { ...state, current: { ...state.current, fetchedAt: now, etag: meta.etag, lastModified: meta.lastModified },
        lastCheckAt: now, lastStatus: 'not-modified', lastError: undefined, nextCheckAt: now + interval };
      return { status: 'not-modified', reason: 'same-hash', state: next };
    }
    const next: ListState = { ...state, current: meta, lastCheckAt: now, lastStatus: 'updated', lastError: undefined, nextCheckAt: now + interval };
    return { status: 'updated', meta, parsed, state: next };
  } finally {
    clearTimeout(timer);
  }
}
