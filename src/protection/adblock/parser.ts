/**
 * Adblock-style filter list parser (network + cosmetic classification).
 *
 * Principle: never guess. A line is either translated exactly into the ParsedFilter model or it is
 * reported as Unsupported with a machine-readable reason. Nothing from a list is ever executed;
 * lists are treated purely as data.
 *
 * Supported network syntax (see docs/architecture/filter-lists.md):
 *   [@@] pattern [$options]   pattern: ||host^path, |anchor, *, ^, plain substring, /regex/
 *   options: resource types (+ negation), third-party/1p/3p, domain=, match-case, important, badfilter
 *   also: hosts-file lines ("0.0.0.0 host") and bare domain lines (opt-in via `format`)
 */

export type DnrResourceType =
  | 'main_frame' | 'sub_frame' | 'stylesheet' | 'script' | 'image' | 'font' | 'object'
  | 'xmlhttprequest' | 'ping' | 'media' | 'websocket' | 'other';

export type UnsupportedReason =
  | 'scriptlet' | 'procedural-cosmetic' | 'html-filter' | 'extended-css'
  | 'option:redirect' | 'option:removeparam' | 'option:csp' | 'option:header' | 'option:popup'
  | 'option:denyallow' | 'option:method' | 'option:to' | 'option:from' | 'option:generichide'
  | 'option:elemhide' | 'option:specifichide' | 'option:replace' | 'option:cname' | 'option:unknown'
  | 'domain:entity' | 'domain:regex' | 'pattern:non-ascii' | 'pattern:regex-unsafe' | 'pattern:empty'
  | 'pattern:too-long' | 'syntax:invalid' | 'exception:important-document';

export interface NetworkFilter {
  kind: 'network';
  line: number;
  raw: string;
  exception: boolean;
  /** urlFilter pattern in DNR syntax, or a regex source. undefined = match every URL (needs options). */
  pattern?: { type: 'urlFilter' | 'regex'; value: string };
  /** Positive resource types (already mapped). undefined = filter's default (all except main_frame). */
  resourceTypes?: DnrResourceType[];
  excludedResourceTypes?: DnrResourceType[];
  domainType?: 'thirdParty' | 'firstParty';
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  matchCase: boolean;
  important: boolean;
  badfilter: boolean;
  /** `@@...$document` : disable filtering for the whole page */
  allowAll: boolean;
}

export interface CosmeticFilter {
  kind: 'cosmetic';
  line: number;
  raw: string;
  exception: boolean;
  /** Plain CSS selector (validated for obviously dangerous constructs). */
  selector: string;
  /** Hostnames this applies to; empty = generic. */
  domains: string[];
  excludedDomains: string[];
}

export interface Unsupported {
  kind: 'unsupported';
  line: number;
  raw: string;
  reason: UnsupportedReason;
}

export type ParsedLine = NetworkFilter | CosmeticFilter | Unsupported;

export interface ParseResult {
  filters: NetworkFilter[];
  cosmetic: CosmeticFilter[];
  unsupported: Unsupported[];
  /** Number of lines that were comments/blank/metadata. */
  ignored: number;
  /** Header metadata like `! Title:`, `! Version:`, `! Expires:`. */
  metadata: Record<string, string>;
}

export type ListFormat = 'abp' | 'hosts' | 'domains';

const TYPE_MAP: Record<string, DnrResourceType> = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet', font: 'font', media: 'media',
  xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest', subdocument: 'sub_frame', frame: 'sub_frame',
  ping: 'ping', websocket: 'websocket', object: 'object', other: 'other', document: 'main_frame', doc: 'main_frame'
};

const UNSUPPORTED_OPTIONS: Record<string, UnsupportedReason> = {
  redirect: 'option:redirect', 'redirect-rule': 'option:redirect', rewrite: 'option:redirect', removeparam: 'option:removeparam',
  queryprune: 'option:removeparam', csp: 'option:csp', header: 'option:header', popup: 'option:popup',
  popunder: 'option:popup', denyallow: 'option:denyallow', method: 'option:method', to: 'option:to',
  from: 'option:from', generichide: 'option:generichide', ghide: 'option:generichide',
  elemhide: 'option:elemhide', ehide: 'option:elemhide', specifichide: 'option:specifichide',
  shide: 'option:specifichide', replace: 'option:replace', cname: 'option:cname'
};

// Options that do not change what is matched and are safe to ignore.
const NOOP_OPTIONS = new Set(['all-stream', 'empty', 'mp4', 'inline-script', 'inline-font', 'xhr-only-never']);

const MAX_PATTERN_LENGTH = 1500;

const COSMETIC_SPLIT = /^([^#$]*?)(#@?\$?\??#|#@?%#|#@?\+js\(|##\+js\()(.*)$/;

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e || s.charCodeAt(i) < 0x20) return false;
  return true;
}

