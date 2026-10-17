/**
 * Cosmetic filtering content script (all frames, document_start).
 *
 * It never injects styles itself. It only reports which class/id tokens occur in the page to the
 * background, which answers by injecting a user-origin stylesheet through scripting.insertCSS
 * (works under strict page CSP). No page content other than class/id tokens leaves this script,
 * and the tokens only go to the extension's own background.
 */

const MAX_TOKEN_LENGTH = 100;
const MAX_TOKENS_PER_MESSAGE = 300;
const MAX_TOKENS_TOTAL = 20000;
const FLUSH_DELAY_MS = 250;

if (location.protocol === 'http:' || location.protocol === 'https:') {
  const seenClasses = new Set<string>();
  const seenIds = new Set<string>();
  const queueClasses: string[] = [];
  const queueIds: string[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let enabled = true;

  const send = (message: Record<string, unknown>): Promise<{ success?: boolean; active?: boolean } | undefined> =>
    browser.runtime.sendMessage(message).catch(() => undefined);

  const addElement = (el: Element): void => {
    const id = el.getAttribute('id');
    if (id && id.length <= MAX_TOKEN_LENGTH && !seenIds.has(id) && total < MAX_TOKENS_TOTAL) {
      seenIds.add(id); queueIds.push(id); total++;
    }
    const cls = el.getAttribute('class');
    if (cls) {
      for (const c of cls.split(/\s+/)) {
        if (c && c.length <= MAX_TOKEN_LENGTH && !seenClasses.has(c) && total < MAX_TOKENS_TOTAL) {
          seenClasses.add(c); queueClasses.push(c); total++;
        }
      }
    }
  };

  const scan = (root: Element | Document): void => {
    if (root instanceof Element) addElement(root);
    for (const el of root.querySelectorAll('[class],[id]')) addElement(el);
  };

  const flush = (): void => {
    timer = null;
    while (enabled && (queueClasses.length > 0 || queueIds.length > 0)) {
      const classes = queueClasses.splice(0, MAX_TOKENS_PER_MESSAGE);
      const ids = queueIds.splice(0, Math.max(0, MAX_TOKENS_PER_MESSAGE - classes.length));
      void send({ type: 'COSMETIC_QUERY', classes, ids });
    }
  };

  const schedule = (): void => {
    if (!enabled || timer !== null) return;
    timer = setTimeout(flush, FLUSH_DELAY_MS);
  };

  void send({ type: 'COSMETIC_INIT' }).then((res) => {
    if (res && res.active === false) { // nothing to do for this site (no lists, paused, ...)
      enabled = false;
      observer.disconnect();
    }
  });

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.target instanceof Element) addElement(m.target);
      else for (const n of m.addedNodes) if (n instanceof Element) scan(n);
    }
    schedule();
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'id'] });

  const initialScan = (): void => { scan(document); schedule(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialScan, { once: true });
  else initialScan();
}
