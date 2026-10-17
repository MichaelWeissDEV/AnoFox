# Phase 8: Phishing- und Malware-Schutz (Listen, Lizenz, Datenschutz, Kapazität)

## Grundentscheidung: nur lokal, keine Cloud-Abfrage
- Der Abgleich läuft ausschließlich lokal über `declarativeNetRequest`. Es wird **keine besuchte Adresse, kein Hash und kein Präfix** an einen Dienst gesendet (kein Safe-Browsing-Lookup, keine Reputations-API).
- Netzwerkzugriff nur zum **Herunterladen der Listen**, die der Nutzer aktiviert (alle **aus** by default): Allowlist, HTTPS, keine Cookies, kein Referrer, nur bedingte Header, Größen-/Zeitlimits, Plausibilitätsprüfung. Der Anbieter sieht die IP-Adresse des Nutzers und den Abruf der Liste, aber keine besuchten Seiten.
- Es werden keine Listen mitgeliefert oder weiterverbreitet.

## Geprüfte Quellen (Stand 2026-10-17)
| Quelle | Format | Größe | Lizenz / Bedingungen (laut Prüfung) | Entscheidung |
|---|---|---|---|---|
| malware-filter `urlhaus-filter-domains-online` (GitLab Pages) | Domains/IPs, Kommentarkopf (`Title/Updated/Expires/Source`) | ~1 700 Einträge, 28 KB, ~12 h Takt | Repository: MIT **und** CC0 (README: URLhaus als CC0 bezeichnet). **Aber** die Originaldaten (abuse.ch URLhaus) stehen laut abuse.ch unter „Fair Use, kostenlos“; die neuen Bedingungen (4.11.2025) und ein Auth-Key für die API sind dort vorgesehen; kommerzielle Nutzung kann kostenpflichtig sein. | ✅ aufgenommen, Hinweis in der Oberfläche; **vor Release neu prüfen** |
| malware-filter `phishing-filter-domains` | Domains | ~30 800 Einträge, 875 KB | Filter: **CC BY-SA 4.0** (Namensnennung, Weitergabe unter gleichen Bedingungen). Quellen: OpenPhish („kostenlos“ laut deren Bedingungen), IPThreat (CC BY-SA 4.0), PhishTank. | ✅ aufgenommen mit Attribution; Daten Dritter, nicht weiterverbreitet |
| Phishing.Database `phishing-domains-ACTIVE.txt` | Domains | ~392 000 Einträge, 11 MB | MIT (Repository-LICENSE) | ✅ optional („groß“), Standardintervall 24 h |
| URLhaus Hostfile direkt (urlhaus.abuse.ch) | hosts | ~430 Einträge | abuse.ch-Bedingungen (Fair Use, Auth-Key für API) | ❌ nicht aufgenommen: direkte Abrufe vieler Clients bei abuse.ch sind unklar durch „Fair Use“ gedeckt; die Mirror-Liste liefert dieselben Daten |
| Google Safe Browsing / Hash-Präfix-Protokolle | – | – | – | ❌ **ausgeschlossen** (Cloud-Abfrage) |
| OpenPhish / PhishTank direkt | Feeds | – | Registrierung/Bedingungen nicht geprüft | ❌ nicht aufgenommen |

Die Lizenzaussagen stammen aus Websuche und den README-/LICENSE-Dateien der Repositories; sie sind **keine Rechtsberatung**. `NOTICE.md` führt sie auf.

## Messungen (echter Firefox 158, `npm run test:firefox:threat`)
- Limits: `MAX_NUMBER_OF_DYNAMIC_RULES` = 5000, `MAX_NUMBER_OF_REGEX_RULES` = **1000**, statisch garantiert 30 000.
- `requestDomains` mit **5 000 Domains in einer Regel** funktioniert. **400 000 Domains** (800 Regeln à 500) installieren in ~0,65 s; Treffer am Anfang/in der Mitte/am Ende und auf Subdomains stimmen; Lookalikes/ungelistete Hosts werden nicht getroffen; IPv4-Literale und Punycode-Hosts sind listbar; **keine messbare Navigationslatenz** (110 ms vs. 110–130 ms).
- Weiterleitung auf die Warnseite: `redirect.regexSubstitution` mit `\0` (= **gesamter Treffer**, deshalb muss `regexFilter` die ganze URL verbrauchen – ein Fehler, den die E2E-Suite aufdeckte) liefert `moz-extension://…/blocked.html?l=<liste>&u=<ursprüngliche URL>` inkl. Query und Fragment.
- Reale Listen durch Parser und Compiler: Online-Malware 1 703 Domains → 2 Regeln; Phishing-Filter 30 788 → 32 Regeln; Phishing.Database 391 970 → 392 Regeln (196 Regex-Regeln), Parsen 0,5 s, 93 Einträge wegen „Nie blockieren“ verworfen.
- Gruppen à 2 000 Domains halten die Regex-Regelzahl niedrig (große Liste ≈ 196 von 1 000). Der Adblock-Regelreserve wurde auf 1 300 erhöht, damit Threat-Listen nie vom Adblock-Kontingent verdrängt werden.

