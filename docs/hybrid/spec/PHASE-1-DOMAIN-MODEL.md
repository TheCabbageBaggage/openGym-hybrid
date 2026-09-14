# Phase 1 — Domänenmodell „Running Session"

**Status:** spezifiziert, Implementierung offen · **Stand:** 2026-09-14
**Vorbedingung:** Phase 0 abgeschlossen (Fork `hybrid`-Branch, Test-Deploy live).
**Leitregel:** **Rein additiv.** Keine bestehende Datei wird umgeschrieben. Neue Dateien +
markierte Hooks (`// HYBRID:`).

---

## 1. Warum ein neuer Namespace statt `cardio`

Am Code verifiziert (Stand Upstream `a68a88d`):

| Stelle | Datei | Problem bei Erweiterung von `cardio` |
|---|---|---|
| Change-Typ `cardio` | `api/coach/core/validate.js` | `CHANGE_TYPES` ist laut Kommentar **„the actual security boundary"** — closed list, kein Default-Case. Erweitern ist ein bewusster Akt. |
| `needsEx`-Liste | `validate.js` | `cardio` verlangt `target.exId` → Lauf-Sessions brauchen eine **Übungs-ID**, die es nicht gibt |
| Payload | `validate.js` `case 'cardio'` | akzeptiert nur `{min, speed}`; Pace/Distanz/Struktur passen nicht, ohne den Case zu ändern |
| Policies | `validate.js` `POLICIES`, `POLICIES_FOR.cardio=['off']` | keine Progression für Läufe |
| Modi | `validate.js` `MODES = ['reps','time','cardio']` | Modus-Erweiterung berührt `modeOf()` + 20+ Call-Sites |
| Schemas | `api/coach/core/schemas.js` | `EX_SCHEMA` ist bewusst flach (llama.cpp-Grammatik) — `$ref`/`anyOf` verboten |

→ **Entscheidung:** Läufe leben in **`S.run`**, nicht in `S.routines`. Der `cardio`-Modus wird
**nie** angefasst. Das hält Änderungen auf *neue* Dateien plus *drei* additive Hook-Punkte begrenzt.

---

## 2. State-Schema `S.run`

```js
run: {
  // 1) Kalibrierung: woher kommen die Pace-Zonen
  calibration: {
    type: 'threshold30',        // threshold30 | racetime | manual
    d: '2026-09-15',
    done: false,
    result: null                // { distKm, avgPaceSec, avgHR, maxHR } nach Abschluss
  },

  // 2) Zonen: abgeleitet, nie handgepflegt
  zones: {
    unit: 'km',                 // km | mi
    thresholdPace: 300,         // s/km — DIE Referenzzahl
    hrMax: null,
    paceZones: {                // s/km Bereiche [from, to]
      recovery:  [375, 420],
      easy:      [345, 390],
      marathon:  [310, 330],
      threshold: [297, 308],
      interval:  [270, 295],
      repetition:[255, 275]
    }
  },

  // 3) Plan: Wochen → Sessions
  weeks: [
    {
      wk: 1,
      phase: 'base',            // base | build | peak | deload | taper | race
      km: 28,                   // geplantes Wochenvolumen
      sessions: [
        {
          id: 'r_1a2b3c',
          d: '2026-09-21',
          type: 'interval',     // s. §3
          structure: [          // leer bei einfachen Läufen
            { rep: 6, dist: 800, paceZone: 'interval', restSec: 90 }
          ],
          km: 8.4,
          targetPaceSec: 285,
          targetHR: null,
          notes: '',
          done: false,
          actual: null          // von Garmin befüllt (Phase G)
        }
      ]
    }
  ]
}
```

**Additiv angehängt** an das per-User-Dokument (`state-<uid>.json`) — die `_rev`-LWW-Sync
überträgt `S.run` als Teil des Dokuments, **ohne Änderung** an der Sync-Logik.

---

## 3. Die 19 Workout-Typen (`api/coach/run/types.js`)

| # | `type` | Struktur-Preset | Pace-Zone | Zweck |
|---|---|---|---|---|
| 1 | `easy` | — | easy | Grundlage, locker |
| 2 | `recovery` | — | recovery | nach Qualitätstag |
| 3 | `long` | — | easy (+ marathon-Steady am Ende) | Long Run |
| 4 | `tempo` | 1 Block | marathon→threshold | Laktatschwelle, anhaltend |
| 5 | `threshold` | 2–4 × 8–15 min | threshold | Schwellenläufe |
| 6 | `cruise` | 3–6 × 5–10 min, 60–90 s Pause | threshold | Cruise Intervals |
| 7 | `interval` | 4–10 × 400–1200 m | interval | VO2max, distanzbasiert |
| 8 | `interval-time` | 4–8 × 2–5 min | interval | VO2max, zeitbasiert |
| 9 | `fartlek` | frei, Zeitfenster | mixed | spielerisch |
| 10 | `hills` | 6–10 × 45–90 s bergauf | interval | Kraft/Speed |
| 11 | `strides` | 4–8 × 20–30 s | repetition | **Steigerungsläufe** |
| 12 | `progression` | 3 Stufen | easy→threshold | Endbeschleunigung |
| 13 | `race-pace` | 2–5 × Rennabschnitte | race | Rennsimulation |
| 14 | `time-trial` | 1 Block all-out | max | Test/Kalibrierung |
| 15 | `taper` | verkürzt | easy | Entlastung vor Rennen |
| 16 | `shakeout` | 10–20 min locker | recovery | Tag vor Rennen |
| 17 | `cross-train` | Rad/Schwimmen | — | alternativ, gelenkschonend |
| 18 | `rest` | — | — | Ruhetag (geplant, nicht passiv) |
| 19 | `race` | Renndistanz | race | Wettkampf |

