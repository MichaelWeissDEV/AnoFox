/**
 * Cookie-banner manager content script (top frame, document_idle).
 *
 * Hard rules:
 *  - it never clicks anything that grants consent: a control whose label reads as "accept" is refused even when
 *    the vendor selector matches (a site could reuse a CMP id for an accept button);
 *  - "reject" works only through the dialog's own refusal controls (adapter flows or, for unknown dialogs, a
 *    clearly worded refusal button inside a dialog that offers both accept and reject);
 *  - "hide" never clicks; it hides only a banner that does not block the page (no wall, no scroll lock);
 *  - if nothing fits, nothing happens.
 * Banners in cross-origin iframes are out of reach of this script (documented limitation).
 */
import { ADAPTERS } from './protection/consent/adapters.ts';
import type { ConsentAdapter, ConsentStep } from './protection/consent/adapters.ts';
import { classifyButton } from './protection/consent/labels.ts';

const BUDGET_MS = 20_000;
const SCAN_INTERVAL_MS = 700;
const GONE_TIMEOUT_MS = 3_000;
const CLICKABLE = 'button, [role="button"], a, input[type="button"], input[type="submit"]';

type Mode = 'reject' | 'hide';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const handled = new WeakSet<Element>();
let mode: Mode = 'reject';
let finished = false;

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01;
}

