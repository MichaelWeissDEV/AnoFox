# Phase 0 – Bestandsaufnahme (Audit)

Stand: 2026-10-16 · Basis: Code in `src/`, `public/`, `test/`, `build.mjs`.
Ergebnis von `npm test`: 32/32 grün. `npm run build`: ok. `web-ext lint`: 0 Fehler, 1 Warnung.
`tsc --noEmit`: **schlägt fehl** (siehe B-1). Das Verzeichnis ist **kein Git-Repository** – lokale Commits/Rollback sind aktuell nicht möglich.

## Was vorhanden ist

| Modul | Datei | Zustand |
|---|---|---|
| URL-Cleaner (Tracking-Parameter) | `url-cleaner.ts`, `dnr-manager.ts` | Funktioniert; Durchsetzung per DNR `queryTransform`, JS-Cleaner dient nur Logging/Tests |
| Social Embed Guard | `embed-guard.ts`, `content-embed-guard.ts`, `dnr-manager.ts` | 9 Anbieter, DNR-Block + Content-Script-Platzhalter; **Exceptions-Logik defekt (S-1)** |
| Logger / flüchtige Statistik | `logger.ts`, `stats.ts` | Funktioniert, aber RAM-Zusage nicht lifecycle-fest (A-2) |
| UI | `popup`, `options` | Funktional, einfaches Schema; keine Validierung beim Import prüfbar ohne Vollsicht (offen) |

Nicht vorhanden: Policy Engine, Filterlisten, Script-Control, Fingerprinting, Cookie/Storage-Manager, Consent-Manager, Phishing/Malware, Container-Logik, Permissions-Kontrolle.

## Funktionale Fehler (hoch)

**S-1 – Embed-Ausnahmen wirken nicht.** `dnr-manager.ts` setzt für „Embeds auf Seite X erlauben" `excludedRequestDomains`/`requestDomains = [X]`. Diese Felder prüfen die **Ziel-Domain** der Anfrage (youtube.com), nicht die einladende Seite. Folge: Allow-Regel greift nie, der iframe bleibt per DNR blockiert, obwohl der Nutzer die Seite freigegeben hat. Korrekt: `initiatorDomains` / `excludedInitiatorDomains` (Firefox ≥ 113). Tests prüfen das nicht (Regelstruktur wird nur gezählt).

**S-2 – Auth/Signed-Allow-Regel (1003, prio 10) überstimmt den Embed-Block (prio 1).** Sie gilt für `sub_frame`; jede iframe-URL mit `token=`, `state=`, `code=`, `sig=` usw. wird damit vom Embed-Block ausgenommen. Genau der in der Aufgabenstellung genannte Fall „Ausnahme hebelt andere Schutzregeln aus". Dieselbe Mechanik gilt später für Malware-/Filterregeln → Modul-Namespaces + Prioritätsbänder nötig.

**S-3 – „Temporäre" Embed-Freigaben sind dauerhaft.** `allowEmbedTemporarily` nutzt *dynamische* Regeln (IDs 3000–3099, Ringpuffer), die Browser-Neustarts überleben und nie entfernt werden; Zähler `tempRuleCounter` ist RAM und startet nach Event-Page-Suspend wieder bei 0 → überschreibt zufällig vorhandene Freigaben. Korrekt: Session-Regeln (`updateSessionRules`) mit tab-/ablaufbezogener Verwaltung. Außerdem wird die URL ungeprüft als `urlFilter` verwendet (`*`, `^`, `|` in URLs werden als Syntax interpretiert) und ist nicht auf den Initiator begrenzt.

**S-4 – `urlFilter`-Syntax.** Muster wie `*://*.youtube.com/embed/*` erfordern ein Subdomain-Label (`.youtube.com` mit führendem Punkt) und matchen nicht `https://youtube.com/embed/…`; zudem matcht `://…` auch in Query-Strings fremder URLs. Korrekt: `||youtube.com/embed/` (Domain-Anker). Zu verifizieren per Regeltest in Firefox (siehe T-1).

