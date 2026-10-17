/** Optional permission for counting cleaned URLs. Must be requested from a user gesture (a click handler). */
const CLEANED_URL_STATS: browser.permissions.Permissions = { permissions: ['webRequest'] };

export async function hasCleanedUrlStats(): Promise<boolean> {
  try { return await browser.permissions.contains(CLEANED_URL_STATS); } catch { return false; }
}

/** Call this first thing inside the click/change handler, before any other await. */
export async function requestCleanedUrlStats(): Promise<boolean> {
  try { return await browser.permissions.request(CLEANED_URL_STATS); } catch { return false; }
}
