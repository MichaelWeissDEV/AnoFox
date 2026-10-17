/**
 * Compiles threat domain lists into declarativeNetRequest rules (pure).
 *
 *   main_frame  -> redirect to the extension's warning page, carrying list id and the original URL
 *   all other   -> block
 * Domains are grouped into few rules (`requestDomains`, measured in Firefox 158: 400 000 domains install in ~0.65 s,
 * matching is exact host plus subdomains, IPv4 literals and punycode hosts work, no latency change).
 *
 * Priority band 15: above ad-blocking (1-5) and the URL cleaner (6/10) so neither can lift a threat block, below the
 * policy bands (20+). The user's per-host bypass (17) lifts ONLY threat rules.
 */
import type { ThreatSource } from './sources.ts';

export const DNR_RULE_THREAT_BASE = 200_000;
export const DNR_RULE_THREAT_LIST_SPAN = 10_000; // ids per list
export const DNR_RULE_THREAT_HEURISTIC = 299_990;
export const DNR_RULE_THREAT_END = 299_999;
export const DNR_RULE_THREAT_BYPASS_BASE = 7_000; // session rules
export const DNR_RULE_THREAT_BYPASS_END = 7_099;
export const PRIORITY_THREAT = 15;
export const PRIORITY_THREAT_BYPASS = 17;
export const DOMAINS_PER_RULE = 2000;
export const BLOCKED_PAGE = 'blocked.html';

export const SUBRESOURCE_TYPES = ['sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'] as const;

type DnrRule = browser.declarativeNetRequest.Rule;

export function listIdRange(listIndex: number): [number, number] {
  const base = DNR_RULE_THREAT_BASE + listIndex * DNR_RULE_THREAT_LIST_SPAN;
  return [base, base + DNR_RULE_THREAT_LIST_SPAN - 1];
}

function warningUrl(extensionOrigin: string, listId: string): string {
  // "\\0" = whole matched URL (RE2 substitution syntax); the page takes everything after "?u=" as the target
  return `${extensionOrigin}/${BLOCKED_PAGE}?l=${listId}&u=\\0`;
}

export interface ThreatCompileResult { rules: DnrRule[]; regexRules: number; groups: number }

export function compileThreatRules(source: Pick<ThreatSource, 'id'>, listIndex: number, domains: string[], extensionOrigin: string): ThreatCompileResult {
  const [base] = listIdRange(listIndex);
  const rules: DnrRule[] = [];
  let groups = 0;
  for (let i = 0; i < domains.length; i += DOMAINS_PER_RULE, groups++) {
    const requestDomains = domains.slice(i, i + DOMAINS_PER_RULE);
    const id = base + groups * 2;
    if (id + 1 > listIdRange(listIndex)[1]) throw new Error('too many domains for one list');
    rules.push({
      id, priority: PRIORITY_THREAT, action: { type: 'block' },
      condition: { requestDomains, resourceTypes: [...SUBRESOURCE_TYPES] }
    });
    rules.push({
      id: id + 1, priority: PRIORITY_THREAT,
      action: { type: 'redirect', redirect: { regexSubstitution: warningUrl(extensionOrigin, source.id) } },
      condition: { requestDomains, regexFilter: '^https?://.*$', resourceTypes: ['main_frame'] }
    });
  }
  return { rules, regexRules: groups, groups };
}

/** URLs that put a "login" host behind user info (`https://paypal.com@evil.example/`): a classic deception. */
export const USERINFO_REGEX = '^https?://[^/?#]*@';

export function compileHeuristicRule(extensionOrigin: string): DnrRule {
  return {
    id: DNR_RULE_THREAT_HEURISTIC, priority: PRIORITY_THREAT,
    action: { type: 'redirect', redirect: { regexSubstitution: warningUrl(extensionOrigin, 'userinfo') } },
    // the substitution's \0 is the whole MATCH, so the filter must consume the entire URL
    condition: { regexFilter: `${USERINFO_REGEX}.*$`, resourceTypes: ['main_frame'] }
  };
}

/** Session rule that lifts ONLY the threat band for one host (and its subdomains). */
export function buildBypassRule(host: string, id: number): DnrRule {
  return {
    id, priority: PRIORITY_THREAT_BYPASS, action: { type: 'allow' },
    condition: { requestDomains: [host], resourceTypes: ['main_frame', ...SUBRESOURCE_TYPES] }
  };
}

/** Parses the warning page URL: `...blocked.html?l=<list>&u=<raw target url>`. Returns null unless the target is plain http(s). */
export function parseWarningUrl(pageUrl: string): { listId: string; target: URL } | null {
  const q = pageUrl.indexOf('?l=');
  const u = pageUrl.indexOf('&u=');
  if (q === -1 || u === -1 || u < q) return null;
  const listId = pageUrl.slice(q + 3, u);
  if (!/^[a-z0-9-]{1,40}$/.test(listId)) return null;
  try {
    const target = new URL(pageUrl.slice(u + 3));
    return target.protocol === 'http:' || target.protocol === 'https:' ? { listId, target } : null;
  } catch {
    return null;
  }
}