## Design
- **Treffer auf Hauptseiten:** Weiterleitung auf `blocked.html` (Warnseite, in `web_accessible_resources`). **Unterressourcen/Frames:** blockiert. Es wird immer der ganze Host samt Subdomains erfasst.
- **Prioritätsband 15:** über Adblock (1–5) und URL-Bereinigung (6/10), unter den Policy-Bändern (20+). Weder Adblock-Pause noch Cleaner-Ausnahmen heben einen Threat-Block auf (E2E belegt).
- **Freigabe („Trotzdem öffnen“):** Session-Regel (Band 17, nur `requestDomains` des Hosts) für 10 Minuten oder bis Browserende; sie hebt **nur** die Threat-Regeln auf. Den Host leitet der Hintergrund aus der **eigenen URL der Warnseite** ab (`sender.url`), nie aus einer Nachricht; Nachrichten von anderen Seiten werden abgelehnt (E2E belegt). Maximal 100 Freigaben.
- **Irreführende Adressen:** eine lokale Regel für `http(s)://name@server…` (Zugangsdaten vor dem Host) leitet auf die Warnseite um (Modul „Phishing“ ≠ aus).
- **Schutz gegen vergiftete Listen:** Die Domains werden vollständig validiert (nur ASCII-Hostnamen/IPv4, keine reinen öffentlichen Suffixe), eine **„Nie blockieren“-Menge** (Mozilla, Google, Microsoft, Apple, GitHub …) wird immer verworfen, und ein Update wird **abgelehnt**, wenn mehr als 5 % der Einträge dort landen, die Liste auf unter 40 % schrumpft, auf über das Dreifache wächst, zu klein ist oder nicht ins Kontingent passt. Fehlgeschlagene Updates lassen die bisherigen Regeln unverändert (atomarer Austausch je Liste).
- Die Domains werden **nicht gespeichert**; die installierten Regeln sind die Daten. Module „Malware“/„Phishing“ auf „aus“ entfernen die Regeln der betroffenen Listen; beim Wiedereinschalten wird neu geladen. „Zurücksetzen“ schaltet alle Listen aus und widerruft Freigaben.

## Grenzen
- Listen blocken **Domains**, keine einzelnen Pfade; auf gemeinsam genutzten Hosts (große Plattformen, Hosting-Subdomains) gilt: ein Eintrag auf einer „Nie blockieren“-Domain wird ignoriert (Lücke), ein Eintrag auf einer kleineren Hosting-Domain blockiert den ganzen Host.
- Nicht umgesetzt: Erkennung ähnlich geschriebener/IDN-Domains (Homographen), URL-Pfad-Listen (z. B. vollständige URLhaus-URLs), Wiederherstellung per Hash-Präfix, Meldung falscher Treffer.
- Listendaten sind unsigniert (SHA-256 nur zur Änderungserkennung). Ein kompromittierter Anbieter könnte Listen ändern; die Schutzmechanismen oben begrenzen den Schaden (Denial-of-Service-Schutz), verhindern ihn aber nicht vollständig.
- Frische: Phishing-Domains leben oft nur Stunden; Aktualisierung alle 12–24 h (Alarm alle 30 Min prüft, ob fällig). Nicht getestet: echte Downloads im Browser, Verhalten über Neustarts hinweg.

## Tests
- Unit (`test/threat-lists.test.ts`): Parser (Formate, Validierung, Nie-Blockieren, Metadaten), Compiler (Gruppen, ID-Bereiche, Substitutions-String), Prioritätsbänder, Warn-URL-Parser (nur http/https), Userinfo-Regex (ganze URL), Quellen-Allowlist, Manager gegen Fakes (Guards, Quota, Rollback, Level aus/an, unverändert).
- Firefox (`npm run test:firefox:threat`): Kapazität und Semantik (siehe Messungen).
- E2E (`E2E_FILTER=threat`): 10 Prüfungen mit der gebauten Erweiterung (Hauptseite, Subdomain, Phishing-Liste, Unterressourcen, Freigabe, Freigabe nur von der Warnseite, Adblock-Pause/Cleaner heben nicht auf, irreführende URL, Modul aus, Reset). Die Listendaten stammen aus einem Test-Hook (`E2E_APPLY_THREAT_DOMAINS`, nur im E2E-Build einkompiliert).
