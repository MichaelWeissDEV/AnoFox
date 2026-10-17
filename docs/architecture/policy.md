# Policy Engine & Rule Bands

Code: `src/core/policy-engine/policy.ts` (engine), `apply.ts` (settings → DNR plan), `src/protection/network/compile.ts` (DNR compiler), `src/core/settings/settings.ts` (schema v2).

## Model
- Profiles `balanced | strict | lockdown | custom` map every module to a level (`off|balanced|strict|lockdown`). Changing one module in a preset switches to `custom`, seeded from the preset. Profile changes never touch user rules.
- `enabled` (URL cleaner) and `socialEmbedsEnabled` are per-module kill switches applied on top of the profile.
- User rules are scoped to ONE module. Resource types have one owner: `scripts` owns `script`; `network` owns all other subresource types; `social` owns embed URLs.
- Precedence inside a module: site > global, target > no target, block > allow, newer > older. First blocking module in `MODULE_ORDER` decides (malware, phishing first).

## DNR priority bands
| Band | Use |
|---|---|
| 1–3 | Filterlisten (Block/Ausnahme, `$important`, `$document`) |
| 5 | Adblock-Pause pro Website (`allowAllRequests`) |
| 6 / 10 | URL cleaner redirect / cleaner allows |
| 20 | profile base blocks (network strict/lockdown, scripts strict/lockdown) |
| 21–32 | user rules: `21 + (siteScope*3 + hasTarget)*2 + (block?1:0)` |
| 60 | Social Embed Guard blocks (site exceptions via `excludedInitiatorDomains`) |
| 70 | temporary embed allow (session rule, exact URL) |

`test/policy-compile.test.ts` checks that a model of DNR evaluation agrees with the engine on 864 request/profile/rule combinations. **This is a model, not Firefox.** Real-browser verification is still open (T-1).

## Known limits (shown to the user via `GET_POLICY_STATUS`)
- `once` rules and container-bound rules cannot be enforced by DNR; they are reported as unsupported.
- Exact-host vs parent-domain target specificity is not expressible in DNR (both get the same band).
- Site rules match the DNR *initiator* (the frame that issued the request), which for requests from third-party iframes is the iframe origin, not the top-level site.
- `tab` rules are session rules with `tabIds`; they are removed on `tabs.onRemoved`. `session` rules are pruned when `storage.session` shows a fresh browser session.
- Rule IDs for user rules are position-based (replaced atomically on every sync).
- No UI yet for profiles/rules; messages exist: `SET_PROFILE`, `SET_MODULE_LEVEL`, `ADD_USER_RULE`, `REMOVE_USER_RULE`, `GET_POLICY_STATUS`, `IMPORT_SETTINGS` (with rollback to previous settings).
