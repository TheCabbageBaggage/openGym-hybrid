# openGym Hybrid — Status

**Stand: 2026-09-15**

## Repositories & Deploy

| | |
|---|---|
| Fork | `TheCabbageBaggage/openGym-hybrid` |
| Base | `DuarteSantos8/openGym@main` (a68a88d, v1.3.7) |
| Working branch | `hybrid` @ `1ffe1dc` |
| Test deploy | `hybrid.gym.cabbagebaggage.net` → HTTP 200, `/opt/opengym-hybrid` (Traefik **file provider**, ADR-003) |
| Prod (unangetastet) | `gym.cabbagebaggage.net` → HTTP 200 |
| Coach | `compatible` provider → `http://ollama:11434/v1` / `deepseek-v4-flash:cloud` |

## Decisions (Linus)

1. Upstream `main` as base, fork `alexpcosta/opengym` discarded (349 commits behind, ollama adapter obsolete)
2. Parallel test deploy on subdomain, prod untouched
3. First run = 30 min threshold-pace test as calibration
4. Threshold: **5:03/km = 303 s/km @ 162 bpm**
5. Intervals: **time AND distance**, switchable (`interval` vs `interval-time`)
6. Interference rules: **blocking**, not warning
7. Leg day = **≥50 % of working sets** on quads/hamstrings/glutes/calves/legs
8. Garmin: **G2 only** (`python-garminconnect` sidecar), after Phase 3
9. Zones: Pfitzner-near percentages
10. Unit: **km default, miles switchable**
11. Historical data used for testing (state `0caVxDyhutN1sacQ`, 16 routines)
12. Calibration: **threshold 5:03/km @ 162 bpm confirmed by Linus** ("Kalibrierung passt")
13. Garmin credentials: **env var for bootstrap + refresh token persisted**. Token must NOT be lost — 3-copy persistence (ADR-002).

## Phase status

| Phase | Scope | Status |
|---|---|---|
| P0 | Consolidation, upstream base, test deploy | ✅ done, verified |
| P1 | `S.run` domain model, 19 workout types, pace zones | ✅ done |
| P2 | Run coach (prompts, 6 change types, payload, aggregates) | ✅ backend done |
| P2b | Frontend `views/Run.jsx`, `RunWorkout.jsx`, client expander (`run-expand.js`) | ✅ done, deployed |
| P3 | Interference engine (blocking, 50 % threshold) | ✅ done |
| P4 | Feedback loop over both disciplines | ✅ done, deployed, verified live |
| P5 | Rebase discipline, CI rebase smoke test | ⬜ open |
| G | Garmin G2 sidecar | 🟡 ADR done, credential store built |
| — | **Backup chain fix** (unplanned, found during Phase G prep) | ✅ done, verified |

## ⚠️ Backup chain failure found & fixed (2026-09-15)

**The nightly restic backup had been failing silently for ~4 weeks** (19.08. – 15.09.2026).
Found while setting up Phase G credential persistence — not by any monitor, because there was
none watching the outcome.

- **Cause:** `backup-container` held a stale sshfs handle after the Storage-Box was remounted on
  the host on 24.08. Every run logged `transport endpoint is not connected` into a log nobody read.
- **Fix 1:** container restarted; mount live again; backup run manually → fresh snapshot
  (`4a09bf12`, 2026-09-15). Repo `check --read-data-subset=2%` → no errors.
- **Fix 2:** mount pre-flight added to the container's `backup.sh` (fails loudly if `keys/`
  is unreadable). Backup of the original: `backup.sh.bak-20260915`.
- **Fix 3:** `scripts/storagebox/backup_watchdog.sh` — runs on the **host**, checks the *outcome*
  (container running, mount readable inside container, newest snapshot <30 h, last run error-free),
  auto-restarts the container once, exits 2 on failure.
- **Fix 4:** `scripts/storagebox/backup_watchdog_cron.sh` + `scripts/email/send_backup_alert.py`
  — silent on success, HTML email to Linus on failure. Cron `0 */6 * * *` on the host.
- **Verified:** watchdog fails loudly when the container is stopped (exit 2), recovers when healthy
  (exit 0); alert email delivered (message id `1a0a60cf1edde6be`).

## Test state

- API suite: `npm test` → **245 pass, 0 fail** (was 231; +14 run-feedback/interference tests)
- Frontend suite: **1631 pass, 0 fail**

## Critical bug found & fixed in Phase 4 (2026-09-15)

The whole hybrid feature was a silent no-op, found by writing the Phase 4 tests:

1. **`LEG_GROUPS` used invented body-part names** (`'quads'`, `'hamstrings'`, `'glutes'`,
   `'calves'`, `'legs'`) that appear nowhere in the exercise library, which ships
   `"upper legs"` / `"lower legs"`. `isLegDay` returned false for an obvious squat routine,
   so the blocking interference rules Linus asked for **blocked nothing**. Fixed in
   `interference.js` + client mirror `run-interference.js` + `payload.js`.
2. **`legDayProximity` never fired**: the detector returned weekday numbers but the comparison
   fed them to a date-differencing helper → `NaN < 2` = always false. Rewrote as
   `nearestLegDayGap` over the weekly pattern.

