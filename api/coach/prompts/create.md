# Task: build a weekly training plan

Design a complete plan from `coachProfile` (their intake answers) and, if present, `history` (what they have already been lifting).

## Constraints

- Schedule exactly `coachProfile.daysPerWeek` training days. Use `preferredDays` when given (0 = Sunday … 6 = Saturday).
- Fit `coachProfile.sessionMin` minutes: roughly 2–3 minutes per straight set including rest; supersets (`sg`) buy time back when the session is tight.
- Only exercises from `library`. Respect `equipment`, `limitations`, and `dislikes` — a plan someone will not do is a plan that failed.
- If `history.workingWeights` is present, any starting `weight` you set must be at or below what they have already handled for that exercise. For anything they have not trained, omit `weight` entirely — the app's first session sets the baseline.
- 1–7 routines, each 3–12 exercises, compound work before accessories.

## If they run (`coachProfile.running` is present)

This person trains for strength **and** runs. Two things change.

**The strength week is built around the running week.** A long run needs legs that are not repairing from a heavy leg session, so put at least 48 hours between a leg day and the long run, and keep intervals away from squats and deadlifts entirely. If the week cannot hold both, it is the strength volume on the leg day that gives, not the running.

**Answer with a running plan as well.** A `runPlan` object carries the running week, and it is the other half of the prescription:

```
{
  "coach_contract": 1,
  ...strength plan as usual...,
  "runPlan": {
    "startDate": "<ISO date, the Sunday the first week begins>",
    "weeks": 8,
    "unit": "km",
    "calibration": true,
    "slots": [
      { "weekday": 2, "type": "interval" },
      { "weekday": 4, "type": "easy" },
      { "weekday": 0, "type": "long" }
    ],
    "volumeStart": 30,
    "race": null,
    "why": "<1-3 sentences: the shape of the running week and how it sits around the lifting days>"
  }
}
```

- `slots` is the running week: one entry per running day, `weekday` 0 = Sunday. Use the workout types from the running rules you were given (`easy`, `interval`, `long`, `tempo`, `threshold`, `strides`, …). A weekday with no slot is a lifting day or a rest day, and that is fine.
- **`calibration: true` puts a 30-minute threshold test in the first week.** Set it whenever `run.thresholdPace` is null or `run.calibration.done` is false — without it there are no zones and the whole plan is provisional. Put it on a day with no leg work, and at least 48 hours from the long run.
- `volumeStart` is the first week's kilometres. Be conservative: a runner who runs three times a week and lifts three times a week is not a runner who can hold forty kilometres. When `run` is present with a history, start from what they have actually been running, not from what would be nice.
- `weeks` is the block length; 8–12 is a training block, 4 is a maintenance patch. `race` is `{ "d": "<ISO date>", "distanceKm": <number>, "name": "<optional>" }` or `null`; when it is set the app tapers into it.
- `unit` is `km` or `mi`, whatever this person reads. Everything in the payload stays in kilometres either way.

The app expands `runPlan` into individual sessions with paced repetitions and a weekly volume progression, then checks it against the lifting week for the interference rules. Your job is the shape; the arithmetic is the app's.

**A week without `runPlan` is a strength-only week.** If they run and you forget `runPlan`, they get a lifting plan that ignores half their training — worse than no running plan, because it looks complete.

## Output

```
{
  "coach_contract": 1,
  "opengym_plan": 1,
  "name": "<short plan name>",
  "summary": "<2-4 sentences: the shape of the plan and why it fits what they asked for>",
  "basedOn": "<what you used — e.g. 'your last 12 weeks' or 'no history yet'>",
  "week": { "1": "r1", "3": "r2", "5": "r3" },
  "routines": [
    {
      "id": "r1",
      "name": "<routine name>",
      "emoji": "<one emoji>",
      "prog": "linear",
      "why": "<1-2 sentences: what this day is for, and where the running sits around it>",
      "ex": [
        {
          "id": "<library id>",
          "sets": 3,
          "mode": "reps",
          "reps": 8,
          "prog": "linear",
          "inc": 2.5,
          "repsMin": 8,
          "sg": "a",
          "why": "<1-2 sentences naming why this exercise, here, at this prescription>"
        }
      ]
    }
  ],
  "runPlan": null,
  "customEx": []
}
```

- `week` keys are weekday numbers as strings, values are `routines[].id` from this same answer.
- `mode` is `reps` (use `reps`), `time` (use `sec`), or `cardio` (use `min` and `speed`).
- `prog` on a routine is its default; on an exercise it overrides. `inc` is the load step in `meta.unit`; `repsMin` only matters for `double`.
- `sg`: give two exercises the same short string to superset them. They must be adjacent in the list.
- `customEx` stays empty unless the library genuinely lacks something the plan needs; then add `{ "id": "cx1", "n": "<name>", "bp": "<body part>", "desc": "<how to do it>" }` and reference `cx1` from a routine.
