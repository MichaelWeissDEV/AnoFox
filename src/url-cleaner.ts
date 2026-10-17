/**
 * AnoFox URL Tracking Cleaner
 * Handles identification and removal of tracking parameters, preserving
 * URL fragments, query encoding, and protecting signed URLs and auth links.
 */

// Categorized tracking parameters
export const KNOWN_TRACKING_PARAMS: string[] = [
  // UTM & Analytics
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_source_platform",
  "utm_creative_format",
  "utm_marketing_tactic",
  "utm_brand",
  "utm_name",
  "utm_cid",
  "utm_reader",
  "utm_viz_id",
  "utm_pubreferrer",
  "utm_swu",

  // Google / Ads / DoubleClick
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "gclsrc",
  "gad_source",
  "_ga",
  "_gl",
  "gtm_debug",
  "srsltid",

  // Facebook / Meta / Instagram
  "fbclid",
  "igshid",
  "fb_action_ids",
  "fb_action_types",
  "fb_source",
  "fb_ref",
  "fref",

  // Microsoft / Bing
  "msclkid",

  // Twitter / X
  "twclid",
  "ref_src",
  "ref_url",

  // TikTok
  "ttclid",
  "_openplatform_share_id",

  // Baidu & Yandex
  "bdclid",
  "yclid",
  "ym_debug",
  "_openstat",

  // Social & Referral
  "epik",
  "li_fat_id",

  // Email / CRM / Marketing Automation
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "hsctatracking",
  "vero_id",
  "vero_conv",
  "kla_id",
  "trk_contact",
  "trk_msg",
  "trk_module",
  "trk_sid",
  "wickedid",

  // Affiliates & Analytics platforms
  "sc_clid",
  "s_kwcid",
  "zanpid",
  "rb_clickid",
  "irclickid",
  "nan_mt",
  "ajs_aid",
  "ajs_uid",
  "itm_source",
  "itm_medium",
  "itm_campaign",
  "pk_campaign",
  "pk_kwd",
  "pk_source",
  "pk_medium",
  "pk_content",
  "mtm_source",
  "mtm_medium",
  "mtm_campaign",
  "mtm_kwd",
  "mtm_cid",
  "mtm_content",
  "piwik_campaign",
  "piwik_kwd",
  "matomo_campaign",
  "matomo_kwd"
];

// Set of lowercase tracking parameters for fast lookup
export const TRACKING_PARAMS_SET = new Set(KNOWN_TRACKING_PARAMS.map((p) => p.toLowerCase()));

// Known prefixes for tracking parameters
const TRACKING_PREFIXES = ["utm_", "pk_", "mtm_", "itm_"];

// Query parameter keys that indicate a signed URL (HMAC, cryptographic signature, AWS/GCP/Azure)
export const SIGNATURE_PARAM_NAMES: readonly string[] = [
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-algorithm",
  "x-amz-date",
  "x-amz-security-token",
  "x-amz-signedheaders",
  "x-goog-signature",
  "x-goog-credential",
  "x-goog-algorithm",
  "x-goog-date",
  "googleaccessid",
  "sig",
  "signature",
  "hmac",
  "mac",
  "hash",
  "sha256",
  "oauth_signature",
  "signed"
];
const SIGNATURE_PARAMS = new Set(SIGNATURE_PARAM_NAMES);

// Query parameter keys that indicate authentication or login flows
export const AUTH_PARAM_NAMES: readonly string[] = [
  "code",
  "state",
  "id_token",
  "access_token",
  "refresh_token",
  "auth_token",
  "session_token",
  "ticket",
  "samlrequest",
  "samlresponse",
  "relaystate",
  "reset_token",
  "reset_password_token",
  "verification_token",
  "confirmation_token",
  "magic_link"
];
const AUTH_PARAMS = new Set(AUTH_PARAM_NAMES);

// Path segments typical for authentication callbacks and sensitive flows
const AUTH_PATH_REGEX = /\/(oauth2?|auth|signin|login|sso|saml|callback|verify|confirm|magic-link|password-reset)\b/i;

/**
 * Checks if a parameter key is considered a tracking parameter (case-insensitive).
 */
export function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_PARAMS_SET.has(lower)) {
    return true;
  }
  return TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Checks if a URL is signed or represents an authentication link.
 * Such URLs MUST NOT be altered, as modifying query parameters breaks signatures or auth flow.
 */
export function isSignedOrAuthUrl(url: URL): boolean {
  // 1. Check for cryptographic signature parameters
  for (const key of url.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (SIGNATURE_PARAMS.has(lower)) {
      return true;
    }
  }

  // 2. Check for authentication flow tokens / codes
  for (const key of url.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (AUTH_PARAMS.has(lower)) {
      return true;
    }
  }

  // 3. Check for auth paths combined with tokens / keys
  if (AUTH_PATH_REGEX.test(url.pathname)) {
    for (const key of url.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (lower.includes("token") || lower.includes("key") || lower.includes("code") || lower === "id") {
        return true;
      }
    }
  }

  return false;
}

/**
 * Checks if a hostname matches an excluded domain or its subdomains.
 */
