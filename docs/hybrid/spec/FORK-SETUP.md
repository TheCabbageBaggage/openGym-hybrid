# Fork-Setup — `TheCabbageBaggage/openGym-hybrid`

**Datum:** 2026-09-14 · **Status:** ✅ angelegt

## Was existiert jetzt

| | |
|---|---|
| **origin (Fork)** | `https://github.com/TheCabbageBaggage/openGym-hybrid` — Fork von `DuarteSantos8/openGym`, default branch `main` |
| **upstream (Haupt-App)** | `https://github.com/DuarteSantos8/openGym` — die Quelle aller Updates |
| **Basis-Commit** | `a68a88d` (v1.3.7, 2026-09-12) — Fork ist **0/0** zu upstream/main, identisch |
| **Lokaler Klon** | `/tmp/openGym-hybrid` (Arbeitskopie für Rebase + Hybrid-Arbeit) |

## Branch-Modell

```
upstream/main      ── a68a88d (v1.3.7) ──► wächst alle ~2 Wochen
       │
       └─ rebased ──► origin/main (Fork, fast-forward, kein eigener Commit)
                              │
                              └─ hybrid ──► Hybrid-Arbeit (S.run, Laufcoach, Garmin G2)
```

**Regel:** `main` im Fork bleibt **sauber** (= Upstream-Spiegel), die Hybrid-Erweiterung lebt auf
`hybrid`. Damit ist `git rebase upstream/main` auf `hybrid` immer konfliktarm und `main` kann per
`git push origin upstream/main:main` fast-forwarded werden.

## Rebase-Workflow (wöchentlich)

```bash
cd /tmp/openGym-hybrid        # oder wo der Arbeitsklon liegt
git fetch upstream
git checkout hybrid
git rebase upstream/main      # Hybrid-Commits (hybrid:-Prefix) wandern ans Ende
npm test                      # CI-Smoke
git push --force-with-lease origin hybrid
# main spiegeln:
git push origin upstream/main:main
```

## Regeln (aus ADR-001)

1. **Additiv.** Neue Dateien statt Modifikation. Unvermeidbare Hooks bekommen `// HYBRID:`-Marker.
2. **Commit-Prefix `hybrid:`** für alle eigenen Commits → bei Rebase sofort unterscheidbar.
3. **Eigener Namespace `S.run`** — `cardio`-Modus wird nie angefasst.
4. **Kein Build.** Upstream liefert `ghcr.io/duartesantos8/opengym-api:latest` + `-web:latest`.
5. **Ollama = Config-Zeile** (`compatible`-Provider), kein Adapter-Code.

## Offen

- [ ] `hybrid`-Branch anlegen (erster Schritt Phase 1).
- [ ] GitHub Actions Rebase-Smoke-Workflow (Phase 5).
- [ ] Upstream-Release-Watch: v1.3.8 am 2026-09-27, v1.4.0 (SQLite) laut Roadmap.
