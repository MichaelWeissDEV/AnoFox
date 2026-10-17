# AnoFox – Capability Matrix

**Status der Verifikation (Stand 2026-10-17):** Zeilen mit „Firefox 158“ in der Spalte Tests sind durch automatisierte Messungen/Ende-zu-Ende-Tests in echtem Firefox 158 (Desktop, macOS) belegt (`npm run test:firefox`, `npm run test:e2e`). Zeilen mit ⚠ sind **nicht** verifiziert und dürfen nicht als Zusage in der Oberfläche erscheinen. TypeScript-Typen (`@types/firefox-webext-browser@120`) sind keine Quelle für die API-Verfügbarkeit. Andere Firefox-Versionen und Betriebssysteme wurden nicht geprüft.

Legende – Wirkung: **B** = blockiert vor Anfrage · **M** = verändert/verringert · **D** = erkennt/zeigt nur · **–** = nicht möglich.
Scope: **G** = global · **S** = pro Site · **C** = pro Container.

## Implementiert (Ist)

| Feature | API / Permission | Scope | Vor Anfrage | Wirkung | Firefox min. | Einschränkungen / Konflikte | Tests |
|---|---|---|---|---|---|---|---|
| Tracking-Parameter entfernen | `declarativeNetRequest` (`redirect`+`queryTransform.removeParams`), Host-Permission | G, Ausnahmen pro Ziel-Domain | ja | M | 113 (MV3-DNR), Query-Transform ⚠ | Nur `main_frame`/`sub_frame`; Parameternamen exakt (Case-Varianten expandiert); Konflikt mit uBlock `removeparam` möglich; Defekte S-5/S-6 | Unit (Cleaner), keine Browser-Tests |
| Social-Embed-Block | DNR `block` (`sub_frame`,`script`,`xmlhttprequest`) | G; Ausnahme **defekt** (S-1) | ja | B | 113 | Muster S-4; Facebook-SDK-Block bricht „Login with Facebook" | Unit (Regelstruktur) |
| Click-to-load-Platzhalter | Content Script (isolated world), Shadow DOM | S | nach Parsing, vor Netzwerk nur dank DNR-Block | M | 128 | Nur Top-Frame (`all_frames` fehlt); Seiten-CSS kann Hosts beeinflussen | Unit teilweise |
| Temporäre Freigabe | DNR dynamic `allow` | G | ja | – | 113 | **Dauerhaft statt temporär** (S-3) | keiner |
| Logging / Statistik (RAM) | JS, Zukunft `storage.session` | G | – | D | 115 (`storage.session`) | Verlust bei Event-Page-Suspend (A-2) | Unit |

## Geplante Features (Soll) und technische Machbarkeit

