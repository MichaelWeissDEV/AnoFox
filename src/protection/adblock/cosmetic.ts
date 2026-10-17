/**
 * Cosmetic filter index and CSS generation (pure, no browser APIs).
 *
 * - Only plain CSS selectors reach this module (the parser rejects procedural/extended syntax,
 *   scriptlets and style injection). Selectors are additionally validated here before they are ever
 *   placed into a stylesheet.
 * - One CSS rule per selector: an invalid selector then only drops its own rule instead of the
 *   whole list. Each rule sits on its own line to bound the damage of a malformed string.
 * - The only declaration ever emitted is `display:none !important`.
 * - Generic selectors are indexed by a mandatory class/id token and only emitted once the page
 *   actually contains that token (avoids shipping ~13k rules to every page).
 */
import type { CosmeticFilter } from './parser.ts';
import { hostMatches, normalizeHost } from '../../core/domain-utils/domains.ts';

export const MAX_SELECTOR_LENGTH = 1000;
export const MAX_SELECTORS_PER_INJECTION = 2000;
export const MAX_CSS_BYTES = 256 * 1024;
export const HIDE_DECLARATION = '{display:none!important}';

const FORBIDDEN = /[{};<@\u0000-\u001f\u007f]|\/\*|\*\/|\\0|-->/;

/** True if the selector is safe to embed in a stylesheet (no breakout, balanced quoting). */
export function isSafeSelector(sel: string): boolean {
  if (!sel || sel.length > MAX_SELECTOR_LENGTH || FORBIDDEN.test(sel)) return false;
  let paren = 0; let bracket = 0; let quote = '';
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') { if (--paren < 0) return false; }
    else if (ch === '[') bracket++;
    else if (ch === ']') { if (--bracket < 0) return false; }
  }
  return !quote && paren === 0 && bracket === 0;
}

/** First class/id token that the selector requires an element to carry (outside :not()/:is()/attribute/strings). */
export function mandatoryToken(sel: string): { kind: 'class' | 'id'; name: string } | null {
  let depth = 0; let bracket = 0; let quote = '';
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (quote) { if (ch === '\\') { i++; } else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\') return null; // escaped identifiers: do not guess
    if (ch === '[') { bracket++; continue; }
    if (ch === ']') { bracket--; continue; }
    if (bracket > 0) continue;
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth > 0) continue;
    if (ch === '.' || ch === '#') {
      const m = sel.slice(i + 1).match(/^-?[_a-zA-Z][\w-]*/);
      if (m) {
        if (sel[i + 1 + m[0].length] === '\\') return null; // escaped continuation: the real token differs
        return { kind: ch === '.' ? 'class' : 'id', name: m[0] };
      }
    }
  }
  return null;
}

interface Entry { selector: string; excluded: string[] }

export interface CosmeticStats {
  generic: number; tokenized: number; always: number; specific: number; exceptions: number; rejected: number;
}

export class CosmeticIndex {
  private byDomain = new Map<string, Entry[]>();
  private byClass = new Map<string, Entry[]>();
  private byId = new Map<string, Entry[]>();
  private always: Entry[] = [];
  private exceptByDomain = new Map<string, Set<string>>();
  private exceptGlobal = new Set<string>();
  readonly stats: CosmeticStats = { generic: 0, tokenized: 0, always: 0, specific: 0, exceptions: 0, rejected: 0 };

  constructor(filters: Iterable<Pick<CosmeticFilter, 'exception' | 'selector' | 'domains' | 'excludedDomains'>>) {
    for (const f of filters) {
      if (!isSafeSelector(f.selector)) { this.stats.rejected++; continue; }
      if (f.exception) {
        this.stats.exceptions++;
        if (f.domains.length === 0) this.exceptGlobal.add(f.selector);
        for (const d of f.domains) {
          let set = this.exceptByDomain.get(d);
          if (!set) this.exceptByDomain.set(d, (set = new Set()));
          set.add(f.selector);
        }
        continue;
      }
      const entry: Entry = { selector: f.selector, excluded: f.excludedDomains };
      if (f.domains.length > 0) {
        this.stats.specific++;
        for (const d of f.domains) {
          const list = this.byDomain.get(d);
          if (list) list.push(entry); else this.byDomain.set(d, [entry]);
        }
        continue;
      }
      this.stats.generic++;
      const tok = mandatoryToken(f.selector);
      if (!tok) { this.always.push(entry); this.stats.always++; continue; }
      const map = tok.kind === 'class' ? this.byClass : this.byId;
      const key = tok.name.toLowerCase();
      const list = map.get(key);
      if (list) list.push(entry); else map.set(key, [entry]);
      this.stats.tokenized++;
    }
  }

  isEmpty(): boolean {
    return this.stats.generic + this.stats.specific === 0;
  }

  private excepted(host: string): (sel: string) => boolean {
    const sets: Array<Set<string>> = [this.exceptGlobal];
    for (const cand of hostCandidates(host)) {
      const s = this.exceptByDomain.get(cand);
      if (s) sets.push(s);
    }
    return (sel) => sets.some((s) => s.has(sel));
  }

  private allowed(e: Entry, host: string): boolean {
    return !e.excluded.some((d) => hostMatches(host, d));
  }

  /** Selectors that apply to the whole document of `host` regardless of its content. */
  hostSelectors(host: string): string[] {
    const h = normalizeHost(host);
    const skip = this.excepted(h);
    const out = new Set<string>();
    for (const cand of hostCandidates(h)) {
      for (const e of this.byDomain.get(cand) ?? []) if (this.allowed(e, h) && !skip(e.selector)) out.add(e.selector);
    }
    for (const e of this.always) if (this.allowed(e, h) && !skip(e.selector)) out.add(e.selector);
    return Array.from(out);
  }

  /** Generic selectors whose mandatory class/id token occurs in the page. */
  tokenSelectors(host: string, tokens: { classes?: string[]; ids?: string[] }): string[] {
    const h = normalizeHost(host);
    const skip = this.excepted(h);
    const out = new Set<string>();
    const collect = (map: Map<string, Entry[]>, names: string[] | undefined) => {
      for (const n of names ?? []) {
        for (const e of map.get(n.toLowerCase()) ?? []) if (this.allowed(e, h) && !skip(e.selector)) out.add(e.selector);
      }
    };
    collect(this.byClass, tokens.classes);
    collect(this.byId, tokens.ids);
    return Array.from(out);
  }
}

/** host a.b.example.com -> [a.b.example.com, b.example.com, example.com] (never a bare TLD). */
export function hostCandidates(host: string): string[] {
  const labels = normalizeHost(host).split('.');
  if (labels.length === 1) return [labels[0]];
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** Builds the stylesheet text. Returns '' if nothing safe remains. */
export function buildCss(selectors: string[]): string {
  const lines: string[] = [];
  let bytes = 0;
  for (const s of selectors.slice(0, MAX_SELECTORS_PER_INJECTION)) {
    if (!isSafeSelector(s)) continue;
    const line = s + HIDE_DECLARATION;
    bytes += line.length + 1;
    if (bytes > MAX_CSS_BYTES) break;
    lines.push(line);
  }
  return lines.join('\n');
}
