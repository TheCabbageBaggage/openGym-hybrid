# openGym Hybrid (fork: TheCabbageBaggage/openGym-hybrid)

A thin, rebase-friendly **patch layer** on top of [DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym)
that adds **hybrid training**: strength planning + running planning in one coach, deconflicted.

## Why a patch layer and not a hard fork

Upstream moves fast (releases every ~2 weeks). A hard fork means merge hell. This repo therefore
keeps `main` a **clean mirror of upstream** and puts all extension work on the `hybrid` branch,
so `git rebase upstream/main` stays cheap and every upstream release (including the v1.4.0 SQLite
migration) reaches this deployment.

## What the hybrid layer adds

| Area | Detail |
|---|---|
| **Domain model** | New `S.run` namespace (threshold-pace zones, weeks, sessions, structures). The existing `cardio` mode is **never touched**. |
| **Run coach** | Runna-parity: 19 workout types (easy, long, tempo, threshold, cruise intervals, VO2max 800/1000, fartlek, hill repeats, strides, recovery, progression, race pace, time trial, taper, shakeout, cross-train, rest, race), ±10 % volume progression, deload every 4 weeks, taper. |
| **Deconfliction engine** | Deterministic rules between strength and running: ≥48 h between heavy leg day and long run, no intervals on heavy-leg days, leg-volume cap when ≥2 quality runs/week, synchronized deloads, weekly RPE load warning. |
| **Feedback loop** | Cross-discipline aggregates: `run.weekKm`, `run.paceTrend`, `run.compliance`, `run.zoneDistribution` (80/20), plus `run.legDayProximity`. One change-set can adjust strength **and** running. |
| **Garmin sync** | Auto-sync via `python-garminconnect` sidecar container (own auth mount, `garth` token cache, no credentials in `data/`). |
| **Coach provider** | Ollama runs natively through upstream's `compatible` (OpenAI-compatible) HTTP provider — no adapter code. |

## Docs

- `docs/hybrid/spec/PLAN.md` — comprehensive plan, phases 0–5 + phase G (Garmin)
- `docs/hybrid/adr/ADR-001-patch-layer-not-fork.md` — architecture decision
- `docs/hybrid/spec/FORK-SETUP.md` — branch model + rebase workflow
- `docs/hybrid/research/garmin-feasibility.md` — Garmin assessment
- `docs/hybrid/spec/PHASE-0-STATUS.md` — phase 0 status

## Branch model

```
upstream/main  ── a68a88d (v1.3.7) ──►  grows every ~2 weeks
      │
      └─ rebased ──►  origin/main   (clean upstream mirror)
                            │
                            └─ hybrid ──►  all hybrid extension work
```

## Rules

1. **Additive.** New files instead of modifying upstream ones. Unavoidable hooks get a `// HYBRID:` marker.
2. **Commit prefix `hybrid:`** on every own commit.
3. **New namespace `S.run`** — the `cardio` mode is off limits.
4. **No build.** Uses upstream images `ghcr.io/duartesantos8/opengym-api:latest` / `-web:latest`.
5. **Weekly rebase** with `npm test` as smoke test.

## Upstream

All credit for openGym goes to the upstream project. See `NOTICE.md` and `LICENSE`.