**S-5 – Redirect-Regel für *jede* Navigation.** Regel 1001 hat `urlFilter: '*'` + `redirect/queryTransform` für alle `main_frame`/`sub_frame`. Sie matcht auch URLs **ohne** Tracking-Parameter; der Schutz vor Redirect-Schleifen (`RedirectLoopGuard`) existiert nur, um dieses Design zu kompensieren, und ist selbst wirkungslos für die Durchsetzung (er stoppt nur Logging). Besser: `regexFilter` auf Parameterpräsenz (Firefox nutzt RE2; Komplexitätslimit prüfen via `isRegexSupported`) oder mehrere gezielte Regeln.

**S-6 – DNR-Auth-Regex und JS-`isSignedOrAuthUrl` driften auseinander.** DNR schützt 7 Parameternamen, der JS-Cleaner ~35. Maßgeblich ist DNR (Enforcement) → die URL mit `access_token` + `utm_source` wird vom Browser bereinigt, die Tests behaupten das Gegenteil. Eine einzige Quelle (Generator) nötig.

## Architektur / Lifecycle

**A-1 – Race beim Start.** `initializeSettings()` läuft asynchron; `onMessage` kann vorher `GET_SETTINGS` mit Defaults beantworten, ein früh gesendetes `UPDATE_SETTINGS` wird dann vom späteren Init überschrieben. Nötig: `ready`-Promise, auf das alle Handler warten.

**A-2 – Event-Page-Suspend.** Firefox-MV3-Hintergrundskripte sind nicht-persistent. `activeSettings`, `privacyStats`, `logger`-Ringpuffer, `loopGuard`, `recentlyLoggedUrls` gehen beim Suspend verloren. README-Zusage „bis Browserende im RAM" stimmt nicht; Lösung: `storage.session` (RAM-only, bleibt über Suspend) statt Modulvariablen.

**A-3 – Settings-Persistenz ohne Schema.** Keine Version, Migration, Rollback. `UPDATE_SETTINGS` schreibt das gesamte Objekt; `storage.onChanged` übernimmt Werte ungeprüft (nur teilweise typgeprüft). Parallele Schreibzugriffe aus Popup/Options → Last-Write-Wins. `RESET_SETTINGS` ruft `storage.local.clear()` + `set` nicht atomar (Datenverlust bei Abbruch dazwischen).

**A-4 – Duplizierte `syncDnrRules`-Aufrufe** (7× kopierter Argumentblock in `background.ts`). Fehleranfällig; gehört in eine `applyPolicy()`.

**A-5 – Fehler beim Sync werden nur geloggt.** `updateDynamicRules` ist atomar (alles oder nichts), aber UI erfährt nichts vom Fehlschlag und zeigt „aktiv". Kein Quota-Check, keine Konflikt-/Duplikaterkennung, ID-Vergabe per laufender Zahl (instabil bei Änderung der Anbieterliste).

**A-6 – UI-Bundle zieht Laufzeitcode des Backends.** `options.ts` importiert `dnr-manager.ts` (und damit Logger, Embed-Icons) nur für `sanitizeDomainList`. → `core/domain-utils` auslagern.

**A-7 – Domain-Handling naiv.** `sanitizeDomainList` verlangt nur einen Punkt, kein eTLD+1/PSL, entfernt Wildcards stillschweigend (aus `*.co.uk` wird `co.uk`, das **alle** .co.uk-Seiten ausnimmt) und akzeptiert IPs/IDN nicht normalisiert (kein Punycode). Genau das Risiko aus 6.3 der Aufgabe.

## Manifest / Berechtigungen

