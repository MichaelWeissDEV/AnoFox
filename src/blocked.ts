/**
 * Warning page shown instead of a listed malware/phishing/deceptive page. All dynamic text via textContent.
 * The page only ever reads its own URL; the background re-derives the host to allow from `sender.url`, never from a
 * value this page (or a web page) supplies.
 */
import { parseWarningUrl } from './protection/threat/compile.ts';
import { getThreatSource } from './protection/threat/sources.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const parsed = parseWarningUrl(location.href);

if (!parsed) {
  $('title').textContent = 'Ungültiger Aufruf';
  $('reason').textContent = 'Diese Seite wird nur von AnoFox bei einer blockierten Adresse geöffnet.';
  ($('proceed') as HTMLButtonElement).disabled = true;
} else {
  const { listId, target } = parsed;
  $('host').textContent = target.hostname;
  const src = getThreatSource(listId);
  if (listId === 'userinfo') {
    $('title').textContent = 'Irreführende Adresse';
    $('reason').textContent = 'Diese Adresse enthält Zugangsdaten vor dem eigentlichen Server (Muster „bekannter-name@fremder-server“). Betrüger nutzen das, damit eine Seite vertrauenswürdig aussieht. Du würdest tatsächlich diese Seite öffnen:';
    $('source').textContent = 'Erkannt durch eine lokale Regel, nicht durch eine Liste.';
  } else if (src?.kind === 'phishing') {
    $('title').textContent = 'Verdacht auf Phishing';
    $('reason').textContent = 'Diese Seite steht auf einer Phishing-Liste. Sie versucht vermutlich, Zugangsdaten oder Zahlungsdaten abzugreifen.';
    $('source').textContent = `Liste: ${src.name} · ${src.attribution}`;
  } else {
    $('title').textContent = 'Gefährliche Seite (Malware)';
    $('reason').textContent = 'Diese Adresse steht auf einer Liste aktiver Malware-Verteiler.';
    $('source').textContent = src ? `Liste: ${src.name} · ${src.attribution}` : 'Liste unbekannt';
  }

  $('back').addEventListener('click', async () => {
    if (history.length > 1) { history.back(); return; }
    const tab = await browser.tabs.getCurrent().catch(() => undefined);
    if (tab?.id !== undefined) await browser.tabs.remove(tab.id); else window.close();
  });
  $('proceed').addEventListener('click', async () => {
    const btn = $('proceed') as HTMLButtonElement;
    btn.disabled = true;
    const duration = ($('duration') as HTMLSelectElement).value;
    const res = await browser.runtime.sendMessage({ type: 'THREAT_BYPASS', duration }).catch(() => null);
    if (res?.success) location.replace(target.href);
    else { btn.disabled = false; btn.textContent = 'Freigabe nicht möglich'; }
  });
}
