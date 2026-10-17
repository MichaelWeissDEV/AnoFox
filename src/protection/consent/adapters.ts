/**
 * CMP adapters as DATA. Each adapter lists where its dialog lives and which clicks refuse optional processing.
 * There is deliberately no "accept" step anywhere in this file and no adapter may click anything but a
 * refusal control (enforced by tests).
 *
 * Verification status: the selectors follow the vendors' documented/commonly deployed DOM and are exercised in
 * the end-to-end suite against FIXTURES that reproduce that DOM. They are NOT verified against live vendor scripts
 * (vendors change markup and sites customise it). Unknown or changed dialogs fall back to the generic detector or
 * to doing nothing, never to accepting.
 */
export type ConsentStep =
  | { kind: 'click'; selector: string }
  /** unchecks every enabled, checked checkbox matching the selector (optional purposes) */
  | { kind: 'uncheckAll'; selector: string }
  | { kind: 'wait'; ms: number };

export interface ConsentAdapter {
  id: string;
  name: string;
  /** Standard / vendor family. */
  family: 'iab-tcf' | 'proprietary' | 'open-source' | 'heuristic';
  /** CSS selectors of the dialog root(s). The adapter applies only if one is present and visible. */
  containers: string[];
  /** If set, containers and steps are looked up inside the open shadow root of this host element. */
  shadowHost?: string;
  /** Alternative refusal flows, tried in order until the dialog disappears. */
  rejectFlows: ConsentStep[][];
}

export const ADAPTERS: readonly ConsentAdapter[] = [
  {
    id: 'onetrust', name: 'OneTrust', family: 'proprietary',
    containers: ['#onetrust-banner-sdk', '#onetrust-pc-sdk'],
    rejectFlows: [
      [{ kind: 'click', selector: '#onetrust-reject-all-handler' }],
      [{ kind: 'click', selector: '#onetrust-pc-btn-handler' }, { kind: 'wait', ms: 200 }, { kind: 'click', selector: '#onetrust-pc-sdk .ot-pc-refuse-all-handler' }]
    ]
  },
  {
    id: 'cookiebot', name: 'Cookiebot (Usercentrics)', family: 'proprietary',
    containers: ['#CybotCookiebotDialog'],
    rejectFlows: [
      [{ kind: 'click', selector: '#CybotCookiebotDialogBodyButtonDecline' }],
      [
        { kind: 'uncheckAll', selector: '#CybotCookiebotDialog input[type="checkbox"]' },
        { kind: 'click', selector: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection' }
      ]
    ]
  },
  {
    id: 'usercentrics', name: 'Usercentrics', family: 'proprietary', shadowHost: '#usercentrics-root',
    containers: ['[data-testid="uc-default-banner"]', '[data-testid="uc-banner-content"]', '[data-testid="uc-deny-all-button"]'],
    rejectFlows: [
      [{ kind: 'click', selector: '[data-testid="uc-deny-all-button"]' }],
      [{ kind: 'click', selector: '[data-testid="uc-more-button"]' }, { kind: 'wait', ms: 200 }, { kind: 'click', selector: '[data-testid="uc-deny-all-button"]' }]
    ]
  },
  {
    id: 'klaro', name: 'Klaro', family: 'open-source',
    containers: ['.klaro .cookie-notice', '.klaro .cookie-modal', '#klaro .cookie-notice'],
    rejectFlows: [
      [{ kind: 'click', selector: '.klaro .cn-decline' }],
      [{ kind: 'click', selector: '.klaro .cm-btn-decline' }]
    ]
  },
  {
    id: 'didomi', name: 'Didomi (IAB TCF)', family: 'iab-tcf',
    containers: ['#didomi-popup', '#didomi-notice', '.didomi-popup-container'],
    rejectFlows: [[{ kind: 'click', selector: '#didomi-notice-disagree-button' }]]
  },
  {
    id: 'quantcast', name: 'Quantcast Choice (IAB TCF)', family: 'iab-tcf',
    containers: ['.qc-cmp2-container'],
    rejectFlows: [[{ kind: 'click', selector: '.qc-cmp2-summary-buttons button[mode="secondary"]' }]]
  },
  {
    // Last: finds consent dialogs of unknown/custom CMPs, including TCF-based ones, by structure and button wording.
    id: 'generic', name: 'Generischer Dialog-Erkenner', family: 'heuristic',
    containers: [
      '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
      '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
      '[id*="gdpr" i]', '[class*="gdpr" i]', '[id*="cmp" i]', '[class*="cmp" i]', '[id*="privacy" i]', '[class*="privacy-banner" i]'
    ],
    rejectFlows: [] // flows are derived from button wording at runtime (labels.ts), only inside a verified dialog
  }
];

export function getAdapter(id: string): ConsentAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