`strides` (Steigerungsläufe) sind als eigener Typ geführt und werden von `easy`/`recovery` als
**Anhang** erlaubt (`structure` bleibt leer, `notes` trägt „+ 4×20 s Strides").

---

## 4. Pace-Zonen (`api/coach/run/zones.js`)

Ableitung rein aus `thresholdPace` (`T`), prozentual, deterministisch:

| Zone | Bereich | % von T |
|---|---|---|
| recovery | langsam | 125–140 % |
| easy | Grundlage | 115–130 % |
| marathon | M-Pace | 103–110 % |
| threshold | Schwellentempo | 99–103 % |
| interval | VO2max | 90–98 % |
| repetition | schnell | 85–92 % |

**Kalibrierung (`threshold30`):** 30 min maximal gleichmäßig → `thresholdPace = avgPace` der
letzten 20 min (bzw. Gesamtpace bei fehlenden Splits). Das ist **Linus' erster Lauf**.

**Tests:** `zones.js` ist pure function — jeder Zonenbereich wird als Fixture gepinnt
(`T=300` → `easy=[345,390]` usw.).

---

## 5. Volumen-Progression (`api/coach/run/volume.js`)

- **Aufbau:** +≤10 % Wochen-km, nie zwei Steigerungen in Folge über +8 %.
- **Deload:** jede 4. Woche −25…−40 % (Phase `deload`).
- **Taper:** letzte 2 Wochen vor `race` −20 % / −40 %, Long Run früher in der Woche.
- **Cap:** Wochen-km-Deckel aus `zones` + Kraft-Kontext (Phase 3 kann zusätzlich kappen).
- **80/20-Regel:** ≤20 % des Volumens in `interval`/`repetition`/`threshold` — Verstoß = Warnung.

---

## 6. Additive Hook-Punkte (die EINZIGEN Eingriffe in Bestands-Dateien)

| Datei | Hook | Umfang |
|---|---|---|
| `api/coach/core/validate.js` | `CHANGE_TYPES` um 6 `run-*`-Typen erweitern + neuer `case`-Block `// HYBRID: run-*` | ~60 Zeilen, kein Umbau |
| `api/coach/core/validate.js` | `validateRunChange()` als **neue, separat exportierte Funktion** | neue Datei `api/coach/run/validate-run.js`, von `validate.js` importiert |
| `api/coach/core/payload.js` | `S.run` in den Coach-Payload aufnehmen (`// HYBRID:`) | ~10 Zeilen |
| `api/coach/core/aggregates.js` | `run.*`-Kennzahlen ergänzen (`// HYBRID:`) | ~40 Zeilen, Phase 4 |
| `api/server.js` | Routen `/api/run/*` registrieren (`// HYBRID:`) | ~5 Zeilen |
| `frontend/src/views/` | `<Run>`-Route + Nav-Eintrag (`// HYBRID:`) | ~5 Zeilen |

Jeder Hook trägt den Marker `// HYBRID:` direkt über der Zeile → `git rebase` findet sie wieder.

---

## 7. Frontend-Module (neue Dateien)

```
frontend/src/lib/run/
  run-model.js     Mirror des Server-Schemas (Test-gepinnt gegen api/coach/run/model.js)
  run-zones.js     Zonen-Rechner (Mirror von zones.js)
  run-plan.js      Wochenplan-Builder + Struktur-Presets
  run-api.js       Client für /api/run/*
frontend/src/views/
  Run.jsx          Wochenübersicht (Card je Session, geplant vs. absolviert)
  RunWorkout.jsx   Intervall-Guide — nutzt die BESTEHENDE RestTimer-Komponente
```

**Tests:** `run-model.test.js` (Schema-Roundtrip), `run-zones.test.js` (Fixtures),
`run-plan.test.js` (Progression + 80/20).

---

## 8. Sync-Roundtrip — der kritische Test

`S.run` reist im selben Dokument wie `S.routines`. Zu prüfen:

1. `GET /api/data` → `S.run` vollständig vorhanden.
2. Schreiben mit `rev` auf Gerät A, Lesen auf Gerät B → `run` intakt.
3. LWW-Konflikt (A und B gleichzeitig) → **kein** Feld-Verlust in `run` über `merge`.
4. `run.calibration.done=true` + `zones` gesetzt → nach Roundtrip unverändert (Zonen werden
   nicht neu berechnet, wenn sie schon stehen).

**Exit-Kriterium Phase 1:**
- `npm test` grün (Bestand **und** neue Suites)
- `run-model.js ↔ model.js` Mirror-Test grün
- Sync-Roundtrip-Test grün
- Kein `cardio`-Modus-Call-Site berührt (`git diff --stat` zeigt nur neue Dateien + markierte Hooks)

---

## 9. Offene Punkte für Linus

1. **Einheit km (fix) oder umschaltbar?** Spec geht von `unit:'km'` mit Umschalter aus (Wien).
2. **Kalibrierung:** 30 min Schwellenpace wie beschlossen — als **Zeitlauf ohne Distanzvorgabe**
   (korrekt für Schwellenbestimmung), Ergebnis wird nachgetragen.
3. **Zonen-Prozente:** Vorschlag oben ist Pfitzner-nah. Falls du eine Runna-Referenz hast,
   die exakt passt, nehme ich die.
