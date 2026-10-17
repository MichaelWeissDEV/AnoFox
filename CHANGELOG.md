# Changelog

Alle nennenswerten Änderungen an AnoFox. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [SemVer](https://semver.org/lang/de/). Solange die erste Version in Entwicklung ist, steht alles unter
**Unveröffentlicht**; es gibt keine Releases, Pakete oder Veröffentlichungen.

## [Unveröffentlicht] – 0.1.0 (in Entwicklung)

### Hinzugefügt
- **URL-Bereinigung** per `declarativeNetRequest` (nur Anfragen mit Tracking-Parameter, Schutz signierter und Auth-URLs,
  Ausnahmen pro Website).
- **Social Embed Guard** für 9 Anbieter mit Platzhalter und Freigabe pro Website; temporäre Freigaben als Sitzungsregeln für
  genau eine URL.
- **Policy-Engine und Schutzprofile** (Balanced, Strict, Lockdown, Custom) mit Modulstufen, deterministischen Vorrangregeln,
  Prioritätsbändern und Benutzerregeln (Website/global, Ziel, dauerhaft/Sitzung/Tab).
- **Skript-Kontrolle**: Drittanbieter-Skripte (Strict), Default-Deny (Lockdown), Modul „Inline-Skripte & Eval“ über
  angehängte Content-Security-Policy (in Firefox 158 gemessen), Ausnahmen pro Website.
- **Filterlisten**: ABP-Parser (Netzwerk und Kosmetik), DNR-Compiler (Gruppierung, `$important`, `$badfilter`, Quota),
  Listen-Updater mit Allowlist, Limits, Plausibilitätsprüfung und Rollback, Kosmetik-Engine
  (Content-Skript + `scripting.insertCSS`), „Werbeblocker auf dieser Website pausieren“.
- **Cookie Vault**: Richtlinien persistent/Session/ephemeral, Planer mit Sicherheitsregeln (offene Tabs, Container,
  Partitionen, vertrauenswürdige Subdomains), persistente Bereinigungswarteschlange mit Backoff, Überprüfung des Ergebnisses.
- **Native Firefox-Einstellungen** über `browser.privacy` mit `levelOfControl`-Prüfung, Überschreibung pro Einstellung und
  Freigabe per `clear()`.
- Versioniertes **Einstellungsschema** (v2) mit Migration, Validierung, Import/Export und Rollback.
- Neuer Optionen-Tab **Schutzprofile** (Profile, Module, Regeln, native Einstellungen, Listen, Cookie Vault) und
  Profil-/Website-Steuerung im Popup.
- **Cookie-Banner-Manager** (Modi Manuell/Ablehnen/Ausblenden, Adapter für OneTrust, Cookiebot, Usercentrics, Klaro, Didomi,
  Quantcast und ein generischer Erkenner): erteilt nie Zustimmung, verweigert Klicks auf zustimmend beschriftete Elemente,
  blendet blockierende Dialoge nicht aus; Abschalten pro Website. Geprüft gegen nachgebaute Dialoge.
- **Phishing- und Malware-Schutz** nur mit lokalen Listen (keine Cloud-Abfrage): Domain-Parser mit „Nie blockieren“-Menge,
  Compiler (bis 400 000 Domains in Firefox gemessen), Warnseite mit Freigabe nur über die eigene Seite, Warnung vor Adressen
  mit Zugangsdaten vor dem Server, Schutz gegen vergiftete Listen, Listen-Manager mit Rollback. Quellen: URLhaus (via
  malware-filter), Phishing-Filter, Phishing.Database, alle standardmäßig aus.
- Logo und Erweiterungs-Icons.
- Tests: Unit-Tests, Firefox-Messsuiten (CSP, `privacy`-API, Navigator, Löschreichweite) und eine
  **Ende-zu-Ende-Suite mit der gebauten Erweiterung in echtem Firefox** (63 Prüfungen).
- Dokumentation der Fähigkeiten und Messungen unter `docs/architecture/`.

### Geändert
- `dnr-manager` neu strukturiert: stabile Regel-IDs je Modul, atomarer Austausch, Prioritätsbänder, Sitzungsregeln.
- Einstellungen werden beim Start vor jeder Nachricht geladen (kein Race mehr); Regelanwendung ist serialisiert.
- Mindestversion **Firefox 140** (wegen `data_collection_permissions`).
- Lizenz: **GPL-3.0-or-later**.

### Behoben
- Embed-Ausnahmen wirkten nie: Sie nutzten `requestDomains` (Zielhost) statt `initiatorDomains` (einbettende Seite).
- Die Auth-/Signatur-Ausnahme (Priorität 10) hob Embed-Blöcke auf; Regeln leben jetzt in getrennten Prioritätsbändern.
- „Temporäre“ Embed-Freigaben waren dauerhaft (dynamische Regeln); jetzt Sitzungsregeln für exakt eine URL, nur bekannte
  Embed-Anbieter.
- `urlFilter`-Muster (`*://*.host/…`) trafen die blanke Domain nicht; jetzt `||host/…`.
- Die Umleitungsregel traf jede Navigation; jetzt nur Anfragen mit Tracking-Parameter.
- Die Auth-Regex des DNR-Layers und die JS-Prüfung liefen auseinander; gemeinsame Quelle.
- **Lockdown blockierte die eigenen Anfragen der Erweiterung** (z. B. Listen-Updates) durch ihre Default-Deny-Regeln;
  gefunden durch die E2E-Suite, Erweiterungs-Initiator ist jetzt ausgenommen.
- `tsc` schlug fehl (`allowImportingTsExtensions`); `npm run typecheck` ergänzt.

### Bewusst nicht enthalten
- Navigator-Spoofing (UA, Plattform, Sprache, Hardware): in Firefox 158 nachweislich erkennbar (Worker, Header, API-Spuren).
- Veröffentlichung, Store-Paket, Releases, Pushes.

### Bekannte Einschränkungen
- Nur Firefox 158 (Desktop, macOS) wurde getestet.
- Das Regelkontingent für dynamische Regeln ist in Firefox nicht eindeutig dokumentiert; große Listen (EasyPrivacy ≈ 9 000 Regeln
  nach Optimierung) können abgeschnitten werden und sind dann als „teilweise“ gekennzeichnet.
- `webRequest` und `declarativeNetRequestFeedback` sind nur für das optionale Log bereinigter URLs nötig und werden voraussichtlich
  entfernt.
- Die Consent-Adapter sind nicht gegen die Live-Skripte der Anbieter geprüft.
- Siehe `README.md` → „Was AnoFox nicht kann“.
