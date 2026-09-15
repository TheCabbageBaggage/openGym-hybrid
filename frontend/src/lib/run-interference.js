/* Strength and running interfere. This is the client-side check.
 *
 * Mirror of `api/coach/run/interference.js`. The server refuses a proposal that breaks these
 * rules; the client checks the same rules for two reasons that are not redundancy:
 *
 *   1. A plan can be built or edited **by hand** in the app, and a hand-built plan never passes
 *      through the server. Without this, the blocking rules would only apply to Coach output.
 *   2. The warnings have to be explainable where the plan is: "your long run is 20 hours after
 *      leg day" belongs next to the long run, not in a generic error.
 *
 * The thresholds are Linus's decisions (2026-09-15): a day counts as a leg day when at least
 * half its working sets are on leg muscles, and the rules **block** rather than warn.
 *
 * HYBRID: new file.
 */
import { routinesOn, daysBetween, strengthOn } from './run-model.js'

/** The muscle groups that make a day a leg day. */
export const LEG_GROUPS = ['quads', 'hamstrings', 'glutes', 'calves', 'legs']

/** Half the working sets. Linus's number — a routine is a leg day when legs are most of it. */
export const LEG_SHARE_THRESHOLD = 0.5

export const MIN_HOURS_LEG_TO_LONG = 48
export const MIN_HOURS_LEG_TO_QUALITY = 48
export const MIN_HOURS_LONG_TO_QUALITY = 24

/** At most a quarter of the week's kilometres at quality pace once legs are in the week. */
export const HARD_SHARE_CAP_WITH_LEGS = 0.25
/** Leg sets come down when two or more quality runs are in the week. */
export const LEG_VOLUME_MULTIPLIER = 0.75

/**
 * Whether a routine is a leg day: at least half of its working sets train legs.
 *
 * Shares, not names. A rule that looks for "squat" in the routine name breaks the moment someone
 * renames a day or builds a leg day out of lunges and RDLs — and the failure is silent, which is
 * the worst kind for a rule whose whole job is to prevent injury.
 */
export function isLegDay(routine, bodyPartOf = () => null) {
  if (!routine || !Array.isArray(routine.ex) || !routine.ex.length) return false
  let total = 0
  let legs = 0
  for (const e of routine.ex) {
    const sets = Math.max(1, Number(e.sets) || 1)
    total += sets
    const bp = bodyPartOf(e.id)
    // A superset's partner is a separate entry, so it is counted separately — which is right:
    // the question is how much work the day puts on the legs, not how many exercises name them.
    if (LEG_GROUPS.includes(bp)) legs += sets
  }
  return total > 0 && legs / total >= LEG_SHARE_THRESHOLD
}

/** Every date in a range whose scheduled routine is a leg day, with the routine attached. */
export function legDays(S, { from, to } = {}) {
  const out = []
  if (!S || !from || !to) return out
  const bodyPartOf = S.bodyPartOf || (() => null)
  let d = from
  let guard = 0
  while (d <= to && guard++ < 400) {
    for (const id of routinesOn(S, d)) {
      const r = (S.routines || []).find(x => x.id === id)
      if (r && isLegDay(r, bodyPartOf)) out.push({ d, routineId: id, name: r.name })
    }
    d = addIsoDays(d, 1)
  }
  return out
}