function labelOf(el: Element): string {
  const h = el as HTMLElement & { value?: string };
  return (h.innerText || h.textContent || h.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
}

function rootOf(adapter: ConsentAdapter): ParentNode | null {
  if (!adapter.shadowHost) return document;
  const host = document.querySelector(adapter.shadowHost);
  return host?.shadowRoot ?? null; // closed shadow roots are not reachable
}

function qsa(root: ParentNode, selector: string): Element[] {
  try { return Array.from(root.querySelectorAll(selector)); } catch { return []; }
}

/** Dialog of an adapter with a vendor-specific root, or null. */
function findContainer(adapter: ConsentAdapter): Element | null {
  const root = rootOf(adapter);
  if (!root) return null;
  for (const sel of adapter.containers) {
    const hit = qsa(root, sel).find((e) => isVisible(e) && !handled.has(e));
    if (hit) return hit;
  }
  return null;
}

/** Unknown dialogs: the smallest visible container that offers both an accept-like and a reject-like control. */
function findGenericDialog(): { container: Element; reject: Element } | null {
  const adapter = ADAPTERS.find((a) => a.id === 'generic')!;
  const seen = new Set<Element>();
  const candidates: Element[] = [];
  for (const sel of adapter.containers) for (const el of qsa(document, sel)) {
    if (seen.has(el) || el === document.body || el === document.documentElement || handled.has(el)) continue;
    seen.add(el);
    if (isVisible(el)) candidates.push(el);
    if (candidates.length > 80) break;
  }
  let best: { container: Element; reject: Element; size: number } | null = null;
  for (const c of candidates) {
    const buttons = qsa(c, CLICKABLE).filter(isVisible);
    if (buttons.length === 0 || buttons.length > 40) continue;
    const kinds = buttons.map((b) => classifyButton(labelOf(b)));
    const reject = buttons[kinds.indexOf('reject')];
    if (!reject || !kinds.includes('accept')) continue;
    const size = c.querySelectorAll('*').length;
    if (!best || size < best.size) best = { container: c, reject, size };
  }
  return best ? { container: best.container, reject: best.reject } : null;
}

function looksLikeWall(el: Element): boolean {
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const r = el.getBoundingClientRect();
  if ((r.width * r.height) / (vw * vh) > 0.5) return true;
  const scrollLocked = [document.documentElement, document.body].some((e) => e && getComputedStyle(e).overflow === 'hidden');
  if (scrollLocked) return true;
  // a full-viewport backdrop next to or inside the dialog
  const scope = el.parentElement ?? document.body;
  for (const b of qsa(scope, '[class*="backdrop" i], [class*="overlay" i], [id*="backdrop" i], [id*="overlay" i]')) {
    const br = b.getBoundingClientRect();
    if (isVisible(b) && (br.width * br.height) / (vw * vh) > 0.8 && getComputedStyle(b).position === 'fixed') return true;
  }
  return false;
}

async function gone(container: Element): Promise<boolean> {
  const end = Date.now() + GONE_TIMEOUT_MS;
  while (Date.now() < end) {
    if (!container.isConnected || !isVisible(container)) return true;
    await sleep(150);
  }
  return !container.isConnected || !isVisible(container);
}

async function runFlow(root: ParentNode, flow: ConsentStep[]): Promise<boolean> {
  // "save my selection" controls may carry accept-sounding vendor labels, but only after every optional purpose was unchecked
  const guardAccept = !flow.some((s) => s.kind === 'uncheckAll');
  for (const step of flow) {
    if (step.kind === 'wait') { await sleep(step.ms); continue; }
    if (step.kind === 'uncheckAll') {
      for (const cb of qsa(root, step.selector) as HTMLInputElement[]) {
        if (cb.checked && !cb.disabled) cb.click();
      }
      continue;
    }
    const el = qsa(root, step.selector).find(isVisible) as HTMLElement | undefined;
    if (!el) return false;
    if (guardAccept && classifyButton(labelOf(el)) === 'accept') return false; // refuse to click a consenting control
    el.click();
    await sleep(150);
  }
  return true;
}

function report(adapter: string, action: 'rejected' | 'hidden' | 'failed' | 'wall-left-visible'): void {
  void browser.runtime.sendMessage({ type: 'CONSENT_REPORT', adapter, action }).catch(() => undefined);
}

async function handleAdapter(adapter: ConsentAdapter): Promise<void> {
  const container = findContainer(adapter);
  if (!container) return;
  handled.add(container);
  if (mode === 'hide') {
    if (looksLikeWall(container)) { report(adapter.id, 'wall-left-visible'); return; }
    (container as HTMLElement).style.setProperty('display', 'none', 'important');
    report(adapter.id, 'hidden');
    return;
  }
  const root = rootOf(adapter);
  if (!root) return;
  for (const flow of adapter.rejectFlows) {
    if (!(await runFlow(root, flow))) continue;
    if (await gone(container)) { report(adapter.id, 'rejected'); return; }
  }
  report(adapter.id, 'failed');
}

async function handleGeneric(): Promise<void> {
  const hit = findGenericDialog();
  if (!hit) return;
  handled.add(hit.container);
  if (mode === 'hide') {
    if (looksLikeWall(hit.container)) { report('generic', 'wall-left-visible'); return; }
    (hit.container as HTMLElement).style.setProperty('display', 'none', 'important');
    report('generic', 'hidden');
    return;
  }
  if (classifyButton(labelOf(hit.reject)) !== 'reject') return; // defensive: re-check right before the click
  (hit.reject as HTMLElement).click();
  report('generic', (await gone(hit.container)) ? 'rejected' : 'failed');
}

let scanning = false;
async function scan(): Promise<void> {
  if (scanning || finished) return;
  scanning = true;
  try {
    for (const adapter of ADAPTERS) {
      if (adapter.id === 'generic') await handleGeneric();
      else await handleAdapter(adapter);
    }
  } finally {
    scanning = false;
  }
}

async function main(): Promise<void> {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  const cfg = await browser.runtime.sendMessage({ type: 'CONSENT_GET_CONFIG' }).catch(() => null);
  if (!cfg?.success || !cfg.active || (cfg.mode !== 'reject' && cfg.mode !== 'hide')) return;
  mode = cfg.mode;

  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; void scan(); }, 300); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  const interval = setInterval(() => {
    if (Date.now() - started > BUDGET_MS) { finished = true; observer.disconnect(); clearInterval(interval); return; }
    void scan();
  }, SCAN_INTERVAL_MS);
  void scan();
}

void main();