| Feature | Benötigte API / Permission | Scope | Vor Anfrage | Wirkung | Firefox min. | Wichtige Grenzen | Konflikte | Tests nötig |
|---|---|---|---|---|---|---|---|---|
| Netzwerk-Firewall 3rd-party | DNR `domainType: thirdParty`, `initiatorDomains`; PSL im Code (kein Browser-API für eTLD+1 in DNR) | G/S | ja | B | 113 | DNR kennt eTLD+1-Logik für `thirdParty` selbst; eigene Listen brauchen PSL-Datei (MPL-2.0) | uBO, andere DNR-Erweiterungen | Browser-Integration |
| Container-/Private-Window-Kontext | `webRequest` (`cookieStoreId`, `incognito`) ; DNR kennt Container **nicht** | C | webRequest blocking nur MV2-artig ⚠; in MV3 `webRequestBlocking` für Firefox weiterhin erlaubt ⚠ verifizieren | B | ⚠ | DNR-Regeln gelten containerübergreifend; Container-Policy nur über webRequest | – | ja |
| Filterlisten (EasyList etc.) | DNR dynamic/static Rulesets, `fetch` | G | ja | B/M | 113 | Regelkontingent (⚠ verifizieren, Firefox: 30 000 dynamisch, 5 000 „unsafe"); nur Teilmenge der ABP-Syntax übersetzbar; Regex-Limits; `$redirect`, `$csp`, `$removeparam` begrenzt | uBO | Compiler-Unit + Rule-Count + Browser |
| Kosmetische Filter | Content Script + `tabs.insertCSS`/`scripting.insertCSS` | S | nein (nach Parse) | M | 102 (`scripting`) | Kurzes Aufblitzen möglich; keine Scriptlets | uBO | Content-Test |
| Script-Blocking extern | DNR `block` für `script` | G/S | ja | B | 113 | Nur Netzwerkskripte | – | Browser: Skript wird nicht ausgeführt |
| Script-Blocking inline/gesamt | **DNR `modifyHeaders` `append` auf `Content-Security-Policy`** (main_frame/sub_frame) – in Firefox 158 real getestet (`npm run test:firefox:csp`) | S (Dokument-Domain)/G | ja (Header der Dokumentantwort) | B | 128 laut Forum, **nur 158 getestet** | Wirkt erst beim nächsten Laden; nur `append` (CSP der Seite wird nie geschwächt, Policies schneiden sich); `webRequest`-blocking-Listener wurde in MV3/Firefox 158 nie aufgerufen → nicht nutzbar; `<noscript>` wird bei CSP `none` nicht angezeigt (bei `sandbox` schon); keine Tab-/Einmal-Ausnahmen | Seiten-CSP (Schnittmenge), andere Erweiterungen mit CSP-Regeln | Browser: Firefox 158 (10 Checks) |
| Worker / Wasm | CSP `worker-src`, `script-src 'wasm-unsafe-eval'` | S | ja | B (über CSP) | – | Service-Worker-Registrierungen nur über CSP/`browsingData`; `blob:`/`data:` per CSP | – | Browser |
| Fingerprinting – native | `browser.privacy.*` (Permission `privacy`) | **nur G (browserweit)** | ja | M | 128; **Messung nur Firefox 158** | `resistFingerprinting` setzbar (`levelOfControl` geprüft); Wirkung gemessen (Zeitzone, Canvas, WebGL, Farbschema), **nicht** auf UA/Plattform/Sprache/Audio/Fonts; `httpsOnlyMode` nicht steuerbar, `firstPartyIsolate` bei partitionierten Cookies nicht aktivierbar; Nebenwirkungen siehe fingerprinting-native.md | Andere Erweiterungen/Richtlinien (`controlled_by_other_extensions`) | Firefox 158 (6 Checks) + 6 Unit |
| Fingerprinting – JS-Hooks (navigator: UA/Plattform/Sprache/Hardware) | `scripting.registerContentScripts` (MAIN oder ISOLATED+Xray) | S | nein | M | 128 (`matchOriginAsFallback`); **nur 158 getestet** | **Nicht ausgeliefert**: Hooks laufen früh und in iFrames, aber Dedicated Worker, HTTP-Header und API-Spuren (toString, Fehlerverhalten, Name) verraten die Manipulation – siehe fingerprinting-normalization.md | andere Fingerprinting-Erweiterungen | Firefox 158 (7 Checks, dokumentieren die Grenzen) |
| UA / Client-Hints / Accept-Language | DNR `modifyHeaders` (Request) | S/G | ja | M | 113 | JS-`navigator.*` muss konsistent mitgezogen werden (sonst Widerspruch) | – | Konsistenztest |
| Referrer-Minimierung | DNR `modifyHeaders` (`referer` remove/set) ; `network.http.referer*` nicht per API | G | ja | M | 113 | Entfernen von `Referer` kann CSRF-/Hotlink-Prüfungen brechen | – | Browser |
| Ping-/Beacon-Block | DNR `resourceTypes: ["ping","beacon"?]` ⚠ (`ping` ja; Beacon wird als `ping`/`other` klassifiziert ⚠) | G | ja | B | 113 | `Navigator.sendBeacon` Typ in Firefox verifizieren | – | Browser |
| Cookie-Verwaltung | `cookies` (inkl. `partitionKey`, Firefox 131+ ⚠), `<all_urls>` | S/C | – (Löschung nachträglich) | M | 128/131 ⚠ | Kein Hook „Cookie wird gesetzt" ohne `webRequest`-Header-Zugriff; `cookies.onChanged` reaktiv | Container | Unit + Browser |
| Site-Daten löschen | `browsingData.remove({hostnames})` (Firefox ≥ 77) ; `cookieStoreId` Option | S/C | – | M | 77 | `hostnames` löscht auch Subdomains; **Reichweite je Datentyp testen** (Cache/ServiceWorkers/IndexedDB/LocalStorage ⚠) | andere Erweiterungen | Browser-Integrationstest zwingend |
| Auto-Cleanup beim Schließen | `tabs.onRemoved`, `runtime.onStartup`, `storage.local` Cleanup-Intentionen | S | – | M (best effort) | – | `runtime.onSuspend` unzuverlässig → Intentionen persistieren und beim Start abarbeiten | – | Simulation |
| Consent-Manager | Content Script (Top-Frame), DOM-Klicks / `display:none`; Background nur für Modus und Regeln | S | nein | M | 140 | Nur Hauptdokument; nachgebaute Dialoge statt Live-Skripte geprüft; nie Zustimmung | Seiten-Skripte der CMPs, uBO Annoyances | Firefox 158 E2E (21 Prüfungen) + Unit |
| Phishing-/Malware-URL-Check | DNR `requestDomains` (Regeln, `regexSubstitution`-Redirect auf `blocked.html`), lokale Listen per `fetch` | G | ja | B (Unterressourcen) / Warnseite (Hauptseite) | 113 (DNR); **nur 158 gemessen** | Domain-Ebene, kein Pfad; 400 000 Domains in 0,65 s installiert, kein Latenzeffekt; Limits dynamisch 5000, Regex 1000; keine Cloud-Abfrage; keine IDN-/Homographen-Erkennung | Adblock-Pause und Cleaner heben nicht auf (Bänder), Policy-Bänder darüber | Firefox 158 (9 Checks) + E2E (10) + Unit |
| Berechtigungen (Kamera/Geo …) | Keine WebExtension-API für Permission-Prompts; Alternativen: `Permissions-Policy` Header per `onHeadersReceived` blocking, MAIN-World-Hooks | S | ja (Header) | M | ⚠ | Kein Eingriff in Firefox-Berechtigungsdialog | – | Browser |

## Bewusst nicht umsetzbar bzw. nicht als Zusage

| Mechanismus | Grund |
|---|---|
| TLS-Fingerprint, HTTP/2-/HTTP/3-Merkmale | Nicht von Erweiterungen kontrollierbar |
| Canvas/WebGL/Audio vollständig unauffällig verfälschen | Ohne Nachweis, dass die Wiedererkennbarkeit sinkt, bleibt es deaktiviert/experimentell; Zufall erzeugt selbst Fingerprint |
| Vollständige Abschottung von MAIN-World-Hooks | Seite kann Hooks erkennen/umgehen |
| Garantiertes Löschen beim Browserende | `onSuspend`/Shutdown nicht verlässlich → nur Best-Effort + Wiederaufnahme beim Start |
| Inline-Script-Überwachung als „vollständig" | Nicht beobachtbar außerhalb CSP-Reports |
| Pro-Site-Wirkung von `privacy.*`-Settings | Browserweit |

## Nächste Schritte für die Matrix

1. Jede ⚠-Zeile mit aktuellem MDN-/Bugzilla-Stand und einem automatisierten Firefox-Test belegen (Test-Harness T-1 in `audit-phase0.md`).
2. Pro Modul ein Eintrag mit `testStatus` in `src/core/capabilities`, den die UI zur Laufzeit liest (keine Zusage ohne `verified: true`).
