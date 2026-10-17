# Hinweise zu Drittinhalten

AnoFox selbst steht unter **GPL-3.0-or-later** (siehe `LICENSE`).

## Filterlisten (Daten Dritter, nicht Teil dieses Repositories)

AnoFox liefert **keine** Filterlisten mit. Sie werden nur auf ausdrücklichen Wunsch zur Laufzeit von den Anbietern geladen.
Lizenzstand nach Websuche (2026-10-16); vor einem Release gegen Dateikopf und Repository-LICENSE der Anbieter prüfen:

| Liste | Quelle | Lizenz | Namensnennung |
|---|---|---|---|
| EasyList, EasyPrivacy | easylist.to | GPLv3+ **oder** CC BY-SA 3.0+ (wählbar) | The EasyList authors (https://easylist.to/) |
| AdGuard Base | AdguardTeam/AdguardFilters (filters.adtidy.org) | GPL-3.0 (laut Drittquellen, noch am Repository zu bestätigen) | AdGuard Software Ltd |

Weitere Listen (uBlock filters, Peter Lowe’s, URLhaus u. a.) sind **nicht** eingebunden; ihre Lizenzen sind ungeprüft.

## Public Suffix List

Die Domänenlogik enthält eine **kleine Übergangsliste** mehrteiliger Suffixe (`src/core/domain-utils/domains.ts`), nicht die
Public Suffix List. Die Einbindung der PSL (MPL-2.0) steht auf der Roadmap.

## Logo und Icons

`logo.png` und die daraus verkleinerten Erweiterungs-Icons (`public/icons/`) wurden vom Projektinhaber bereitgestellt.
Die Lizenz für das Logo ist **noch nicht festgelegt**; sie ist nicht automatisch durch die GPL-3.0-Quellcodelizenz abgedeckt.

## Entwicklungswerkzeuge

esbuild, TypeScript, web-ext (Mozilla) und `@types/firefox-webext-browser` werden nur beim Entwickeln benutzt und nicht in die
Erweiterung kopiert; ihre Lizenzen stehen im jeweiligen npm-Paket.
