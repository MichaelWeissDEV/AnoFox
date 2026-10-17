# Filterlisten: Lizenz, Quellen, Syntax (Phase 3)

Stand 2026-10-16. Lizenzangaben stammen aus Websuche; **vor jeder Bündelung/Aktivierung im Release gegen die Originaldatei-Header und das Repository-LICENSE prüfen.**

## Lizenzen
| Liste | Quelle | Lizenz | Anmerkung |
|---|---|---|---|
| EasyList, EasyPrivacy (+ EasyList Germany/Italy) | easylist.to | GPLv3+ **oder** CC BY-SA 3.0+ (wählbar), Namensnennung „The EasyList authors (https://easylist.to/)“ | Bestätigt auf der [EasyList-Lizenzseite](https://easylist.to/pages/licence.html). Extern gehostete Zusatzdateien können andere Bedingungen haben. |
| AdGuard-Filter | AdguardTeam/AdguardFilters | GPL-3.0 | Nur aus Drittverzeichnissen bestätigt → am Repository prüfen. |
| URLhaus-Malware-Filter | abuse.ch URLhaus / curbengh | Sammelliste deklariert CC0 | Upstream-Bedingungen von abuse.ch separat prüfen (nicht bestätigt). |
| Peter Lowe's list, uBlock filters, weitere | – | **ungeprüft** | Nicht integrieren, bevor geprüft. |

**Offene Entscheidung (Projektinhaber):** Das Projekt hat keine `LICENSE`-Datei. Bündelt man GPL-Listen in ein verteiltes Paket (oder die CC-BY-SA-Variante), muss die AnoFox-Lizenz dazu passen bzw. die Liste wird nur zur Laufzeit geladen (nicht gebündelt). Empfehlung: Listen **nicht bündeln**, sondern vom Nutzer aktivieren lassen und zur Laufzeit herunterladen; AnoFox-Lizenz explizit festlegen.

## Firefox-Limits (Quelle: MDN, Suche)
- `MAX_NUMBER_OF_DYNAMIC_RULES`: laut MDN-Tabelle nicht eindeutig (5000 vs. 30000). **Der Compiler nimmt `maxRules` als Parameter, der Wert wird zur Laufzeit aus der API gelesen, nie angenommen.**
- Bis Firefox 127 teilten sich dynamische und Session-Regeln ein Kontingent von 5000; ab 128 getrennt.
- Bekannter Bug (Firefox ≤ 132, Bugzilla 1921353): dynamische Regeln können nach Neustart nicht angewendet werden; Workaround über aktivierte statische Rulesets. Relevant für `strict_min_version` und die Update-Strategie (Phase 3.4).
- Nicht bestätigt: Details zu „unsafe rules“, Regex-Speicherlimits → `isRegexSupported` pro Regex zur Laufzeit.

## Unterstützte Syntax (Parser `src/protection/adblock/parser.ts`)
| Konstrukt | Status | Abbildung |
|---|---|---|
| `\|\|host^`, `\|`, `*`, `^`, Substring | ✔ | DNR `urlFilter` 1:1 |
| `/regex/` (RE2-kompatibel) | ✔, Lookaround/Backreferences ✘ | `regexFilter`, zusätzlich `isRegexSupported` |
| `@@` Ausnahmen | ✔ | `allow` (gleiche Priorität wie Block, Allow gewinnt) |
| Typen (`script,image,stylesheet,font,media,xhr,subdocument,ping,websocket,object,other,document`) + `~` | ✔ | `resourceTypes` / `excludedResourceTypes` |
| `third-party`, `1p`, `3p`, `~…` | ✔ | `domainType` |
| `domain=a.com\|~b.com` | ✔ | `initiatorDomains` / `excludedInitiatorDomains` (Initiator ≠ Hauptseite bei Frames) |
| `match-case` | ✔ | `isUrlFilterCaseSensitive` |
| `important` | ✔ | Priorität 2 |
| `@@…$document` | ✔ | `allowAllRequests`, Priorität 3 |
| `badfilter` | ✔ | im Compiler |
| Hosts-Dateien, reine Domainlisten | ✔ (explizites Format) | `\|\|host^` |
| `redirect=`, `redirect-rule` | ✘ `option:redirect` | bräuchte gebündelte Ersatzressourcen + `web_accessible_resources` |
| `removeparam=` | ✘ `option:removeparam` | URL-Cleaner deckt Tracking-Parameter ab; Schleifenrisiko |
| `csp=`, `header=`, `replace=`, `method=`, `to=`, `from=`, `denyallow=`, `popup`, `cname`, `elemhide`/`generichide` | ✘ eigene Gründe | nicht oder nicht äquivalent abbildbar |
| `domain=` mit Entity (`google.*`) oder Regex | ✘ `domain:entity` / `domain:regex` | |
| Nicht-ASCII-Muster | ✘ `pattern:non-ascii` | Punycode-Konvertierung später |
| Kosmetisch `##sel`, `#@#sel`, domainbezogen | geparst (`cosmetic`), noch **nicht** angewendet | eigene CSS-Engine (nächster Schritt) |
| Scriptlets `##+js`, `#%#` | ✘ `scriptlet` | bewusst nie ausgeführt (kein Code aus Listen) |
| Prozedurale Filter (`:has-text`, `:xpath`, `#?#`, …), HTML-Filter `##^` | ✘ | |

Kein Code aus Listen wird ausgeführt; Listen sind reine Daten, unbekannte Optionen führen zu `option:unknown` statt zu einer geratenen Übersetzung.

## Compiler (`compile-dnr.ts`)
- Dedupe, `$badfilter`, Merge von `||host^`-Filtern mit gleichen Optionen zu **einer** Regel mit `requestDomains` (Test belegt Äquivalenz zur Einzelregel-Variante in einem DNR-Modell).
- Prioritäten 1–3 liegen unter allen Policy-Bändern (≥ 20), Listenregeln können Policy-/Embed-Blocks also nie aufheben.
- Quota: bei Überschreitung werden Blocks vor Ausnahmen verworfen; das Ergebnis ist als `partial` markiert und muss in der UI sichtbar sein.

## Messung an echten Listen (2026-10-16, lokal, Parser+Compiler)
| Liste | Netzwerkfilter | Kosmetisch | Nicht unterstützt | DNR-Regeln nach Merge | Parse+Compile |
|---|---|---|---|---|---|
| EasyList | 55 073 | 23 813 | 4 017 (vor allem `$popup` 2 969, prozedural 574, `generichide` 169, Entity-Domains 295) | 3 850 | ~100 ms |
| EasyPrivacy | 56 269 | 2 | 72 (`redirect` 30, Scriptlets 30) | 9 191 | ~70 ms |

Folge: Bei einem Kontingent von 5 000 dynamischen Regeln passt EasyList knapp, EasyPrivacy nicht. Der Manager liest das echte Limit zur Laufzeit, zieht 1 000 Reserve für Policy-Regeln ab und kennzeichnet abgeschnittene Listen als `partial`. Für vollständige Abdeckung braucht es statische Rulesets (Build-Zeit-Kompilierung; Lizenzfrage siehe oben) oder ein größeres Limit – **in echtem Firefox prüfen**.

## Updater & Manager (umgesetzt, nur gegen Fakes getestet)
- Allowlist der Quellen (`sources.ts`), nur HTTPS, Host nach Redirect erneut geprüft, keine Credentials/Ports.
- Request: `credentials: omit`, `referrerPolicy: no-referrer`, nur `Accept` + bedingte Header (`If-None-Match`, `If-Modified-Since`); keine URLs/Daten des Nutzers. Der Anbieter sieht naturgemäß die IP.
- Timeout 30 s, gestreamtes Größenlimit pro Quelle, Content-Type- und UTF-8-Prüfung, HTML/JSON-Erkennung, Plausibilität (Mindestanzahl, Schrumpfschutz 50 %).
- Integrität: HTTPS + SHA-256 zur Änderungserkennung. Listen sind nicht signiert, das ist **keine** Authentizitätsprüfung.
- Intervall 6 h – 30 Tage (Standard 4 Tage), manuelles Update mit 5-min-Cooldown, Prüf-Alarm stündlich (nur wenn fällig).
- Transaktion: stagen → kompilieren → `updateDynamicRules` → erst dann speichern; bei Fehler Rollback auf die vorherige Version.
- Listenregeln: IDs 100 000–199 999, vom Policy-Sync nie angefasst. Zurücksetzen der Einstellungen schaltet Listen vorher ab.
- Prioritätsband 1–3, unter allen Policy-Bändern.

## Echter Download und Quota (Firefox 158, 2026-10-17)
Geprüft mit `npm run test:e2e:download` (siehe `permissions.md`): Download, Validierung und Installation gegen die echten Anbieter funktionieren; EasyList + EasyPrivacy ergeben zusammen 111 624 Filter, von denen 3 643 Regeln ins Kontingent passen (9 382 Filter abgeschnitten, als „partial“ gemeldet).

## Noch offen in Phase 3
1. Echte Firefox-Prüfung (Regex-Support, Kontingente, Prioritäten, Verhalten von `allowAllRequests`) – Harness T-1. Bis dahin ist das Modul „experimentell“.
2. Statische Rulesets für große Listen; Firefox-Bug 1921353 (dynamische Regeln nach Neustart).
3. Kosmetik-Engine: siehe unten; in echtem Firefox noch ungeprüft (`scripting.insertCSS` mit `origin: USER`, `all_frames`).
5. Parallelbetrieb mit uBlock Origin (3.5): Statistik nie als „von AnoFox verhindert“ behaupten, solange nicht belegbar.

## Kosmetik-Engine (`cosmetic.ts`, `content-cosmetic.ts`)
- Nur einfache CSS-Selektoren (Parser lehnt Scriptlets, prozedurale/erweiterte Syntax, `:style()`, HTML-Filter ab). Zusätzlich `isSafeSelector`: kein `{ } ; < @`, keine Kommentare/Steuerzeichen, ausgewogene Klammern/Anführungszeichen, ≤ 1000 Zeichen. Einzige Deklaration: `display:none !important`.
- **Eine CSS-Regel pro Selektor** (jeweils eigene Zeile): ein ungültiger Selektor verwirft nur sich selbst (im Browser geprüft: nachfolgende Regeln greifen weiter).
- Domainspezifische Filter werden beim Dokumentstart injiziert; generische nur, wenn ihr Pflicht-Token (Klasse/ID außerhalb von `:not()`, Attributen, Strings) auf der Seite vorkommt. Der Content Script sendet dafür ausschließlich Klassen-/ID-Namen (gedrosselt, dedupliziert, max. 20 000 pro Dokument) an den eigenen Background.
- Injektion durch den Background via `scripting.insertCSS` (`origin: USER`, pro Frame) – unabhängig von der Seiten-CSP.
- Ausnahmen: `#@#` (Domain oder global), `~domain`-Ausschlüsse, pro Website „Werbeblocker pausieren“ (Policy-Regel Modul `adblock`: Kosmetik aus **und** Netzwerk per `allowAllRequests`, Priorität 5; der URL-Cleaner läuft weiter, daher Cleaner-Priorität 6).
- Messung EasyList: 13 626 generische (13 201 per Token, 425 immer), 9 846 domainspezifische, 337 Ausnahmen, Index in ~15 ms, ca. 25 KB CSS pro Seite für die „immer“-Gruppe.
- Grenzen: Flackern vor der Injektion möglich (Nachrichtenrundlauf); Klassennamenvergleich ist case-insensitiv (Obermenge, kann in Standards-Modus minimal zu viel verstecken); Selektoren, die der Browser nicht versteht, wirken nicht; keine Überwachung versteckter Elemente/Statistik.