/** DNR uses RE2: no lookaround, no backreferences, no lazy-possessive tricks. */
function regexLooksSafe(src: string): boolean {
  if (/\(\?[=!<]/.test(src)) return false; // lookahead / lookbehind
  if (/\\[1-9]/.test(src)) return false; // backreference
  if (/\(\?<[A-Za-z]/.test(src) && !/\(\?P?<[A-Za-z]/.test(src)) return false;
  return isAscii(src);
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function parseDomainList(raw: string): { include: string[]; exclude: string[]; error?: UnsupportedReason } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const part of raw.split('|')) {
    let d = part.trim().toLowerCase();
    if (!d) continue;
    const neg = d.startsWith('~');
    if (neg) d = d.slice(1);
    if (d.startsWith('/')) return { include, exclude, error: 'domain:regex' };
    if (d.endsWith('.*') || d.includes('*')) return { include, exclude, error: 'domain:entity' };
    if (!DOMAIN_RE.test(d) || !d.includes('.')) {
      // single-label hosts (localhost) are legal in lists but a bare TLD-like token is ambiguous
      if (!DOMAIN_RE.test(d)) return { include, exclude, error: 'syntax:invalid' };
    }
    (neg ? exclude : include).push(d);
  }
  return { include, exclude };
}

/** Splits `pattern$options` at the last unescaped `$` that starts a plausible option list. */
function splitOptions(body: string): { pattern: string; options: string | null } {
  if (body.startsWith('/')) {
    // regex filter: options follow the closing "/$"
    const m = body.match(/^(\/.*\/)\$(.*)$/);
    if (m) return { pattern: m[1], options: m[2] };
    // not a regex filter ("/banner/*/img^$opts" is a path pattern): fall through
  }
  const idx = body.lastIndexOf('$');
  if (idx === -1) return { pattern: body, options: null };
  const opts = body.slice(idx + 1);
  // a trailing "$" inside a URL pattern is not followed by option-like text
  if (!/^[~a-z0-9_-]+(=[^,]*)?(,[~a-z0-9_-]+(=[^,]*)?)*$/i.test(opts)) return { pattern: body, options: null };
  return { pattern: body.slice(0, idx), options: opts };
}

const UNSAFE_SELECTOR = /(:-abp-|:has-text|:xpath|:matches-css|:matches-path|:upward|:remove|:style|:nth-ancestor|:min-text-length|:watch-attr|:-js-|\{|\}|;|\\0)/i;

function parseCosmetic(line: number, raw: string): ParsedLine | null {
  const m = raw.match(COSMETIC_SPLIT);
  if (!m) return null;
  const [, domainPart, marker, rest] = m;
  const exception = marker.startsWith('#@');
  if (marker.includes('+js') || marker.includes('%#')) return { kind: 'unsupported', line, raw, reason: 'scriptlet' };
  if (marker.includes('$')) return { kind: 'unsupported', line, raw, reason: 'extended-css' };
  if (marker.includes('?')) return { kind: 'unsupported', line, raw, reason: 'procedural-cosmetic' };
  const selector = rest.trim();
  if (selector.startsWith('+js(')) return { kind: 'unsupported', line, raw, reason: 'scriptlet' };
  if (!selector) return { kind: 'unsupported', line, raw, reason: 'syntax:invalid' };
  if (UNSAFE_SELECTOR.test(selector)) return { kind: 'unsupported', line, raw, reason: 'procedural-cosmetic' };
  if (selector.startsWith('^')) return { kind: 'unsupported', line, raw, reason: 'html-filter' };
  const domains: string[] = [];
  const excludedDomains: string[] = [];
  for (const d0 of domainPart.split(',')) {
    let d = d0.trim().toLowerCase();
    if (!d) continue;
    const neg = d.startsWith('~');
    if (neg) d = d.slice(1);
    if (d.includes('*') || d.startsWith('/')) return { kind: 'unsupported', line, raw, reason: 'domain:entity' };
    if (!DOMAIN_RE.test(d)) return { kind: 'unsupported', line, raw, reason: 'syntax:invalid' };
    (neg ? excludedDomains : domains).push(d);
  }
  return { kind: 'cosmetic', line, raw, exception, selector, domains, excludedDomains };
}

export function parseLine(rawLine: string, line: number, format: ListFormat = 'abp'): ParsedLine | null {
  const raw = rawLine.trim();
  if (!raw) return null;

  if (format === 'hosts') {
    if (raw.startsWith('#')) return null;
    const parts = raw.split('#')[0].trim().split(/\s+/);
    if (parts.length < 2 || !/^(0\.0\.0\.0|127\.0\.0\.1|::1?)$/.test(parts[0])) return null;
    const host = parts[1].toLowerCase();
    if (host === 'localhost' || !DOMAIN_RE.test(host) || !host.includes('.')) return null;
    return mkNetwork(line, raw, false, { type: 'urlFilter', value: `||${host}^` });
  }
  if (format === 'domains') {
    if (raw.startsWith('#') || raw.startsWith('!')) return null;
    const host = raw.toLowerCase();
    if (!DOMAIN_RE.test(host) || !host.includes('.')) return { kind: 'unsupported', line, raw, reason: 'syntax:invalid' };
    return mkNetwork(line, raw, false, { type: 'urlFilter', value: `||${host}^` });
  }

  if (raw.startsWith('!') || raw.startsWith('[')) return null;

  const cosmetic = parseCosmetic(line, raw);
  if (cosmetic) return cosmetic;

  let body = raw;
  let exception = false;
  if (body.startsWith('@@')) { exception = true; body = body.slice(2); }

  const { pattern: rawPattern, options } = splitOptions(body);
  const f: NetworkFilter = {
    kind: 'network', line, raw, exception, matchCase: false, important: false, badfilter: false, allowAll: false
  };

  if (options !== null) {
    const positive: DnrResourceType[] = [];
    const negative: DnrResourceType[] = [];
    for (const opt of options.split(',')) {
      const eq = opt.indexOf('=');
      let name = (eq === -1 ? opt : opt.slice(0, eq)).trim().toLowerCase();
      const value = eq === -1 ? '' : opt.slice(eq + 1);
      const neg = name.startsWith('~');
      if (neg) name = name.slice(1);
      if (!name) return { kind: 'unsupported', line, raw, reason: 'syntax:invalid' };

      if (name in TYPE_MAP) { (neg ? negative : positive).push(TYPE_MAP[name]); continue; }
      switch (name) {
        case 'third-party': case '3p': f.domainType = neg ? 'firstParty' : 'thirdParty'; continue;
        case 'first-party': case '1p': f.domainType = neg ? 'thirdParty' : 'firstParty'; continue;
        case 'match-case': f.matchCase = true; continue;
        case 'important': f.important = true; continue;
        case 'badfilter': f.badfilter = true; continue;
        case 'domain': {
          const d = parseDomainList(value);
          if (d.error) return { kind: 'unsupported', line, raw, reason: d.error };
          if (d.include.length) f.initiatorDomains = d.include;
          if (d.exclude.length) f.excludedInitiatorDomains = d.exclude;
          continue;
        }
        default:
          if (NOOP_OPTIONS.has(name)) continue;
          return { kind: 'unsupported', line, raw, reason: UNSUPPORTED_OPTIONS[name] ?? 'option:unknown' };
      }
    }
    // `$document` alone as exception = allowAll; as block it targets main_frame navigation
    if (positive.includes('main_frame') && exception && positive.length === 1 && !f.domainType) {
      f.allowAll = true;
    }
    if (positive.length) f.resourceTypes = Array.from(new Set(positive));
    if (negative.length) f.excludedResourceTypes = Array.from(new Set(negative));
  }

  let pattern = rawPattern;
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    const src = pattern.slice(1, -1);
    if (!regexLooksSafe(src)) {
      return { kind: 'unsupported', line, raw, reason: isAscii(src) ? 'pattern:regex-unsafe' : 'pattern:non-ascii' };
    }
    f.pattern = { type: 'regex', value: src };
  } else {
    if (pattern === '' || pattern === '*') {
      pattern = '';
    }
    if (pattern.length > MAX_PATTERN_LENGTH) return { kind: 'unsupported', line, raw, reason: 'pattern:too-long' };
    if (!isAscii(pattern)) return { kind: 'unsupported', line, raw, reason: 'pattern:non-ascii' };
    if (pattern === '') {
      // pattern-less filters are only meaningful with options that narrow them
      const narrowed = f.resourceTypes || f.domainType || f.initiatorDomains;
      if (!narrowed) return { kind: 'unsupported', line, raw, reason: 'pattern:empty' };
    } else {
      f.pattern = { type: 'urlFilter', value: pattern };
    }
  }
  if (f.allowAll && f.important) return { kind: 'unsupported', line, raw, reason: 'exception:important-document' };
  return f;
}

function mkNetwork(line: number, raw: string, exception: boolean, pattern: NetworkFilter['pattern']): NetworkFilter {
  return { kind: 'network', line, raw, exception, pattern, matchCase: false, important: false, badfilter: false, allowAll: false };
}

export function parseList(text: string, format: ListFormat = 'abp'): ParseResult {
  const out: ParseResult = { filters: [], cosmetic: [], unsupported: [], ignored: 0, metadata: {} };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (format === 'abp' && i < 40) {
      const meta = rawLine.match(/^!\s*(Title|Version|Expires|Last modified|Homepage|Licen[sc]e)\s*:\s*(.+)$/i);
      if (meta) out.metadata[meta[1].toLowerCase()] = meta[2].trim().slice(0, 200);
    }
    const parsed = parseLine(rawLine, i + 1, format);
    if (!parsed) { out.ignored++; continue; }
    if (parsed.kind === 'network') out.filters.push(parsed);
    else if (parsed.kind === 'cosmetic') out.cosmetic.push(parsed);
    else out.unsupported.push(parsed);
  }
  return out;
}

export function summarizeUnsupported(items: Unsupported[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of items) counts[u.reason] = (counts[u.reason] ?? 0) + 1;
  return counts;
}
