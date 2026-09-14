# openGym Hybrid — Comprehensive Plan

**Projekt:** `projects/opengym-hybrid/` · **Status:** Phase 0 aktiv · **Datum:** 2026-09-14
**Ziel:** openGym um hybrides Training (Kraft + Laufen) erweitern, mit Runna-paritätigem Laufcoach
und automatischer Abstimmung beider Disziplinen — als **rebase-fähiger Patch-Layer auf Upstream**.

---

## 0. Beschlossene Rahmenbedingungen (Linus, 2026-09-14)

| # | Entscheidung |
|---|---|
| 1 | **Upstream `DuarteSantos8/openGym` ist die neue Basis.** `alexpcosta/opengym`-Fork wird nur noch Historie. |
| 2 | **Parallel-Deploy auf Subdomain** zum Testen (kein In-place-Migrieren von Prod). |
| 3 | **Erster Lauf = 30 min Schwellenpace-Test**, daraus werden die Pace-Zonen kalibriert. |
| 4 | **Garmin: ausschließlich G2** via `python-garminconnect` (kein G1-Manualimport, keine offizielle Health API). |
| 5 | **Rebase-Disziplin** (kein Rewrite), Updates der Haupt-App müssen ankommen. |
| 6 | **Fork:** `TheCabbageBaggage/openGym-hybrid` (Fork von `DuarteSantos8/openGym`), `upstream`-Remote für Rebase. |

- **Prod bleibt:** `gym.cabbagebaggage.net` (`/opt/opengym`, Traefik, Hostinger) — unangetastet.
- **Test-Deploy:** `hybrid.gym.cabbagebaggage.net` → `/opt/opengym-hybrid` auf Hostinger.
- **Repo:** https://github.com/TheCabbageBaggage/openGym-hybrid (`origin`) ← Fork von `DuarteSantos8/openGym` (`upstream`).

---

## 1. Ist-Zustand (Assessment-Kurzfassung)

**Fork-Tot:** `alexpcosta/opengym` @`678bf5b` steht auf Upstream-Stand ~v1.2.3 (Aug 2026),
Upstream ist bei **v1.3.7 (`a68a88d`, 2026-09-12)** = **349 Commits voraus**. Upstream hat inzwischen
Coach, Provider-System, Per-User-API-Keys, Coach-Chat mit Kontext, Combine-Routines, Merge-Sync.

**Dein ollama-Adapter ist obsolet:** Upstream hat `HTTP_PROVIDERS.compatible` (OpenAI-kompatibel,
optionaler Key) → Ollama via `http://ollama:11434/v1` ist eine **Config-Zeile**, kein Adapter.
Upstream `docker-compose.yml` zieht `ghcr.io/duartesantos8/opengym-api:latest` → **kein Build nötig**.

**Lauftraining existiert nicht.** `cardio` ist ein Krüppel-Modus: `POLICIES_FOR.cardio = ['off']`
(keine Progression), Set = `{min, speed}` (keine Pace/Distanz/Intervall), 29 Stub-Übungen,
`week` = 1 Routine pro Wochentag.

**Wichtig (v1.3.x):** `week` ist bereits **Array-fähig** (`week: Object.fromEntries(... [].concat(S.week[d]))`)
→ Kraft + Lauf am selben Tag ist im State-Modell schon vorgesehen. Kein Umbau nötig.

---

## 2. Architektur-Entscheidung

> **openGym-Hybrid ist ein Patch-Layer auf Upstream, kein Fork.**
> Neue Dateien + markierte Hooks (`// HYBRID:`), niemals Rewrite bestehender Module.

**Kern: neuer Namespace `S.run`** — nicht der `cardio`-Modus.

```js
run: {
  zones: { thresholdPace: 300, unit:'km', hrMax: null,
           paceZones: { easy:[345,390], threshold:[300,320], interval:[270,295] } },
  calibration: { type:'threshold30', d:'2026-09-15', done:false },
  weeks: [ { wk:1, phase:'base', km:28, sessions [
    { id, d:'2026-09-21', type:'interval',
      structure:[{rep:6, dist:800, paceZone:'interval', restSec:90}],
      km:8.4, targetPaceSec:285, done:false } ] } ]
}
```

**Warum:** `cardio` berührt 20+ Call-Sites (`modeOf`, `POLICIES_FOR`, `CHANGE_TYPES`, `validate.js`,
Stats, History, Workout-Sheets). Ein neuer Namespace ist **additiv**, rebase-sicher und lässt
alle Bestands-Läufe + den Kraft-Pfad unangetastet.

---

## 3. Phasen

