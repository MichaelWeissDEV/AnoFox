/**
 * Consent manager modes (pure).
 *   manual  AnoFox never touches banners
 *   reject  refuse optional categories ("reject all" / "only necessary") through the dialog's own controls
 *   hide    only hide a banner that does not block the page (no click, no consent given or implied)
 * Setting "auto" follows the module level of `consent`. No mode ever grants consent.
 */
import type { Level } from '../../core/policy-engine/policy.ts';

export type ConsentMode = 'manual' | 'reject' | 'hide';
export type ConsentModeSetting = 'auto' | ConsentMode;
export const CONSENT_MODE_SETTINGS: readonly ConsentModeSetting[] = ['auto', 'manual', 'reject', 'hide'];

export function effectiveConsentMode(setting: ConsentModeSetting, level: Level): ConsentMode {
  if (level === 'off') return 'manual'; // module switched off beats everything, including an explicit mode
  if (setting !== 'auto') return setting;
  return 'reject'; // balanced, strict, lockdown: refuse optional processing
}
