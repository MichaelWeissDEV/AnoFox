/**
 * Options page panel: profiles, per-module levels and user rules.
 * All dynamic text is set via textContent (no innerHTML).
 */
import { MODULE_ORDER } from '../../core/policy-engine/policy.ts';
import type { Level, ModuleId, ProfileId, UserRule, Duration } from '../../core/policy-engine/policy.ts';
import { effectiveLevels } from '../../core/policy-engine/policy.ts';
import { MODULE_INFO, PROFILE_INFO, LEVEL_LABEL } from '../../core/capabilities/modules.ts';
import type { AnoFoxSettings } from '../../core/settings/settings.ts';
import { sanitizeDomainList } from '../../core/domain-utils/domains.ts';
import { h, chip, notice, button, keepFocus } from '../components/dom.ts';

interface ThreatListState { enabled: boolean; installed?: boolean; ruleCount?: number; lastError?: string; current?: { filterCount: number; fetchedAt: number } }
const RULE_MODULES: ModuleId[] = ['scripts', 'inline', 'network', 'adblock', 'consent'];
const DURATION_LABEL: Record<Exclude<Duration, 'once' | 'tab'>, string> = {
  session: 'Bis Browserende', permanent: 'Dauerhaft'
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface PolicyMounts {
  overview: HTMLElement; profiles: HTMLElement; rules: HTMLElement; native: HTMLElement;
  storage: HTMLElement; consent: HTMLElement; threat: HTMLElement; lists: HTMLElement;
}

/** Which settings area a module is configured in (used by the overview's "Konfigurieren" links). */
const MODULE_TAB: Partial<Record<ModuleId, string>> = {
  tracking: 'tab-cleaner', social: 'tab-embeds', network: 'tab-rules', scripts: 'tab-rules', inline: 'tab-rules',
  adblock: 'tab-lists', malware: 'tab-threat', phishing: 'tab-threat', consent: 'tab-consent',
  cookies: 'tab-storage', storage: 'tab-storage', fingerprint: 'tab-fingerprint'
};

export function initPolicyPanel(
  mounts: PolicyMounts,
  getSettings: () => AnoFoxSettings,
  setSettings: (s: AnoFoxSettings) => void,
  toast: (msg: string) => void,
  navigate: (tabId: string) => void
): { render: () => Promise<void> } {
  async function refresh(): Promise<void> {
    const res = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (res?.success && res.settings) setSettings(res.settings);
  }

  async function send(msg: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await browser.runtime.sendMessage(msg);
      if (!res?.success) { toast(res?.error ?? 'Aktion fehlgeschlagen'); return false; }
      await refresh();
      return true;
    } catch {
      toast('Verbindung zum Hintergrundprozess fehlgeschlagen');
      return false;
    }
  }

  async function render(): Promise<void> {
    await refresh();
    await keepFocus(document.body, async () => {
      const s = getSettings();
      const levels = effectiveLevels({ profile: s.profile, customLevels: s.customLevels, rules: s.rules });
      for (const m of Object.values(mounts)) m.replaceChildren();
      await renderOverview(mounts.overview, s, levels);
      renderProfiles(mounts.profiles, s, levels);
      await renderRules(mounts.rules, s, levels);
      await renderNative(mounts.native);
      await renderStorage(mounts.storage);
      await renderConsent(mounts.consent);
      await renderThreat(mounts.threat);
      await renderLists(mounts.lists);
    });
  }

  function renderProfiles(into: HTMLElement, s: AnoFoxSettings, levels: Record<ModuleId, Level>): void {
    const profiles = el('div', 'policy-profiles');
    (['balanced', 'strict', 'lockdown', 'custom'] as ProfileId[]).forEach((id) => {
      const b = el('button', 'policy-profile' + (s.profile === id ? ' selected' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(s.profile === id));
      b.append(el('strong', undefined, PROFILE_INFO[id].label), el('span', undefined, PROFILE_INFO[id].description));
      if (id === 'custom') {
        b.disabled = s.profile === 'custom';
        b.title = 'Wird automatisch gewählt, wenn ein Modul einzeln geändert wird';
      }
      b.addEventListener('click', async () => {
        if (await send({ type: 'SET_PROFILE', profile: id })) { toast(`Profil: ${PROFILE_INFO[id].label}`); await render(); }
      });
      profiles.append(b);
    });
    into.append(profiles);
    into.append(el('p', 'policy-note',
      'Profil und Modulstufen gelten browserweit für alle Websites. Ausnahmen pro Website legst du unten als Regeln an; ein Profilwechsel löscht sie nicht.'));

    // Modules
    const table = el('div', 'policy-modules');
    for (const m of MODULE_ORDER) {
      const info = MODULE_INFO[m];
      const row = el('div', 'policy-module' + (info.enforced ? '' : ' inactive'));
      const text = el('div');
      const title = el('strong', undefined, info.label);
      const chipEl = el('span', 'chip ' + (info.enforced ? 'ok' : 'todo'), info.enforced ? 'aktiv erzwungen' : 'nicht implementiert');
      text.append(title, document.createTextNode(' '), chipEl, ...(info.experimental ? [document.createTextNode(' '), el('span', 'chip todo', 'experimentell')] : []), el('div', 'policy-desc', info.description), el('div', 'policy-desc', info.note));
      const sel = el('select');
      sel.setAttribute('aria-label', `Stufe für ${info.label}`);
      (['off', 'balanced', 'strict', 'lockdown'] as Level[]).forEach((l) => {
        const o = el('option', undefined, LEVEL_LABEL[l]);
        o.value = l;
        sel.append(o);
      });
      if (info.enforced) {
        sel.value = levels[m];
      } else {
        // never display a level for a module that has no enforcement in this build
        const none = el('option', undefined, '— (ohne Wirkung)');
        none.value = '';
        sel.prepend(none);
        sel.value = '';
      }
      sel.disabled = !info.enforced;
      sel.addEventListener('change', async () => {
        if (await send({ type: 'SET_MODULE_LEVEL', module: m, level: sel.value })) await render();
      });
      row.append(text, sel);
      table.append(row);
    }
    into.append(table);
  }

  async function renderRules(into: HTMLElement, s: AnoFoxSettings, levels: Record<ModuleId, Level>): Promise<void> {
    const form = el('div', 'policy-form');
    const mod = el('select'); mod.setAttribute('aria-label', 'Modul');
    RULE_MODULES.forEach((m) => { const o = el('option', undefined, MODULE_INFO[m].label); o.value = m; mod.append(o); });
    const effect = el('select'); effect.setAttribute('aria-label', 'Wirkung');
    [['allow', 'Erlauben'], ['block', 'Blockieren']].forEach(([v, t]) => { const o = el('option', undefined, t); o.value = v; effect.append(o); });
    const site = el('input'); site.type = 'text'; site.placeholder = 'Website (leer = alle)'; site.setAttribute('aria-label', 'Website');
    const target = el('input'); target.type = 'text'; target.placeholder = 'Ziel (leer = alle)'; target.setAttribute('aria-label', 'Ziel-Domain');
    const dur = el('select'); dur.setAttribute('aria-label', 'Dauer');
    (Object.keys(DURATION_LABEL) as Array<keyof typeof DURATION_LABEL>).forEach((d) => { const o = el('option', undefined, DURATION_LABEL[d]); o.value = d; dur.append(o); });
    dur.value = 'permanent';
    const add = el('button', 'btn-accent', '+ Regel hinzufügen'); add.type = 'button';
    add.addEventListener('click', async () => {
      const siteVal = site.value.trim() ? sanitizeDomainList([site.value])[0] : undefined;
      const targetVal = target.value.trim() ? sanitizeDomainList([target.value])[0] : undefined;
      if (site.value.trim() && !siteVal) { toast('Ungültige Website'); return; }
      if (target.value.trim() && !targetVal) { toast('Ungültige Ziel-Domain'); return; }
      const rule = {
        module: mod.value, effect: effect.value, duration: dur.value,
        scope: siteVal ? { kind: 'site', site: siteVal } : { kind: 'global' },
        ...(targetVal ? { target: targetVal } : {})
      };
      if (!siteVal && !targetVal && effect.value === 'allow' &&
          !confirm('Diese Regel erlaubt alle Ressourcen dieses Moduls auf allen Websites. Fortfahren?')) return;
      if (await send({ type: 'ADD_USER_RULE', rule })) { toast('Regel gespeichert'); await render(); }
    });
    form.append(mod, effect, site, target, dur, add);
    into.append(form);

    const unsupported = await browser.runtime.sendMessage({ type: 'GET_POLICY_STATUS' }).catch(() => null);
    const bad = new Map<string, string>(((unsupported?.unsupported ?? []) as Array<{ ruleId: string; reason: string }>).map((u) => [u.ruleId, u.reason]));

    const list = el('div', 'policy-rules');
    const rules = s.rules.filter((r: UserRule) => RULE_MODULES.includes(r.module));
    if (rules.length === 0) list.append(el('p', 'policy-desc', 'Keine Regeln.'));
    for (const r of rules) {
      const row = el('div', 'policy-rule');
      const label = `${r.effect === 'allow' ? 'Erlauben' : 'Blockieren'} · ${MODULE_INFO[r.module].label} · ` +
        `${r.scope.kind === 'site' ? 'auf ' + r.scope.site : 'überall'} · ${r.target ? 'Ziel ' + r.target : 'alle Ziele'} · ` +
        (r.duration === 'permanent' ? 'dauerhaft' : r.duration === 'session' ? 'bis Browserende' : r.duration === 'tab' ? 'bis Tab geschlossen' : 'einmalig');
      row.append(el('span', 'policy-rule-text', label));
      if (levels[r.module] === 'off') row.append(el('span', 'chip todo', 'Modul aus – ohne Wirkung'));
      const reason = bad.get(r.id);
      if (reason) row.append(el('span', 'chip todo', 'nicht erzwungen: ' + reason));
      const del = el('button', 'tag-del', '✕'); del.type = 'button'; del.title = 'Regel entfernen'; del.setAttribute('aria-label', 'Regel entfernen');
      del.addEventListener('click', async () => { if (await send({ type: 'REMOVE_USER_RULE', id: r.id })) await render(); });
      row.append(del);
      list.append(row);
    }
    into.append(list);
    into.append(el('p', 'policy-note',
      'Hinweis: Website-Regeln für Skripte und Netzwerk greifen auf die Seite, die die Anfrage auslöst (Initiator). Regeln für Inline-Skripte gelten für die Dokument-Domain (ohne Ziel, nur Sitzung/dauerhaft) und wirken erst nach dem Neuladen der Seite.'));
  }

  async function renderOverview(into: HTMLElement, s: AnoFoxSettings, levels: Record<ModuleId, Level>): Promise<void> {
    const ask = (type: string) => browser.runtime.sendMessage({ type }).catch(() => null);
    const [threat, lists, native, stats] = await Promise.all([ask('GET_THREAT_STATUS'), ask('GET_LISTS'), ask('GET_NATIVE_STATUS'), ask('GET_STATS_AND_LOGS')]);

    // profile summary
    const head = h('div', { class: 'ui-card' });
    head.append(
      h('h3', { text: `Aktives Profil: ${PROFILE_INFO[s.profile].label}` }),
      h('p', { class: 'ui-muted', text: PROFILE_INFO[s.profile].description })
    );
    const enforced = MODULE_ORDER.filter((m) => MODULE_INFO[m].enforced);
    const active = enforced.filter((m) => levels[m] !== 'off');
    head.append(h('p', { text: `${active.length} von ${enforced.length} umgesetzten Modulen sind eingeschaltet. ${MODULE_ORDER.length - enforced.length} Module sind in dieser Version noch nicht umgesetzt.` }));
    const row = h('div', { class: 'ui-row' });
    row.append(button('Profil wechseln', () => navigate('tab-policy'), { primary: true }));
    head.append(row);
    into.append(head);

    // things that need attention (only truthful, computed from real status)
    const hints: HTMLElement[] = [];
    const threatLists = (threat?.lists ?? []) as Array<{ state: { enabled: boolean; lastError?: string } }>;
    if ((levels.malware !== 'off' || levels.phishing !== 'off') && threat?.success && !threatLists.some((l) => l.state.enabled)) {
      hints.push(notice('warn', 'Phishing- und Malware-Listen sind nicht aktiviert', 'Ohne Liste erkennt dieses Modul nichts. Aktiviere mindestens eine Liste.'));
    }
    if (threatLists.some((l) => l.state.lastError)) hints.push(notice('warn', 'Eine Phishing-/Malware-Liste meldet einen Fehler', 'Die vorherige Version bleibt aktiv. Details im Bereich „Phishing & Malware“.'));
    const adLists = (lists?.lists ?? []) as Array<{ state: { enabled: boolean } }>;
    if (levels.adblock !== 'off' && lists?.success && !adLists.some((l) => l.state.enabled)) {
      hints.push(notice('info', 'Werbeblocker-Listen sind aus', 'Der Werbeblocker (experimentell) wirkt erst, wenn du eine Liste aktivierst.'));
    }
    const nativeProblems = ((native?.status ?? []) as Array<{ action: string; label: string; detail?: string }>).filter((x) => x.action === 'blocked' || x.action === 'error');
    for (const p of nativeProblems) hints.push(notice('warn', `Native Einstellung nicht änderbar: ${p.label}`, p.detail ?? 'Eine Richtlinie oder andere Erweiterung kontrolliert sie.'));
    if (s.profile === 'balanced') hints.push(notice('info', 'Balanced blockiert keine Skripte', 'Für Drittanbieter-Skripte wähle Strict, für gar kein JavaScript Lockdown. Websites können dann eingeschränkt funktionieren.'));
    if (hints.length) { const box = h('div'); box.setAttribute('aria-label', 'Hinweise'); box.setAttribute('role', 'region'); for (const x of hints) box.append(x); into.append(box); }

    // module grid
    into.append(h('h3', { class: 'policy-h', text: 'Module' }));
    const grid = h('div', { class: 'ui-grid' });
    for (const m of MODULE_ORDER) {
      const info = MODULE_INFO[m];
      const card = h('div', { class: 'ui-card' });
      card.append(h('h3', { text: info.label }));
      const badges = h('div', { class: 'ui-row' });
      if (info.enforced) {
        badges.append(chip(levels[m] === 'off' ? 'aus' : LEVEL_LABEL[levels[m]], levels[m] === 'off' ? 'warn' : 'ok'), chip('aktiv erzwungen', 'neutral'));
        if (info.experimental) badges.append(chip('experimentell', 'warn'));
      } else {
        badges.append(chip('nicht implementiert', 'warn'));
      }
      card.append(badges, h('p', { class: 'ui-muted', text: info.description }));
      const tab = MODULE_TAB[m];
      if (tab && info.enforced) card.append(button('Konfigurieren', () => navigate(tab)));
      grid.append(card);
    }
    into.append(grid);

    // session counters only if the user enabled the (RAM-only) statistics
    const snap = stats?.success && stats.statsEnabled ? stats.statistics : null;
    if (snap) {
      into.append(h('h3', { class: 'policy-h', text: 'Diese Sitzung (nur im Arbeitsspeicher)' }));
      const g2 = h('div', { class: 'ui-grid' });
      for (const [label, value] of [['Blockiert gesamt', snap.totalBlocked], ['URLs bereinigt', snap.totalCleanedUrls], ['Embeds blockiert', snap.totalBlockedEmbeds]] as Array<[string, number]>) {
        const c = h('div', { class: 'ui-card' });
        c.append(h('div', { class: 'ui-stat', text: String(value) }), h('p', { class: 'ui-muted', text: label }));
        g2.append(c);
      }
      into.append(g2);
    } else {
      into.append(h('p', { class: 'ui-muted', text: 'Statistik ist aus (Standard): AnoFox zählt nichts. Du kannst sie im Bereich „Statistik & Einblicke“ einschalten; sie bleibt im Arbeitsspeicher.' }));
    }
  }

  async function renderConsent(into: HTMLElement): Promise<void> {
    const res = await browser.runtime.sendMessage({ type: 'GET_CONSENT_STATUS' }).catch(() => null);
    if (!res?.success) return;
    const MODE_LABEL: Record<string, string> = { auto: 'Automatisch (folgt der Stufe des Moduls)', manual: 'Manuell (AnoFox fasst Banner nicht an)', reject: 'Ablehnen (nur Notwendige zulassen)', hide: 'Nur ausblenden (kein Klick, nur wenn die Seite nicht blockiert wird)' };
    into.append(el('h3', 'policy-h', 'Cookie-Banner (Consent-Manager)'));
    into.append(el('p', 'policy-note',
      `Aktiver Modus: ${res.mode}. AnoFox erteilt niemals Zustimmung: Es klickt nur eindeutige Ablehnen-/„Nur notwendige“-Schaltflächen und weigert sich, ` +
      'eine Schaltfläche zu klicken, die nach Zustimmung klingt. Unbekannte Dialoge werden nur behandelt, wenn sie „Akzeptieren“ und „Ablehnen“ anbieten. ' +
      'Die Adapter sind mit nachgebauten Dialogen geprüft, nicht gegen die Live-Skripte der Anbieter. Banner in fremden iFrames werden nicht erreicht. ' +
      'Pro Website abschaltbar über eine Regel (Modul „Cookie-Banner“, Erlauben) oder im Popup.'));
    const sel = el('select'); sel.setAttribute('aria-label', 'Modus des Consent-Managers');
    (['auto', 'manual', 'reject', 'hide'] as const).forEach((m) => { const o = el('option', undefined, MODE_LABEL[m]); o.value = m; sel.append(o); });
    sel.value = res.setting;
    sel.addEventListener('change', async () => { if (await send({ type: 'SET_CONSENT_MODE', mode: sel.value })) { toast('Modus gespeichert'); await render(); } });
    into.append(sel);
    const list = el('div', 'policy-rules');
    for (const a of res.adapters as Array<{ id: string; name: string; family: string }>) {
      const row = el('div', 'policy-rule');
      const st = (res.stats as Record<string, Record<string, number>>)[a.id] ?? {};
      row.append(el('span', 'policy-rule-text', `${a.name} · ${a.family}`));
      row.append(el('span', 'chip', 'mit Testdialogen geprüft'));
      const counts = Object.entries(st).map(([k, v]) => `${k}: ${v}`).join(', ');
      if (counts) row.append(el('span', 'chip ok', counts + ' (diese Sitzung)'));
      list.append(row);
    }
    into.append(list);
  }

  async function renderStorage(into: HTMLElement): Promise<void> {
    const res = await browser.runtime.sendMessage({ type: 'GET_STORAGE_STATUS' }).catch(() => null);
    if (!res?.success) return;
    const st = res.status as { active: boolean; graceMs: number; defaultPolicy: string; pending: Array<{ site: string; dueAt: number; reason: string; attempts: number; lastError?: string }>;
      results: Array<{ site: string; at: number; cookiesRemoved: number; cookiesFailed: number; cookiesRemaining: number; ok: boolean; unverified: string[]; reason: string }> };
    const sites = res.sitePolicies as Record<string, string>;
    const POLICY_LABEL: Record<string, string> = { persistent: 'Persistent (vertrauenswürdig)', session: 'Session (beim nächsten Browserstart löschen)', ephemeral: 'Ephemeral (nach dem Schließen löschen)', restricted: 'Restricted (nicht zuverlässig möglich, wie Ephemeral)' };
    into.append(el('h3', 'policy-h', 'Cookies & Website-Daten (Cookie Vault)'));
    into.append(el('p', 'policy-note',
      `Standardrichtlinie für Websites ohne Eintrag: ${POLICY_LABEL[st.defaultPolicy] ?? st.defaultPolicy}${st.active ? '' : ' (Module Cookies und Website-Speicher sind aus)'}. ` +
      'Gelöscht wird nur nach Richtlinie, nie bei offenem Tab der Website (je Container), nie für Persistente. Löschung beim Browserende ist nicht garantiert: AnoFox merkt sich die Bereinigung und führt sie beim nächsten Start aus (Best Effort). ' +
      'Nicht entfernbar: CacheStorage, Drittanbieter-Daten unter einer Website (außer Cookies), Daten auf Nicht-Standard-Ports. Erfolg wird nur für Cookies überprüft.'));
    const form = el('div', 'policy-form');
    const site = el('input'); site.type = 'text'; site.placeholder = 'Website (z. B. bank.example.org)'; site.setAttribute('aria-label', 'Website');
    const pol = el('select'); pol.setAttribute('aria-label', 'Richtlinie');
    (['persistent', 'session', 'ephemeral', 'restricted'] as const).forEach((p) => { const o = el('option', undefined, POLICY_LABEL[p]); o.value = p; pol.append(o); });
    const add = el('button', 'btn-accent', '+ Eintrag speichern'); add.type = 'button';
    add.addEventListener('click', async () => {
      if (await send({ type: 'SET_SITE_POLICY', site: site.value.trim(), policy: pol.value })) { toast('Gespeichert'); await render(); }
    });
    const now = el('button', undefined, 'Jetzt bereinigen'); now.type = 'button';
    now.title = 'Bereinigt die Website sofort nach ihrer Richtlinie (außer sie ist persistent oder gerade offen)';
    now.addEventListener('click', async () => {
      if (!site.value.trim()) { toast('Website eingeben'); return; }
      const r = await browser.runtime.sendMessage({ type: 'CLEAN_SITE_NOW', site: site.value.trim() }).catch(() => null);
      toast(r?.result ? `${r.result.cookiesRemoved} Cookies entfernt` : 'Nichts zu bereinigen (persistent, offen oder leer)');
      await render();
    });
    form.append(site, pol, add, now);
    into.append(form);
    const list = el('div', 'policy-rules');
    const entries = Object.entries(sites).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) list.append(el('p', 'policy-desc', 'Keine Einträge: es gilt die Standardrichtlinie.'));
    for (const [domain, p] of entries) {
      const row = el('div', 'policy-rule');
      row.append(el('span', 'policy-rule-text', domain));
      const sel = el('select'); sel.setAttribute('aria-label', `Richtlinie für ${domain}`);
      (['persistent', 'session', 'ephemeral', 'restricted'] as const).forEach((v) => { const o = el('option', undefined, POLICY_LABEL[v]); o.value = v; sel.append(o); });
      sel.value = p;
      sel.addEventListener('change', async () => { if (await send({ type: 'SET_SITE_POLICY', site: domain, policy: sel.value })) await render(); });
      const del = el('button', 'tag-del', '✕'); del.type = 'button'; del.title = 'Eintrag entfernen'; del.setAttribute('aria-label', 'Eintrag entfernen');
      del.addEventListener('click', async () => { if (await send({ type: 'SET_SITE_POLICY', site: domain, policy: null })) await render(); });
      row.append(sel, del);
      list.append(row);
    }
    into.append(list);
    const grace = el('select'); grace.setAttribute('aria-label', 'Nachfrist');
    [[0, 'Sofort'], [30_000, '30 Sekunden'], [60_000, '1 Minute'], [300_000, '5 Minuten'], [1_800_000, '30 Minuten']].forEach(([ms, t]) => { const o = el('option', undefined, `Nachfrist nach dem Schließen: ${t}`); o.value = String(ms); grace.append(o); });
    grace.value = String(st.graceMs);
    if (grace.value !== String(st.graceMs)) { const o = el('option', undefined, `Nachfrist: ${Math.round(st.graceMs / 1000)} s`); o.value = String(st.graceMs); grace.append(o); grace.value = String(st.graceMs); }
    grace.addEventListener('change', async () => { if (await send({ type: 'SET_STORAGE_GRACE', ms: Number(grace.value) })) toast('Nachfrist gespeichert'); });
    into.append(grace);
    if (st.pending.length) {
      into.append(el('p', 'policy-note', `Ausstehende Bereinigungen: ${st.pending.map((p) => `${p.site} (${p.reason}${p.attempts ? `, Versuche ${p.attempts}` : ''}${p.lastError ? ', Fehler: ' + p.lastError : ''})`).join(' · ')}`));
    }
    if (st.results.length) {
      const box = el('div', 'policy-rules');
      for (const r of st.results) {
        const row = el('div', 'policy-rule');
        row.append(el('span', 'policy-rule-text', `${new Date(r.at).toLocaleString()} · ${r.site} · ${r.cookiesRemoved} Cookies entfernt` +
          (r.cookiesFailed || r.cookiesRemaining ? ` · ${r.cookiesFailed} fehlgeschlagen, ${r.cookiesRemaining} verblieben` : '') + ` · ${r.reason}`));
        row.append(el('span', r.ok ? 'chip ok' : 'chip todo', r.ok ? 'Cookies überprüft' : 'unvollständig'));
        if (r.unverified.length) row.append(el('span', 'chip', 'nicht überprüfbar: ' + r.unverified.join(', ')));
        box.append(row);
      }
      into.append(el('h3', 'policy-h', 'Letzte Bereinigungen'), box);
    }
  }

  async function renderNative(into: HTMLElement): Promise<void> {
    const res = await browser.runtime.sendMessage({ type: 'GET_NATIVE_STATUS' }).catch(() => null);
    if (!res?.success || !Array.isArray(res.status) || res.status.length === 0) return;
    into.append(el('h3', 'policy-h', 'Native Firefox-Einstellungen (gelten für den ganzen Browser)'));
    into.append(el('p', 'policy-note',
      'Diese Einstellungen wirken browserweit, nicht pro Website, und werden von der Stufe des Moduls „Fingerprinting-Schutz“ gesteuert. ' +
      'AnoFox ändert nur, was nicht schon dem Zielwert entspricht, übernimmt nie Einstellungen, die eine Richtlinie oder andere Erweiterung kontrolliert, ' +
      'und gibt Einstellungen beim Abschalten wieder frei (auch bei Deinstallation).'));
    const box = el('div', 'policy-modules');
    const chipText = (st: { action: string; levelOfControl?: string; detail?: string }): [string, string] => {
      switch (st.action) {
        case 'unavailable': return ['todo', 'nicht vorhanden'];
        case 'blocked': return ['todo', st.detail ?? 'nicht steuerbar'];
        case 'error': return ['todo', 'Fehler: ' + (st.detail ?? '')];
        case 'set': return ['ok', 'wird gesetzt'];
        case 'clear': return ['ok', 'wird freigegeben'];
        case 'skip-already': return ['', 'bereits so (Firefox)'];
        default: return st.levelOfControl === 'controlled_by_this_extension' ? ['ok', 'von AnoFox gesetzt'] : ['', 'unverändert'];
      }
    };
    for (const st of res.status as Array<{ id: string; label: string; sideEffects: string; desired?: unknown; current?: unknown; action: string; levelOfControl?: string; detail?: string }>) {
      const row = el('div', 'policy-module');
      const text = el('div');
      const [cls, label] = chipText(st);
      text.append(el('strong', undefined, st.label), document.createTextNode(' '), el('span', 'chip ' + cls, label));
      text.append(el('div', 'policy-desc', `Aktuell: ${JSON.stringify(st.current)}${st.desired !== undefined ? ` · Ziel: ${JSON.stringify(st.desired)}` : ''}`));
      text.append(el('div', 'policy-desc', st.sideEffects));
      const sel = el('select'); sel.setAttribute('aria-label', `Überschreibung für ${st.label}`);
      [['auto', 'Automatisch'], ['on', 'Immer schützen'], ['off', 'Nie ändern']].forEach(([v, t]) => { const o = el('option', undefined, t); o.value = v; sel.append(o); });
      sel.value = (res.overrides?.[st.id] as string | undefined) ?? 'auto';
      sel.disabled = st.action === 'unavailable';
      sel.addEventListener('change', async () => {
        if (await send({ type: 'SET_NATIVE_OVERRIDE', id: st.id, override: sel.value })) await render();
      });
      row.append(text, sel);
      box.append(row);
    }
    into.append(box);
  }

  async function renderThreat(into: HTMLElement): Promise<void> {
    const res = await browser.runtime.sendMessage({ type: 'GET_THREAT_STATUS' }).catch(() => null);
    if (!res?.success) return;
    into.append(el('h3', 'policy-h', 'Schutz vor Phishing und Malware'));
    into.append(el('p', 'policy-note',
      'Standardmäßig aus. Aktivierte Listen lädt AnoFox per HTTPS direkt vom Anbieter (ohne Cookies und Referrer; der Anbieter sieht deine IP-Adresse). ' +
      'Der Abgleich geschieht ausschließlich lokal: Es wird keine besuchte Adresse, kein Hash und kein Präfix an einen Dienst gesendet. ' +
      'Treffer auf Hauptseiten zeigen eine Warnseite (mit „Trotzdem öffnen“ für 10 Minuten oder die Sitzung), Unterressourcen werden blockiert. ' +
      'Die Listen blocken ganze Hosts samt Subdomains; Einträge auf sehr großen Plattformen (z. B. google.com) werden bewusst ignoriert. ' +
      'Zusätzlich warnt eine lokale Regel vor Adressen mit Zugangsdaten vor dem Server („paypal.com@fremder-server“), sobald das Modul Phishing nicht aus ist. ' +
      'Nicht umgesetzt: Erkennung ähnlich geschriebener Domains (IDN/Homographen).'));
    const box = el('div', 'policy-rules');
    for (const l of res.lists as Array<{ id: string; kind: string; name: string; description: string; license: string; attribution: string; state: ThreatListState }>) {
      const row = el('div', 'policy-rule');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = l.state.enabled; cb.setAttribute('aria-label', l.name);
      cb.addEventListener('change', async () => {
        cb.disabled = true;
        toast(cb.checked ? `${l.name}: lade …` : `${l.name}: deaktiviere …`);
        const r = await browser.runtime.sendMessage({ type: 'SET_THREAT_LIST_ENABLED', id: l.id, enabled: cb.checked }).catch(() => null);
        if (!r?.success) toast(`${l.name}: Fehler (${r?.error ?? 'unbekannt'})`);
        await render();
      });
      const cur = l.state.current;
      const info = el('span', 'policy-rule-text');
      info.textContent = `${l.name} – ${l.description}` + (cur && l.state.installed
        ? ` · ${cur.filterCount} Einträge in ${l.state.ruleCount} Regeln · Stand ${new Date(cur.fetchedAt).toLocaleString()}` : '');
      row.append(cb, info);
      if (l.state.lastError) row.append(el('span', 'chip todo', 'Fehler: ' + l.state.lastError + ' (vorherige Version bleibt aktiv)'));
      row.append(el('span', 'chip', 'Lizenz: ' + l.license));
      box.append(row);
    }
    into.append(box);
    const upd = el('button', undefined, '🔄 Jetzt aktualisieren'); upd.type = 'button';
    upd.addEventListener('click', async () => {
      upd.disabled = true;
      const r = await browser.runtime.sendMessage({ type: 'UPDATE_THREATS_NOW' }).catch(() => null);
      toast(r?.success ? 'Prüfung abgeschlossen' : 'Aktualisierung fehlgeschlagen');
      await render();
    });
    into.append(upd);
    into.append(el('p', 'policy-note', 'Quellen: ' + (res.lists as Array<{ name: string; attribution: string }>).map((l) => `${l.name} (${l.attribution})`).join(' · ')));
  }

  async function renderLists(into: HTMLElement): Promise<void> {
    const res = await browser.runtime.sendMessage({ type: 'GET_LISTS' }).catch(() => null);
    if (!res?.success) return;
    into.append(el('h3', 'policy-h', 'Filterlisten (experimentell)'));
    into.append(el('p', 'policy-note',
      'Standardmäßig aus. Beim Aktivieren lädt AnoFox die Liste per HTTPS direkt vom Anbieter (ohne Cookies, Referrer oder besuchte URLs); der Anbieter sieht deine IP-Adresse. ' +
      'Compiler und Updater sind getestet, aber noch nicht in echtem Firefox verifiziert. Nicht unterstützte Regeln (z. B. Scriptlets, redirect=) werden übersprungen.'));
    const box = el('div', 'policy-rules');
    for (const l of res.lists as Array<{ id: string; name: string; description: string; license: string; attribution: string; state: {
      enabled: boolean; lastStatus?: string; lastError?: string; current?: { filterCount: number; unsupportedCount: number; fetchedAt: number; version?: string } } }>) {
      const row = el('div', 'policy-rule');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = l.state.enabled; cb.setAttribute('aria-label', l.name);
      cb.addEventListener('change', async () => {
        cb.disabled = true;
        toast(cb.checked ? `${l.name}: lade …` : `${l.name}: deaktiviere …`);
        const r = await browser.runtime.sendMessage({ type: 'SET_LIST_ENABLED', id: l.id, enabled: cb.checked }).catch(() => null);
        if (!r?.success) toast(`${l.name}: Fehler (${r?.error ?? 'unbekannt'})`);
        await render();
      });
      const info = el('span', 'policy-rule-text');
      const cur = l.state.current;
      info.textContent = `${l.name} – ${l.description}` + (cur
        ? ` · ${cur.filterCount} Regeln (${cur.unsupportedCount} nicht unterstützt) · Stand ${new Date(cur.fetchedAt).toLocaleString()}` : '');
      row.append(cb, info);
      if (l.state.lastError) row.append(el('span', 'chip todo', 'Fehler: ' + l.state.lastError + ' (vorherige Version bleibt aktiv)'));
      row.append(el('span', 'chip', 'Lizenz: ' + l.license));
      box.append(row);
    }
    into.append(box);
    const upd = el('button', undefined, '🔄 Jetzt aktualisieren'); upd.type = 'button';
    upd.addEventListener('click', async () => {
      upd.disabled = true;
      const r = await browser.runtime.sendMessage({ type: 'UPDATE_LISTS_NOW' }).catch(() => null);
      toast(r?.success ? 'Prüfung abgeschlossen' : 'Aktualisierung fehlgeschlagen');
      await render();
    });
    into.append(upd);
    into.append(el('p', 'policy-note', 'Quellen: ' + (res.lists as Array<{ name: string; attribution: string }>).map((l) => `${l.name} (${l.attribution})`).join(' · ')));
  }

  return { render };
}