### Phase 0 — Upstream-Basis + Parallel-Deploy ⏳ AKTIV
| | |
|---|---|
| M0.1 | Upstream `a68a88d` als Test-Instanz `/opt/opengym-hybrid` (eigenes `.env`, eigenes `data/`) |
| M0.2 | Traefik-Router `hybrid.gym.cabbagebaggage.net` + Cloudflare A-Record → 187.124.178.155 |
| M0.3 | Coach via `compatible`-Provider auf `http://ollama:11434/v1`, Modell `deepseek-v4-flash:cloud` |
| M0.4 | Datenübernahme: Kopie von `state-0caVxDyhutN1sacQ.json` (kein Reset) |
| M0.5 | ADR-001 schreiben: „Hybrid ist Patch-Layer, kein Fork" |
| **Exit** | `https://hybrid.gym.cabbagebaggage.net` erreichbar, Passkey-Login, Coach läuft, Prod unverändert |

### Phase 1 — Domänenmodell Running Session
```
api/coach/run/                     frontend/src/lib/run/
  model.js   Session-Schema          run-model.js   (Mirror, test-gepinnt)
  types.js   19 Workout-Typen        run-zones.js   Pace-Zonen
  zones.js   Pace-Zonen-Rechner      run-plan.js    Wochenplan-Builder
  volume.js  ±10 %-Progression       run-api.js
  interference.js  Kraft↔Lauf-Regeln
  prompts/run-create.md  run-review.md
```
**Exit:** `npm test` grün, `S.run` übersteht Sync-Roundtrip, Mirror-Test grün.

### Phase 2 — Laufcoach (Runna-Parität)
19 Workout-Typen: Easy, Long, Tempo, Threshold, Cruise Intervals, VO2max 800/1000, Fartlek,
Hill Repeats, **Strides**, Recovery, Progression, Race Pace, Time Trial, Taper, Shakeout,
Cross-Train, Rest, Race.
Pace-Zonen aus Schwellenpace (±10 % Volumen, Deload alle 4 Wo −25…−40 %, Taper).
Prompts `run-create.md`/`run-review.md` mit `S.run` + Kraft-Kontext.
Neue Change-Types: `run-add-session`, `run-remove-session`, `run-change-pace-zone`,
`run-change-volume`, `run-shift-day`, `run-change-structure`.
UI: `Run.jsx` (Wochen-Card), `RunWorkout.jsx` (Intervall-Guide, RestTimer wiederverwenden).
**Exit:** 3× Kraft + 2× Lauf (1 Long, 1 Intervall) aus Intake generierbar, applizier- und reverterbar.

### Phase 3 — Abstimmungs-Engine (Herzstück)
Deterministisch (`run/interference.js`), Ergebnis als Kontext an das LLM:

| Regel | Umsetzung |
|---|---|
| Schwerer Leg Day ↔ Long Run | **≥48 h**, Long Run nie am Folgetag |
| Intervall-Tag ↔ schweres Krafttraining | getrennte Tage, nie Beine am Intervall-Tag |
| Kraft-Beinvolumen bei ≥2 Qualitätsläufen/Wo | ×0,75 Cap |
| Easy Run am Krafttag | erlaubt (aktive Erholung), nach dem Heben |
| Deload-Woche | synchron: Kraft −40 % Vol, Lauf −25 % km |
| Race-Woche | Taper + Kraft reduziert |
| Wochen-Gesamtlast | RPE-Summe gegen 7-Tage-Fenster, Warnung >130 % Vorwoche |

**Exit:** Konflikt-Report in der Review-Ausgabe; kein Plan mit <48 h Leg-Day→Long-Run passiert den Validator.

### Phase 4 — Feedback-Loop über beide Disziplinen
`aggregates` erweitern: `run.weekKm[]`, `run.paceTrend`, `run.compliance`, `run.zoneDistribution`
(80/20-Check), Kreuz-Signal `run.legDayProximity[]`. Ein Change-Set darf Kraft **und** Lauf ändern.
**Exit:** Review erkennt „Intervalle 3× verfehlt + Bench stagniert + Long Run 20 h nach Leg Day" in einem Set.

### Phase G — Garmin Auto-Sync (G2, `python-garminconnect`) — nach Phase 3
**Entschieden: nur G2.** Kein G1-Manualimport, keine offizielle Health API.