Both are now pinned against the shipped library (`run-interference.test.js` imports the real
`LIBRARY` and asserts the names match) so the mismatch cannot silently return.

New Phase 4 surface in `aggregates.run`: `legDayProximity` (working), `legVolumeConflicts`
(x0.75 cap at ≥2 quality runs/week), `legDayWeekdays`. `hybrid.md` prompt now tells the model
how to read these and to propose strength + running changes in one set.

**Verified live** on the test instance: with a leg-heavy Monday routine + Tuesday long run,
the payload reports `legDayProximity: [{d:"2026-09-22",type:"long",daysFromLegDay:1}]`.

## Traefik file provider for the test subdomain (ADR-003)

After every rebuild the hybrid subdomain returned **404**: the container served 200 on :8091, but
Traefik never created the `opengymhybrid` router. Labels were byte-identical to the working prod
container; multiple restarts in correct order did not help. Cause: a race between the Docker event
stream and the Traefik restart on recreate — the provider loses the new container's `create` event.

**Fix:** router + service moved to the Traefik **file provider**
(`/docker/traefik/dynamic.yml`, backup `.bak-20260915-190212`). Event-free, hot-reloads, no restart
needed (HTTPS 200 / HTTP 301 immediately). Prod keeps its labels, untouched.

Verified: `hybrid.gym…` HTTPS 200 (Let's Encrypt, CN=hybrid.gym…), HTTP 301, `/api/health` 200,
`gym…` (prod) still 200.

## Live state seeded (2026-09-15)

Linus's state (`/data/state-0caVxDyhutN1sacQ.json`, backup `.bak-20260915-190437`) now carries the
`run` namespace:

```
calibration: { source: manual, thresholdPace: 303, thresholdHR: 162, done: false, date: null }
zones:       { thresholdPace: 303, thresholdHR: 162, unit: km, hrMax: null, paceZones: {...8 zones} }
weeks:       []
```

Derived zones (km): recovery 6:19–7:04, easy 5:48–6:34, marathon 5:12–5:33,
threshold 5:00–5:12, interval 4:33–4:57, repetition 4:18–4:39, race 4:48–5:06, max 4:48–5:03.
Miles display verified (threshold 8:03–8:22/mi). Workouts (144) and profile untouched.

**Calibration is entered by hand, not run** — `done: false`, no splits. As soon as Linus runs the
30-min test, splits go in and the zones come from measured data.

## Module map (all new files, `api/coach/run/`)

| File | Contents |
|---|---|
| `model.js` | `S.run` schema, `cleanRun`, `validateRun`, `strengthOn`, `daysBetween` |
| `vocab.js` | 19 workout types, structure presets, zone vocabulary |
| `zones.js` | Pace zones from threshold pace, `[fast, slow]` order |
| `plan.js` | Week builder: volume progression, deload, taper, 80/20 |
| `validate-run.js` | The 6 `run-*` change types |
| `interference.js` | Leg-day detection, 48 h rules, leg-volume cap, proximity report |

## Garmin credential persistence (`projects/opengym-hybrid/garmin/`)

| File | Purpose |
|---|---|
| `durable_token_store.py` | Atomic + 3-copy token persistence. 14/14 self-tests pass. |

Design in `adr/ADR-002-garmin-credentials.md`. Key points: env password is **bootstrap-only**;
refresh token is persisted atomically (`temp + os.replace`) with a Storage-Box mirror; no silent
fallback to password login; failure is loud. Verified against the real Storage-Box
(`/mnt/storagebox/secure/tokens/`).

**This module is generic** — any credential whose loss is not trivially recoverable should use it,
not just Garmin. That addresses the recurring "you lose things often" pattern structurally.

## Hook points in existing files (all `// HYBRID:` marked)

- `coach/core/validate.js` — `CHANGE_TYPES` extended, run changes dispatched
- `coach/core/payload.js` — `run` key + `aggregates.run`
- `coach/core/prompt.js` — `hybrid.md` gated on `run` presence
- `coach/core/prompts.js` — asset wiring
- `coach/prompts/create.md` — `runPlan` output
- `coach/prompts/review.md` — `runChanges` output

## Operational gotchas (Hostinger)

1. **Hybrid subdomain uses the Traefik file provider** (`/docker/traefik/dynamic.yml`) — additive
   edits only; `acta` and the `authentik` middleware live in the same file. Prod uses Docker labels.
   A changed compose project name breaks the service entry (`opengym-hybrid-web-1`).
2. Compose project name must differ from prod `opengym` (`name:` in override)
3. `docker/` has no npm on the host — build via `docker compose build`, test in `/tmp` checkout
4. `data/` holds `secret` (WebAuthn), `state-*.json`, `coach.json` — copy before migration
5. Health check interval is 5 min → "health: starting" for ~5 min after recreate is normal
6. The web image builds the frontend from source; `api/coach/run/` must stay in the build context
   (Dockerfile HYBRID line) or the client parity import breaks the build

## Next

**P5 — rebase discipline + CI smoke test**, then **Phase G — Garmin G2 sidecar** (ADR-002 and
the durable token store are ready; the sidecar itself is next). P4 (feedback loop) is done.
