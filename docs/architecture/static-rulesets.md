# Statische Rulesets: Regelgrenzen und Lizenz

**Stand:** 2026-10-17, gemessen in Firefox 158 (Desktop, macOS, headless). Messsuite: `npm run test:firefox:static`.
Andere Versionen und Betriebssysteme sind nicht geprüft.

## Ergebnis in Kürze

- **Statische Rulesets sind in Firefox machbar** und umgehen die 5 000-Regel-Grenze für dynamische Regeln: ein eigener
  Pool von **30 000 Regeln** (`GUARANTEED_MINIMUM_STATIC_RULES`).
- EasyList + EasyPrivacy passen vollständig hinein (gemessen: **13 042 Regeln**, 25 Regex-Regeln), die dynamische Variante
  schafft nur ca. 3 600 von 13 000 (siehe `filter-lists.md`).
- Der Preis: ein statisches Ruleset ist ein **Schnappschuss**. Er ändert sich nur mit einer neuen Erweiterungsversion.
- Aktuell wird **keine Liste mitgeliefert**. Das Werkzeug dafür existiert (`npm run build:rulesets`), die Ausgabe liegt in
  `build/` (git-ignoriert). Die Laufzeitanbindung (Schalter, UI, Ausschluss gegenüber dynamischen Listen) ist noch nicht gebaut.

## Gemessene Grenzen (`declarativeNetRequest.MAX_*`, Firefox 158)

| Konstante | Wert |
|---|---|
| `GUARANTEED_MINIMUM_STATIC_RULES` | 30 000 |
| `MAX_NUMBER_OF_DYNAMIC_RULES` / `…_SESSION_RULES` / `…_AND_SESSION_RULES` | 5 000 |
| `MAX_NUMBER_OF_REGEX_RULES` | 1 000 (gemeinsam für statisch und dynamisch) |
| `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS` | 20 |
| `MAX_NUMBER_OF_STATIC_RULESETS` | 100 |
| `MAX_NUMBER_OF_DISABLED_STATIC_RULES` | 5 000 |

| Szenario | Aktivierung | Ergebnis |
|---|---|---|
| 5 000 Regeln | 60 ms | ok, erste/mittlere/letzte Regel greifen |
| 13 000 Regeln (Größe EasyList+EasyPrivacy) | 49 ms | ok |
| 30 000 Regeln | 105 ms | ok, `getAvailableStaticRuleCount()` = 0 |
| 31 000 / 60 000 / 100 000 Regeln | 107–330 ms | **Fehler** („exceeds GUARANTEED_MINIMUM_STATIC_RULES“); die Aktivierung scheitert ganz |
| 13 000 + 30 000 zusammen | 144 ms | Fehler, nichts wird teilweise aktiviert |
| 1 000 Regex-Regeln | 5 ms | ok |
| 1 001 Regex-Regeln | 6 ms | Fehler (`MAX_NUMBER_OF_REGEX_RULES`) |
| 30 000 statisch + 3 000 dynamisch | – | beide Mengen greifen; Installation der dynamischen Regeln 30 ms |

Weitere Befunde:

- Rulesets sind nach der Installation **nicht aktiv**, solange das Manifest `enabled: false` setzt.
- Die 30 000 Regeln verlangsamen die Navigation nicht messbar (Abweichung unter 80 ms gegenüber der Basislinie).
- Die Regex-Grenze gilt **über beide Pools**: Wer statisch 25 Regex-Regeln braucht, hat dynamisch weniger.
- Die Grenze ist hart. Ein Schnappschuss, der nicht passt, darf nicht abgeschnitten ausgeliefert werden; `buildBundle()` bricht
  deshalb mit Fehler ab, statt zu kürzen.

## Lizenzfrage

AnoFox steht unter **GPL-3.0-or-later**. Eine Liste darf nur mitgeliefert werden, wenn ihre Lizenz die Weitergabe in einem
solchen Paket erlaubt.

| Liste | Lizenz | Mitliefern? |
|---|---|---|
| EasyList | GPLv3+ **oder** CC BY-SA 3.0+ (Wahl des Empfängers) | **Ja**, unter der GPLv3+-Option, mit Quellen- und Urheberangabe („The EasyList authors“) |
| EasyPrivacy | wie EasyList | **Ja**, ebenso |
| AdGuard-Listen | GPL-3.0 **nur** (nicht „or later“) | **Nein**: nicht verträglich mit „or later“ als Gesamtlizenz, bleibt reiner Download |
| Phishing-/Malware-Listen (URLhaus via malware-filter, Phishing-Filter, Phishing.Database) | je Quelle unterschiedlich, teils nicht geklärt | **Nein**: ändern sich außerdem täglich, ein Schnappschuss wäre sicherheitsschädlich veraltet |

Pflichten bei Mitlieferung: Lizenztext und Quelle im Paket (`NOTICE`), Hinweis in der Oberfläche, Datum des Schnappschusses.
Das Bau-Skript schreibt Lizenz, Quelle, Prüfsumme und Abrufzeit je Liste in `index.json`. Dies ist keine Rechtsberatung; vor
einem echten Release sollte die Lizenzlage der dann aktuellen Listenköpfe erneut geprüft werden.

## Entwurf für die Laufzeit (noch nicht umgesetzt)

1. **Ausschluss:** Eine Liste ist entweder gebündelt (statisch) oder heruntergeladen (dynamisch), nie beides. Gleiche `id`
   (`easylist`, `easyprivacy`) erzwingt das.
2. **Veraltung:** UI zeigt Datum und Alter des Schnappschusses; wer Aktualität will, nutzt den dynamischen Download und
   akzeptiert die Teilabdeckung (oder kombiniert: statisch als Basis, dynamisch nur für Eigenes).
3. **Kosmetik:** Kosmetikfilter sind keine DNR-Regeln; sie werden separat (`cosmetic-<id>.json`, 2,3 MB für EasyList) geladen.
4. **Paketgröße:** gemessen ca. 3,6 MB Regeln + 2,3 MB Kosmetik, unkomprimiert.
5. **Modulschalter:** Adblock-Modul aus ⇒ `updateEnabledRulesets` deaktiviert; Pause pro Website bleibt über Allow-Regeln
   höherer Priorität wirksam (muss per E2E belegt werden, bevor es zugesagt wird).
6. **Manifest:** `declarative_net_request.rule_resources` darf nur vorhanden sein, wenn ein Bundle gebaut wurde.

## Werkzeuge

```bash
npm run build:rulesets          # lädt EasyList/EasyPrivacy, schreibt build/rulesets/ (git-ignoriert)
npm run test:firefox:static     # Messsuite (synthetische Rulesets, optional echte via STATIC_REAL_DIR)
```