| # | Meilenstein |
|---|---|
| G2.1 | Sidecar-Container `opengym-hybrid-garmin` (Python 3.12 + `garminconnect`), eigenes Compose-Service, Netz `ollama-xwy9_default`, **kein** Traefik-Route (intern) |
| G2.2 | Auth: `garminconnect.Garmin(email, pw)` → `garth`-Token-Cache nach `./garmin-auth/` (600, **außerhalb** `data/`). Credentials via `./garmin-auth/.env`, verschlüsselt mit App-`secret` (analog `coach.json`-`auth`) |
| G2.3 | `MFA`: Erst-Login interaktiv (`docker exec -it ... python auth.py`) → Token-Cache; danach non-interaktiv via `login/callback` oder garth-Token-Refresh. **2FA muss beim initialen Login einmal durchlaufen werden.** |
| G2.4 | Poller (Cron, alle 30 min): `get_activities_by_date(start, today, 'running')` → Normalisierung auf `S.run.sessions[].done` + `actualKm`, `actualPaceSec`, `avgHR`, `maxHR`, `splits[]` |
| G2.5 | Matching geplant ↔ absolviert: Datum + Typ-Heuristik (Distanz/Struktur), Konfidenz-Score; unmatched → „Activity Inbox" im UI |
| G2.6 | Write-Back über die bestehende Sync-API (`_rev`-LWW beachten — Sidecar muss `GET /api/data/rev` lesen und mit `rev` schreiben, sonst Overwrite-Konflikt) |
| **Exit** | 30-min-Schwellenpace-Lauf erscheint automatisch als absolvierte Session mit Pace/HR/Splits; `run.compliance` berechnet daraus. |

**Sicherheit (Hart):** Garmin-Credentials **niemals** in `data/` (Backup-Leak). Eigener Mount `./garmin-auth` (600), gitignored, nicht im Restic-`data/`-Scope.
**Risiko:** `python-garminconnect` ist reverse-engineered — bricht bei Garmin-API-Änderungen. Mitigation: Pin auf geprüfte Version, Health-Check im Poller, Fehler → `garmin_sync_failed` Flag statt Crash. Kein Ersatz für G1 nötig, da Linus G1 explizit verworfen hat.

### Phase 5 — Betrieb & Rebase-Disziplin
- Wöchentlich `git fetch upstream`, `git rebase upstream/main`, Änderungen mit `hybrid:`-Prefix.
- CI-Smoke: `git rebase upstream/main && npm test`.
- **M5.1 Migrations-Checkliste v1.4.0 (SQLite)** — `S.run` als JSON-Blob-Feld mitziehen. **Jetzt schreiben.**

---

## 4. Garmin-Integration

**Entschieden (Linus, 2026-09-14): ausschließlich G2 — `python-garminconnect`.**

| Weg | Status |
|---|---|
| G1 manueller `.fit`/`.tcx` Import | ❌ verworfen |
| **G2 `python-garminconnect` Sidecar** | ✅ **gewählt** |
| G3 offizielle Garmin Health API | ❌ verworfen (Partnervertrag, unrealistisch) |

Macherabarkeit: **hoch**. `python-garminconnect` (auf `garth`-Auth basierend) ist in der
Home-Assistant-/Quantified-Self-Community etabliert; Login per E-Mail/Passwort + einmaliger
2FA, danach persistierter Token-Cache. Architektur als isolierter Sidecar-Container, der
die bestehende openGym-Sync-API nutzt → **kein** Eingriff in API/Web-Container = stabilitätskonform.

Details + Meilensteine: §3 Phase G.

**Nutzen für den Plan:** Echte Splits + HR machen `run.compliance` und `run.paceTrend` erst
belastbar → die Review kann „Intervall verfehlt" von „Intervall geschafft" unterscheiden.

---

## 5. Risiken

| Risiko | Bewertung |
|---|---|
| Fork-Divergenz wächst weiter | **Hoch** → Phase 0 sofort |
| `cardio`-Modus anfassen | **Hoch** → neuer `S.run`-Namespace |
| v1.4.0 SQLite-Migration | Mittel → M5.1 |
| Laufperiodisierung auf `deepseek-v4-flash` | Mittel → `kimi-k2.6` für Create/Review testen |
| `python-garminconnect` bricht bei Garmin-Änderungen | Mittel → Version pinnen, Fehler-Flag statt Crash, Token-Cache |
| Garmin-2FA blockiert automatisierten Login | **Hoch zu Beginn** → einmaliger interaktiver Login, danach Token-Refresh |

---

## 6. Nächste Schritte

1. ~~Phase 0 Deploy abschließen (Subdomain live).~~ ✅
2. ~~Fork `TheCabbageBaggage/openGym-hybrid` anlegen.~~ ✅
3. ~~Garmin-Spec auf G2 festschreiben.~~ ✅
4. Spec Phase 1 (Modelle + Typen) schreiben + Branch `hybrid` anlegen.
5. Erst-Lauf 30 min Schwellenpace als Kalibrierungs-Workout eintragen (Phase 2).
