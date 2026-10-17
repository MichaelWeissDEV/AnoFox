# Hinweise zu Drittinhalten

AnoFox selbst steht unter **GPL-3.0-or-later** (siehe `LICENSE`).

## Filterlisten (Daten Dritter, nicht Teil dieses Repositories)

Das Repository enthält **keine** Filterlisten. Sie werden nur auf ausdrücklichen Wunsch zur Laufzeit von den Anbietern geladen.

**Ausnahme Schnappschuss-Pakete:** Wer `npm run build:rulesets` ausführt, bevor er `npm run build` startet, erhält ein Paket mit EasyList und
EasyPrivacy als statischen Rulesets. Diese werden unter der GPLv3+-Option der Doppellizenz weitergegeben (Namensnennung: „The EasyList
authors (https://easylist.to/)“, Quelle und Datum stehen in `rulesets/index.json` und in den Optionen). AdGuard-Listen (nur GPL-3.0) und
Bedrohungslisten werden nie mitgeliefert. Details: `docs/architecture/static-rulesets.md`.
Lizenzstand nach Websuche (2026-10-16); vor einem Release gegen Dateikopf und Repository-LICENSE der Anbieter prüfen:

| Liste | Quelle | Lizenz | Namensnennung |
|---|---|---|---|
| EasyList, EasyPrivacy | easylist.to | GPLv3+ **oder** CC BY-SA 3.0+ (wählbar) | The EasyList authors (https://easylist.to/) |
| AdGuard Base | AdguardTeam/AdguardFilters (filters.adtidy.org) | GPL-3.0 (laut Drittquellen, noch am Repository zu bestätigen) | AdGuard Software Ltd |

### Phishing- und Malware-Listen (Domain-Listen)

| Liste | Quelle | Lizenz / Bedingungen | Namensnennung |
|---|---|---|---|
| Malware – aktive Domains | malware-filter (urlhaus-filter) | Repository MIT und CC0; Originaldaten abuse.ch URLhaus unter „Fair Use“ (abuse.ch/terms-of-use), **nicht von uns geprüft** | malware-filter (Ming Di Leom); abuse.ch URLhaus |
| Phishing – Domains | malware-filter (phishing-filter) | **CC BY-SA 4.0** (Namensnennung, Weitergabe unter gleichen Bedingungen); Quellen OpenPhish (kostenlos laut deren Bedingungen), IPThreat (CC BY-SA 4.0), PhishTank | malware-filter; OpenPhish; IPThreat; PhishTank |
| Phishing – Phishing.Database | Phishing-Database/Phishing.Database | MIT | Mitchell Krog, Nissar Chababy, Phishing.Database Contributors |

Auch diese Listen werden nicht mitgeliefert, sondern nur auf Wunsch geladen. Vor einem Release gegen die Anbieterbedingungen prüfen.

Weitere Listen (uBlock filters, Peter Lowe’s u. a.) sind **nicht** eingebunden; ihre Lizenzen sind ungeprüft.

## Public Suffix List

`vendor/psl/public_suffix_list.dat` ist die unveränderte Public Suffix List (https://publicsuffix.org/), lizenziert unter der
**Mozilla Public License 2.0**; `src/core/domain-utils/psl-data.ts` wird daraus generiert. MPL-2.0 ist mit der GPL-3.0-or-later
des Projekts kompatibel (Abschnitt 3.3 der MPL). Quelltext der Liste: siehe `vendor/psl/`.

## Logo und Icons

`logo.png` und die daraus verkleinerten Erweiterungs-Icons (`public/icons/`) wurden vom Projektinhaber bereitgestellt.
Die Lizenz für das Logo ist **noch nicht festgelegt**; sie ist nicht automatisch durch die GPL-3.0-Quellcodelizenz abgedeckt.

## Entwicklungswerkzeuge

esbuild, TypeScript, web-ext (Mozilla) und `@types/firefox-webext-browser` werden nur beim Entwickeln benutzt und nicht in die
Erweiterung kopiert; ihre Lizenzen stehen im jeweiligen npm-Paket.
