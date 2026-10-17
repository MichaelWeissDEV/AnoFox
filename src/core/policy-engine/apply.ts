/** Pure translation of persisted settings into DNR sync input (testable without a browser). */

import type { AnoFoxSettings } from '../settings/settings.ts';
import type { PolicyState } from './policy.ts';
import { effectiveLevels } from './policy.ts';
import type { DnrSyncOptions } from '../../dnr-manager.ts';
import { compilePolicyRules } from '../../protection/network/compile.ts';
import type { CompiledPolicy } from '../../protection/network/compile.ts';

export function policyStateOf(s: AnoFoxSettings): PolicyState {
  return { profile: s.profile, customLevels: s.customLevels, rules: s.rules };
}

export interface DnrPlan {
  options: DnrSyncOptions;
  session: CompiledPolicy['session'];
  unsupported: CompiledPolicy['unsupported'];
}

export function planDnr(s: AnoFoxSettings, now: number = Date.now(), extensionHost?: string): DnrPlan {
  const state = policyStateOf(s);
  const levels = effectiveLevels(state);
  const compiled = compilePolicyRules(state, now, extensionHost);
  return {
    options: {
      // module kill switches are applied on top of the profile level
      enabled: s.enabled && levels.tracking !== 'off',
      exceptions: s.exceptions,
      socialEmbedsEnabled: s.socialEmbedsEnabled && levels.social !== 'off',
      socialEmbedExceptions: s.socialEmbedExceptions,
      socialEmbedProviders: s.socialEmbedProviders,
      policyRules: compiled.dynamic
    },
    session: compiled.session,
    unsupported: compiled.unsupported
  };
}