export function isDomainExcluded(hostname: string, exceptions: string[]): boolean {
  if (!exceptions || exceptions.length === 0) return false;
  const host = hostname.toLowerCase().trim();

  for (const rawException of exceptions) {
    const exception = rawException.toLowerCase().trim().replace(/^\*\./, "");
    if (!exception) continue;

    if (host === exception || host.endsWith("." + exception)) {
      return true;
    }
  }
  return false;
}

export interface CleanOptions {
  exceptions?: string[];
}

export interface CleanResult {
  cleanedUrl: string;
  wasCleaned: boolean;
  removedParams: string[];
  reason?: string;
}

/**
 * Cleans tracking parameters from a URL with detailed result information.
 * - Preserves URL fragments (#)
 * - Preserves URL encoding
 * - Handles duplicate tracking parameters (even with different casings)
 * - Case-insensitive parameter matching
 * - Respects website exceptions
 * - Protects signed URLs and authentication links
 */
export function cleanUrlDetailed(input: string, options?: CleanOptions): CleanResult {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    return { cleanedUrl: input, wasCleaned: false, removedParams: [], reason: "invalid_url" };
  }

  // Only clean http and https schemes
  if (!["http:", "https:"].includes(url.protocol)) {
    return { cleanedUrl: input, wasCleaned: false, removedParams: [], reason: "unsupported_scheme" };
  }

  // Check website exceptions
  if (options?.exceptions && isDomainExcluded(url.hostname, options.exceptions)) {
    return { cleanedUrl: input, wasCleaned: false, removedParams: [], reason: "domain_exception" };
  }

  // Protect signed URLs and authentication links
  if (isSignedOrAuthUrl(url)) {
    return { cleanedUrl: input, wasCleaned: false, removedParams: [], reason: "signed_or_auth_url" };
  }

  // Fast check: does the URL have search parameters?
  if (!url.search) {
    return { cleanedUrl: input, wasCleaned: false, removedParams: [] };
  }

  // Find all keys to delete (handling duplicate keys & case variations)
  const keysToDelete = new Set<string>();
  const removedParamsList: string[] = [];

  for (const key of url.searchParams.keys()) {
    if (isTrackingParam(key)) {
      keysToDelete.add(key);
      if (!removedParamsList.includes(key)) {
        removedParamsList.push(key);
      }
    }
  }

  if (keysToDelete.size === 0) {
    return { cleanedUrl: input, wasCleaned: false, removedParams: [] };
  }

  // Delete all identified tracking parameter keys
  for (const key of keysToDelete) {
    url.searchParams.delete(key);
  }

  let cleanedUrl = url.toString();

  // If the original URL used %20 instead of + for spaces, preserve %20
  const qMarkIndex = input.indexOf("?");
  if (qMarkIndex !== -1) {
    const originalQuery = input.slice(qMarkIndex);
    if (originalQuery.includes("%20") && !originalQuery.includes("+")) {
      const hashIndex = cleanedUrl.indexOf("#");
      const beforeHash = hashIndex !== -1 ? cleanedUrl.slice(0, hashIndex) : cleanedUrl;
      const hash = hashIndex !== -1 ? cleanedUrl.slice(hashIndex) : "";
      const qIndex = beforeHash.indexOf("?");
      if (qIndex !== -1) {
        const base = beforeHash.slice(0, qIndex + 1);
        const query = beforeHash.slice(qIndex + 1).replace(/\+/g, "%20");
        cleanedUrl = base + query + hash;
      }
    }
  }

  return {
    cleanedUrl,
    wasCleaned: true,
    removedParams: removedParamsList
  };
}

/**
 * Convenience wrapper returning the cleaned URL string.
 */
export function cleanUrl(input: string, options?: CleanOptions): string {
  return cleanUrlDetailed(input, options).cleanedUrl;
}

/**
 * Builds an expanded array of parameter names including lowercase,
 * uppercase, and capitalized variations for Declarative Net Request rules.
 */
export function generateDnrRemoveParams(): string[] {
  const result = new Set<string>();

  for (const param of KNOWN_TRACKING_PARAMS) {
    result.add(param.toLowerCase());
    result.add(param.toUpperCase());
    const capitalized = param.charAt(0).toUpperCase() + param.slice(1);
    result.add(capitalized);
  }

  return Array.from(result);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
}

/**
 * Regex (RE2-compatible, use case-insensitively) matching a URL that carries any
 * signature or auth parameter. Single source of truth shared with isSignedOrAuthUrl().
 */
export function generateAuthParamRegex(): string {
  const names = [...SIGNATURE_PARAM_NAMES, ...AUTH_PARAM_NAMES].map(escapeRegex);
  return `[?&](?:${names.join('|')})(?:[=&#]|$)`;
}

/**
 * Regexes (case-insensitive) matching a URL that contains at least one known tracking
 * parameter, split into chunks to stay below engine regex complexity limits.
 */
export function generateTrackingParamRegexes(chunkSize = 25): string[] {
  const names = Array.from(new Set(KNOWN_TRACKING_PARAMS.map((p) => p.toLowerCase())));
  const out: string[] = [];
  for (let i = 0; i < names.length; i += chunkSize) {
    const part = names.slice(i, i + chunkSize).map(escapeRegex);
    out.push(`[?&](?:${part.join('|')})(?:[=&#]|$)`);
  }
  return out;
}
