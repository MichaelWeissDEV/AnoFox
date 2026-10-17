# Phase 6: Löschreichweite von cookies / browsingData (gemessen) und Cookie-Vault-Design

Messung: `npm run test:firefox:storage` (headless **Firefox 158.0**; Origins `anofox-a.com`, `sub.anofox-a.com`, `anofox-b.org`, `anofox-t.net` (Tracker, in A und B eingebettet), per PAC-Proxy auf Port 80, `privacy.userContext.enabled`). Gesät: Cookies (Session/HttpOnly/persistent/SameSite/Domain-Cookie), localStorage, IndexedDB, Service Worker. Zustand wird vor/nach jeder Löschung aus den Seiten selbst und über die cookies-API gelesen.

## Gemessene Fakten
| Frage | Ergebnis |
|---|---|
| **Port-Falle** | Mit Nicht-Standardport (z. B. `:18780`) löschte `hostnames` **weder localStorage noch IndexedDB**; mit Port 80 funktioniert es. Cookies und Service Worker waren davon nicht betroffen. → Daten auf Dev-Servern/Nicht-Standardports werden nicht erfasst. |
| Cookies per `hostnames:[A]` | Entfernt Host-Cookies von A **und das Domain-Cookie `.A`** (dadurch verliert auch `sub.A` dieses Cookie). Host-only-Cookies von `sub.A` bleiben. `hostnames:[sub.A]` lässt Domain-Cookie und A unberührt. |
| localStorage / IndexedDB per `hostnames` | Genau der Origin-Host, getrennt voneinander, Subdomains unberührt. |
| Service Worker per `hostnames:[A]` | **Entfernt auch die Service Worker von `sub.A`** (Kollateralschaden, anders als Cookies/Storage). `hostnames:[sub.A]` lässt A unberührt. |
| Drittanbieter unter einer Website | `hostnames:[A]` löscht **nicht** localStorage/IndexedDB/Service Worker der unter A partitionierten Tracker-Origins. `hostnames:[Tracker]` löscht **alle** Partitionen des Trackers (A, B, unpartitioniert). Partitionierte **Cookies** unter A sind gezielt über `cookies.remove({partitionKey})` entfernbar, nur diese Partition. |
| cookies-API und Partitionen | `cookies.getAll({})` liefert **keine** partitionierten Cookies; `getAll({partitionKey:{}})` liefert alle (unpartitionierte mit `partitionKey` = null). `topLevelSite` ohne Port, z. B. `http://anofox-a.com`. `remove` braucht denselben `partitionKey`. |
| Container | `cookieStoreId` begrenzt Cookies-, localStorage- und IndexedDB-Entfernung auf diesen Container (Default-Container unberührt). **Mit `serviceWorkers` oder `cache` wirft Firefox** („does not support clearing … with 'cookieStoreId'“), ohne Löschung. |
| Optionen | `origins` wird nicht unterstützt (Schemafehler). `since` + localStorage wirft („does not support clearing localStorage with 'since'“) – **nachdem bereits andere Typen entfernt wurden** (Teilausführung, Service Worker waren weg). Unzulässige Kombinationen daher nie senden. |
| ohne `hostnames` | localStorage-Entfernung trifft alle Sites und Partitionen → nie verwenden. |
| CacheStorage | Kein `browsingData`-Typ entfernt CacheStorage (`cache` = HTTP-Cache; Service-Worker-Entfernung lässt CacheStorage stehen; global geprüft in einem früheren Lauf mit `*.localhost`). Nicht entfernbar. |
| `browsingData.settings()` | Standard-Typen: cache, cookies, history, formData, downloads. |
| sessionStorage | nicht gemessen (Lebensdauer an den Tab gebunden, Erweiterungen können sie nicht von außen leeren). |

## Design (umgesetzt)
- `src/protection/storage/model.ts`: Richtlinien `persistent` / `session` / `ephemeral` / `restricted`, Auflösung exakt > Elterndomain > Standard, öffentliche Suffixe nie als Eintrag. Standard aus der Stufe des Moduls „Cookies“: balanced löscht **nichts**, strict = `session`, lockdown = `ephemeral`.
- `cleaner.ts` (rein, API injiziert): Planer + Ausführung. Regeln: persistente Hosts nie anfassen; ein Container mit offenem Tab derselben registrierbaren Domain wird übersprungen (Cookies/Daten); Service Worker nur, wenn die Website in **keinem** Container offen ist und keine vertrauenswürdige Subdomain existiert (sonst Kollateral) – Hinweis in `limitations`; partitionierte Cookies der eigenen Partition werden entfernt, Cookies der Website in fremden Partitionen nicht; Cookies einzeln per API entfernt (kein Hostname-Streuverlust), Erfolg durch erneutes Lesen **verifiziert**; localStorage/IndexedDB/Service Worker bleiben „nicht überprüfbar“ und werden so gemeldet; Ergebnisse enthalten keine Cookie-Namen oder -Werte.
- `queue.ts`: persistente Bereinigungsabsichten (Nachfrist, Backoff 1/2/4… min, max. 5 Versuche, Entdoppelung, Abbruch bei erneutem Öffnen, Altersbereinigung).
- `browser/background/storage-service.ts`: Tabverfolgung in `storage.session` (Event-Page-fest), Absicht beim Schließen des letzten Tabs bzw. Wegnavigieren (nur `ephemeral`/`restricted`), `session`-Websites und Reste beim **Browserstart** (`runtime.onStartup`), minütlicher Alarm, „Jetzt bereinigen“, Ergebnisprotokoll (30 Einträge), Statusabfrage mit Cookie-Anzahl (inkl. partitioniert).
- Wichtig: Ein Beenden des Browsers garantiert keine abgeschlossene Löschung. Deshalb „Best Effort“: Absichten bleiben bestehen und laufen beim nächsten Start. Nur Websites, die **nach** Aktivierung der Richtlinie besucht wurden, sind vorgemerkt; ein Profilwechsel löscht nie rückwirkend Unbekanntes.
- `restricted` ist als Wert zulässig, aber **nicht zuverlässig umsetzbar** (localStorage/IndexedDB lassen sich per Erweiterung nicht blockieren) und wird wie `ephemeral` behandelt; die UI sagt das.

## Offen
- End-to-End mit der gebauten Erweiterung (Tab schließen → Nachfrist → Löschung; Neustart-Szenario) in echtem Firefox; der Dienst ist nur über die Planer-Unit-Tests und die Reichweitenmessung abgesichert.
- Trusted-Allowlist mit Container-Bindung, Wildcard-Verwaltung in der UI, Drittanbieter-Sweep, Datenalter-Auslöser, SSO-Abhängigkeiten (Anmelden bei einem Anbieter, dessen Cookie unter einer anderen Domain liegt).
- Windows/Linux, andere Firefox-Versionen; sessionStorage-Verhalten.