- `declarativeNetRequestFeedback` ist nur für Debug (`onRuleMatchedDebug`) nötig und liefert in Release-Builds ohnehin kein Event → entfernen oder nur in Dev-Build.
- `tabs` wird vermutlich nur für aktive URL im Popup gebraucht → `activeTab` genügt (zu prüfen); `tabs` gewährt Zugriff auf URLs/Titel aller Tabs.
- `webRequest` (ohne Blocking) nur für `onBeforeRedirect`-Logging. Ob DNR-Redirects dort sichtbar sind, ist nicht dokumentiert zugesichert → Logging unzuverlässig; Statistik-Zahlen unter Umständen zu niedrig/falsch.
- `host_permissions: <all_urls>` ist für DNR `redirect` nötig; für `block`/`allow` nicht. Content-Script auf `<all_urls>` ohne `all_frames` → Embeds in Subframes unbehandelt.
- `data_collection_permissions` fehlt (Lint-Warnung, für neue Add-ons Pflicht) → `{"required": ["none"]}`.
- Platzhalter-ID `anofox@example.org`.

## Build / Test

- **B-1** `tsc` scheitert wegen `.ts`-Importendungen (`allowImportingTsExtensions` fehlt). Es gibt kein `typecheck`-Skript; esbuild prüft keine Typen → Typfehler unbemerkt. Fix: `allowImportingTsExtensions: true` (+ `noEmit` ist schon gesetzt) und `npm run typecheck` in `lint`/CI.
- **B-2** Kein Test läuft gegen echtes Firefox-DNR. Behauptungen wie „Redirect-Loop-Schutz", „Prioritäten" sind nur strukturell getestet. → T-1.
- **B-3** `dist/` ist eingecheckt/ im Baum; `build.mjs` löscht und baut neu (ok), aber `dist` gehört in `.gitignore`.
- **B-4** Kein Content-Script-Test (DOM, Platzhalter, Shadow-DOM), kein Options-/Import-Test.
- **T-1 (Empfehlung)** Integrationstests mit `web-ext run`/Selenium-Firefox (geckodriver, `moz:firefoxOptions`) gegen lokale Testserver (Ports mit unterschiedlichen eTLD+1 via `*.localhost`/hosts), Regelpräzedenz und Initiator-Matching real prüfen.

## Datenverlust-/Kompatibilitätsrisiken

- Import (`options.ts:630`) und `RESET_SETTINGS` überschreiben ohne Backup/Rollback.
- Eigene Allow-Regeln (prio 10/20/50) können in Firefox Regeln **anderer** Erweiterungen nicht übersteuern (Browser wertet über Erweiterungen hinweg: `block` einer Erweiterung gewinnt nicht automatisch – Verhalten ist spezifiziert als Block-Vorrang über Erweiterungen; vor Aussagen live verifizieren). Parallelbetrieb mit uBlock Origin: DNR-Redirect/`queryTransform` kann mit dessen `removeparam` doppelt greifen; bisher keine Erkennung.

## Empfohlene Reihenfolge

1. Sofortfixes S-1…S-6, A-1, A-4, B-1 mit Regressionstests (klein, hoch wirksam).
2. Policy-/Settings-Kern (Schema, Migration, Namespaces, `storage.session`).
3. Rule Manager mit Prioritätsbändern pro Modul; Integrationstest-Harness in echtem Firefox.
4. Erst danach neue Schutzmodule (Phase 3 ff.), jeweils mit Capability-Eintrag und Test.

## Umsetzungsstatus (2026-10-16)

Behoben und per Unit-Test abgesichert: S-1 (Initiator-Matching), S-2 (Prioritätsbänder), S-3 (Session-Regeln, exakte URL, nur bekannte Embeds), S-4 (`||`-Filter), S-5 (Regex nur bei vorhandenem Parameter), S-6 (gemeinsame Quelle), A-1 (`ready`), A-3 teilweise (Schema v1, Migration, validierter Import/Export), A-4 (`applyPolicy`, serialisiert), A-6/A-7 teilweise (`core/domain-utils`), B-1 (`npm run typecheck`).
**Nicht in echtem Firefox verifiziert** (nur Unit-Tests der Regelstruktur): Regex-Support/Limits (`isRegexSupported`), `initiatorDomains`-Verhalten, Session-Regeln. Offen: T-1, A-2 (`storage.session`), PSL/eTLD+1, Manifest-Berechtigungen.