export const addIsoDays = (isoDate, n) => {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The nearest leg day before `isoDate`, with the gap in days. `null` when there is none. */
export function nearestLegBefore(legs, isoDate) {
  let best = null
  for (const l of legs) {
    const gap = daysBetween(l.d, isoDate)
    if (gap == null || gap < 0) continue
    if (!best || gap < best.gap) best = { ...l, gap }
  }
  return best
}

/**
 * The rules, for one week's sessions against that week's leg days.
 *
 * `slack` is the one place the rules are deliberately loosened: in a deload week the leg day is
 * itself lighter, so 24 hours is enough rather than 48. A rule that ignores deloads would forbid
 * the one arrangement a deload exists to allow.
 */
export function checkWeek(sessions, legs, { deload = false } = {}) {
  const conflicts = []
  const legToLong = deload ? 24 : MIN_HOURS_LEG_TO_LONG
  const legToQuality = deload ? 24 : MIN_HOURS_LEG_TO_QUALITY
  for (const s of sessions || []) {
    const quality = !!RUN_TYPE_QUALITY[s.type]
    // The long run is checked explicitly. Riding on `quality` would skip it — and the long run
    // is the session this whole rule exists to protect, because it is the one that does the
    // damage on unrecovered legs.
    const needsGap = s.type === 'long' ? legToLong : quality ? legToQuality : null
    if (needsGap == null) continue
    const near = nearestLegBefore(legs, s.d)
    if (!near) continue
    const hours = near.gap * 24
    if (hours < needsGap) {
      conflicts.push({
        kind: s.type === 'long' ? 'leg-long' : 'leg-quality',
        sessionId: s.id, d: s.d, type: s.type,
        legDay: near.d, legRoutine: near.name,
        hours, required: needsGap,
        message: s.type === 'long'
          ? `Long run is ${hours} h after leg day (${near.name}) — ${needsGap} h required`
          : `${s.type} is ${hours} h after leg day (${near.name}) — ${needsGap} h required`
      })
    }
  }
  return conflicts
}

/** Quality types, restated so this module does not import the vocab just for a membership test. */
const RUN_TYPE_QUALITY = {
  tempo: 1, threshold: 1, cruise: 1, interval: 1, 'interval-time': 1, fartlek: 1,
  hills: 1, progression: 1, 'race-pace': 1, 'time-trial': 1, race: 1
}

/**
 * The whole plan against the whole lifting week. Returns `{ conflicts, deloads }` — an empty
 * `conflicts` means the plan is legal.
 */
export function checkPlan(run, S, { from = null, to = null } = {}) {
  const weeks = run?.weeks || []
  const conflicts = []
  for (const w of weeks) {
    const sessions = w.sessions || []
    if (!sessions.length) continue
    const start = from || sessions[0].d
    const end = to || sessions[sessions.length - 1].d
    const legs = legDays(S, { from: addIsoDays(start, -3), to: end })
    conflicts.push(...checkWeek(sessions, legs, { deload: w.phase === 'deload' }))
  }
  return { conflicts }
}

/**
 * How close the long run and the quality sessions sit to leg days, for the review payload and
 * for the running view's warning strip. Positive = hours after the leg day.
 */
export function proximity(run, S) {
  const out = []
  for (const w of run?.weeks || []) {
    const sessions = w.sessions || []
    if (!sessions.length) continue
    const start = sessions[0].d
    const end = sessions[sessions.length - 1].d
    const legs = legDays(S, { from: addIsoDays(start, -3), to: end })
    for (const s of sessions) {
      if (s.type !== 'long' && !RUN_TYPE_QUALITY[s.type]) continue
      const near = nearestLegBefore(legs, s.d)
      out.push({
        sessionId: s.id, d: s.d, type: s.type,
        hoursAfterLegDay: near ? near.gap * 24 : null,
        legDay: near?.d || null
      })
    }
  }
  return out
}

/** How much the leg volume should come down, given the quality runs in a week. */
export function legVolumeMultiplier(run, wk) {
  const week = (run?.weeks || []).find(w => w.wk === wk)
  if (!week) return 1
  const quality = (week.sessions || []).filter(s => RUN_TYPE_QUALITY[s.type]).length
  return quality >= 2 ? LEG_VOLUME_MULTIPLIER : 1
}

/** Whether a proposed arrangement is legal. The one predicate the apply path calls. */
export const isLegalWeek = (sessions, legs, opts) => checkWeek(sessions, legs, opts).length === 0

export { strengthOn }
