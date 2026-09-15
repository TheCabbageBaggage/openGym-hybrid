/* The `runPlan` expander: the coach's shape becomes an actual running plan.
 *
 * The division of labour, and it is deliberate: **the model decides the shape, the app does the
 * arithmetic.** The coach answers with a weekly skeleton — which weekdays are running days, of
 * what type, roughly how many kilometres the first week holds, and whether a calibration test is
 * needed. Everything else — how the volume climbs, where the deloads land, how the long run is
 * sized, how many repetitions an interval session has by week six, whether the race taper is
 * sharp enough — is computed here, deterministically.
 *
 * That is not a shortcut. A model asked for eighteen weeks of individual sessions produces
 * eighteen weeks of numbers that are individually plausible and collectively incoherent, and no
 * validator can catch "the weekly progression is subtly wrong". Asked for one shape, it does the
 * thing it is actually good at, and the progression becomes testable arithmetic.
 *
 * HYBRID: new file.
 */
import {
  MAX_RUN_WEEKS, addDays, weekdayOf, cleanRun, iso, daysBetween
} from './run-model.js'
import { zonesFrom } from './run-zones.js'
import { WORKOUT_TYPES, CALIBRATION } from './run-vocab.js'
import { checkWeek, legDays, addIsoDays } from './run-interference.js'

/** What the coach is allowed to ask for. Anything outside is clamped, not rejected. */
export const MAX_PLAN_WEEKS = 12          // a block, not a season
export const MAX_SLOTS = 7
export const MIN_VOLUME_START = 5
export const MAX_VOLUME_START = 150

const isNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0
const round1 = n => Math.round(n * 10) / 10

/**
 * Normalise a `runPlan` from the coach into something the builder can use.
 * Unusable input returns null — the strength half of the proposal is still worth applying, so
 * this never throws.
 */
export function normalizeRunPlan(plan) {
  if (!plan || typeof plan !== 'object') return null
  const startDate = typeof plan.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(plan.startDate)
    ? plan.startDate : iso(Date.now())
  const weeks = Math.min(MAX_PLAN_WEEKS, Math.max(1, Math.round(Number(plan.weeks) || 8)))
  const volumeStart = Math.min(MAX_VOLUME_START, Math.max(MIN_VOLUME_START, Number(plan.volumeStart) || 20))
  const slots = []
  const seen = new Set()
  for (const s of (plan.slots || []).slice(0, MAX_SLOTS)) {
    if (!s || typeof s !== 'object') continue
    const wd = Number(s.weekday)
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) continue
    if (seen.has(wd)) continue                 // one session a day; a second slot is a mistake
    if (s.type === 'rest' || !WORKOUT_TYPES[s.type]) continue
    seen.add(wd)
    slots.push({ weekday: wd, type: s.type, km: isNum(Number(s.km)) ? Number(s.km) : null })
  }
  if (!slots.length) return null
  const race = plan.race && typeof plan.race === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(plan.race.d)
    ? { d: plan.race.d, distanceKm: Number(plan.race.distanceKm) || null, name: plan.race.name || null }
    : null
  return {
    startDate, weeks, volumeStart,
    unit: plan.unit === 'mi' ? 'mi' : 'km',
    calibration: plan.calibration !== false,
    slots, race,
    why: typeof plan.why === 'string' ? plan.why.slice(0, 600) : ''
  }
}

/* ============================ the week's shape ============================ */

/**
 * What phase a week is in. Deloads every fourth week of building; the last weeks taper when a
 * race is set. This is the plan's skeleton and it is fixed, not emergent — a progression that
 * decided its own deloads would be a progression nobody could reason about.
 */
export function phaseFor(wk, weeks, { race = null } = {}) {
  if (race) {
    const raceWeek = weeks                             // the race sits in the final week
    if (wk === raceWeek) return 'race'
    if (wk === raceWeek - 1) return 'taper'
    if (wk === raceWeek - 2) return 'taper'
  } else if (wk >= weeks - 1) {
    return 'taper'                                     // the block eases out even with no race
  }
  if (wk > 1 && wk % 4 === 0) return 'deload'
  if (wk <= Math.max(1, Math.floor(weeks * 0.4))) return 'base'
  if (wk <= Math.max(2, Math.floor(weeks * 0.75))) return 'build'
  return 'peak'
}

/**
 * The volume targets for a block, one per week.
 *
 * Two numbers, and they are not the same number. `peak` is what the block builds towards and
 * only ever climbs; each week's target dips in a deload and tapers at the end. Tracking only one
 * of them is how a plan ratchets downwards — every deload permanently lowers the base the next
 * week grows from, so an eight-week block ends lighter than it started.
 *
 * The taper is built *inside* the same loop rather than applied to already-computed targets.
 * Scaling a finished list is how two taper weeks end up identical: week two of the taper is
 * derived from week one's already-reduced number and comes out the same, because the reduction
 * was applied to a peak-based value both times.
 */
export function volumeTargets({ weeks, volumeStart, race = null }) {
  const out = []
  let peak = volumeStart
  const raceIdx = race ? weeks : null
  const taperStart = race ? raceIdx - 2 : weeks - 1     // first taper week (1-based)
  const taperLen = race ? 2 : 1
  // How many weeks of building happen before the taper, so the step-down is spread over them.
  for (let wk = 1; wk <= weeks; wk++) {
    const phase = phaseFor(wk, weeks, { race })
    let target
    if (phase === 'deload') {
      target = peak * 0.75                             // a quarter off, in both disciplines
    } else if (phase === 'taper') {
      // Each taper week is a further step down from the peak, and the last is the lightest.
      // `idx` is 0 for the first taper week, so a two-week taper lands at 65 % and then 55 %.
      const idx = Math.max(0, wk - taperStart)
      target = peak * (taperLen === 1 ? 0.6 : (0.65 - idx * 0.1))
    } else if (phase === 'race') {
      target = peak * 0.45
    } else {
      // +8 % a week in the base, +5 % once the quality work starts to bite. Below the ten
      // percent ceiling on purpose: the ceiling is the rule, not the target.
      //
      // Measured from `peak` and not from last week's reduced target — that is the whole point
      // of keeping two numbers. A deload week lowers this week's kilometres, never the base the
      // next building week grows out of, and a step measured from a deload would breach the ten
      // percent ceiling the moment the block resumes.
      const step = phase === 'base' ? 0.08 : 0.05
      target = peak * (1 + step)
      peak = target
    }
    out.push({ wk, phase, km: round1(Math.max(5, target)) })
  }
  return out
}

/* ============================ session building ============================ */

/**
 * How long the long run is: about a third of the week, floored so it stays a long run and capped
 * so it does not swallow the week.
 */
export function longRunKm(weekKm, { phase = 'base', weeks = 8, wk = 1 } = {}) {
  const target = weekKm * 0.35
  const floor = Math.min(8, weekKm * 0.45)
  const ceiling = weekKm * 0.5
  return round1(Math.min(ceiling, Math.max(floor, target)))
}

/**
 * The repetitions a quality session starts from, and how they grow. The count climbs through the
 * build and peak one repetition at a time and steps back in a deload — derived from how many
 * building weeks have happened, not from the week number modulo something. A modulo test makes
 * the count rise and fall, which is a plan getting easier for reasons a runner cannot see.
 */
export function repsFor(type, { buildWeeksSeen = 0, weeks = 8, phase = 'base' } = {}) {
  const preset = WORKOUT_TYPES[type]?.structure
  if (!preset) return null
  const base = preset.rep || 1
  const growth = Math.floor(buildWeeksSeen / Math.max(1, Math.round(weeks / 6)))
  const ceil = preset.dist ? 10 : 8
  let rep = Math.min(ceil, base + growth)
  if (phase === 'deload') rep = Math.max(1, rep - 1)
  if (phase === 'taper' || phase === 'race') rep = Math.max(1, Math.round(rep * 0.6))
  return { ...preset, rep }
}

/**
 * Build the whole plan. Returns `{ run }` — a cleaned, validated `S.run` namespace, ready to be
 * written. `S` is the strength state, used for the interference check and nothing else.
 *
 * When the interference rules cannot be satisfied the plan is returned with the conflicts
 * attached rather than silently rearranged: the caller decides whether to block the apply or to
 * show the user what has to give. Silently moving days would be the app pretending it can
 * reconcile two things it cannot.
 */
export function expandRunPlan(plan, { S = null, existing = null } = {}) {
  const norm = normalizeRunPlan(plan)
  if (!norm) return null
  const thresholdPace = existing?.zones?.thresholdPace || null
  const paceZones = thresholdPace ? zonesFrom(thresholdPace) : null

  const targets = volumeTargets(norm)
  const weeks = []
  let buildWeeksSeen = 0

  for (const t of targets) {
    const weekStart = addDays(norm.startDate, (t.wk - 1) * 7)
    if (t.phase === 'build' || t.phase === 'peak') buildWeeksSeen += 1

    const sessions = []
    // The calibration run goes in the first week of a plan with no threshold pace, on a day with
    // no slot of its own if one is free — the test is not a training session and should not
    // displace one. It also keeps 48 h from the long run for the same reason a race does.
    const slotsForWeek = norm.slots.map(s => ({ ...s }))
    if (t.wk === 1 && norm.calibration && !thresholdPace) {
      const free = [2, 4, 6, 1, 3, 5, 0].find(wd => !slotsForWeek.some(s => s.weekday === wd)) ?? null
      if (free != null) slotsForWeek.push({ weekday: free, type: CALIBRATION.type, km: 6 })
    }

    for (const slot of slotsForWeek) {
      const offset = (slot.weekday - weekdayOf(weekStart) + 7) % 7
      const d = addDays(weekStart, offset)
      const built = buildSession({
        d, type: slot.type, weekKm: t.km, sessions, phase: t.phase,
        paceZones, buildWeeksSeen, weeks: norm.weeks, wk: t.wk, declaredKm: slot.km
      })
      if (built) sessions.push(built)
    }
    sessions.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))

    // Re-balance now that every session exists: the remaining kilometres go to the easy runs,
    // which is where the slack is. Doing this after the loop is what keeps the week on target
    // when the structured sessions have absorbed more or less than their share.
    balanceWeek(sessions, t.km, { phase: t.phase })

    weeks.push({ wk: t.wk, phase: t.phase, km: round1(sessions.reduce((n, s) => n + (s.km || 0), 0)), sessions })
  }

  const run = cleanRun({ run: { calibration: null, zones: paceZones ? { thresholdPace, unit: norm.unit, paceZones } : null, weeks, updatedAt: Date.now() } })

  // The calibration test carries the threshold pace once it is done; until then the plan is
  // explicitly provisional and every view says so.
  const cal = weeks[0]?.sessions.find(s => s.type === CALIBRATION.type)
  if (cal) run.calibration = { type: 'threshold30', d: cal.d, done: false, km: cal.km }

  const conflicts = S ? collectConflicts(run, S) : []
  return { run, conflicts, plan: norm }
}

/**
 * One session, sized. The order matters: the distance is decided from the type's own requirement
 * first and the week's target only afterwards, because six 800s are a fixed distance however
 * light the week is.
 */
function buildSession({ d, type, weekKm, sessions, phase, paceZones, buildWeeksSeen, weeks, wk, declaredKm = null }) {
  const preset = repsFor(type, { buildWeeksSeen, weeks, phase })
  const zone = WORKOUT_TYPES[type]?.zone || 'easy'
  const km = declaredKm || sessionKmFor(type, preset, weekKm, sessions.length, phase)
  const targetPaceSec = paceZones && zone ? targetPaceOf(zone, paceZones) : null
  const s = {
    id: runSessionId(d, type),
    d, type,
    km: round1(km),
    targetPaceSec,
    targetHR: null,
    done: false
  }
  if (preset) {
    // A single sustained effort is a session, not a structure: `tempo` is one 20-minute block
    // and rendering it as "1 x 20 min · 0 s rest" is a card that reads like a mistake.
    const isSingleBlock = preset.rep === 1 && preset.restSec === 0
    if (!isSingleBlock) s.structure = [{ ...preset, paceZone: preset.paceZone || zone }]
  }
  return s
}

function sessionKmFor(type, preset, weekKm, existing, phase) {
  if (type === 'long') return longRunKm(weekKm, { phase })
  if (type === 'rest') return 0
  if (!preset) {
    // An unstructured run: easy, recovery, progression, time-trial, race. A share of the week,
    // floored at a distance that is worth putting shoes on for.
    const base = type === 'recovery' ? weekKm * 0.12 : weekKm * 0.18
    return Math.max(4, base)
  }
  // Structured: the reps' own distance plus a warm-up and cool-down. `structureKm` in the model
  // is the same arithmetic — this is the sizing side of it.
  let workKm = 0
  const one = preset.dist ? preset.dist / 1000 : (preset.timeSec / 300)
  workKm += one * (preset.rep || 1)
  const restKm = preset.restSec ? (preset.restSec * (preset.rep || 1)) / 330 : 0   // jog recovery
  return Math.max(6, workKm + restKm + 3)
}

/** The middle of a zone band — what a session card shows as the target. */
function targetPaceOf(zone, paceZones) {
  const band = paceZones?.[zone]
  if (!band) return null
  return Math.round((band[0] + band[1]) / 2)
}

/**
 * Put the week's leftovers into the easy running.
 *
 * The structured sessions and the long run are sized from what they *are*; the easy runs are
 * sized from what is *left*. Doing it in that order is what makes the weekly total land on its
 * target instead of drifting a kilometre or two every week, which is invisible in any one week
 * and a ruined block by week ten.
 */
function balanceWeek(sessions, weekKm, { phase = 'base' } = {}) {
  const easy = sessions.filter(s => !s.structure && s.type !== 'long')
  const fixed = sessions.filter(s => s.structure || s.type === 'long')
  const fixedKm = fixed.reduce((n, s) => n + (s.km || 0), 0)
  if (!easy.length) {
    // No easy run to absorb the difference: scale the fixed sessions, except the long run, which
    // is the one distance the week is built around.
    const scale = weekKm / Math.max(0.1, fixedKm)
    for (const s of sessions) {
      if (s.type === 'long') continue
      s.km = round1(Math.max(3, (s.km || 0) * Math.min(1.4, scale)))
    }
    return
  }
  const each = Math.max(4, (weekKm - fixedKm) / easy.length)
  for (const s of easy) s.km = round1(each)
}

/** A stable session id: the date and the type. Rebuilding the same plan gives the same ids, so a
 *  change proposal that names a session still names the same session after a rebuild. */
export const runSessionId = (d, type) => `run-${d}-${type}`

/** Collect the interference conflicts for a freshly built plan. */
function collectConflicts(run, S) {
  const out = []
  for (const w of run.weeks) {
    const sessions = w.sessions || []
    if (!sessions.length) continue
    const legs = legDays(S, {
      from: addIsoDays(sessions[0].d, -3),
      to: sessions[sessions.length - 1].d
    })
    out.push(...checkWeek(sessions, legs, { deload: w.phase === 'deload' }))
  }
  return out
}

/**
 * The week summary the proposal screen shows before anything is applied: what the running week
 * looks like and where it collides with the lifting week.
 */
export function expandedSummary(run) {
  const weeks = run?.weeks || []
  const sessions = weeks.flatMap(w => w.sessions || [])
  const quality = sessions.filter(s => WORKOUT_TYPES[s.type]?.quality).length
  return {
    weeks: weeks.length,
    sessions: sessions.length,
    km: round1(sessions.reduce((n, s) => n + (s.km || 0), 0)),
    quality,
    longRuns: sessions.filter(s => s.type === 'long').length,
    firstWeek: weeks[0] ? { km: weeks[0].km, sessions: weeks[0].sessions.length } : null,
    peakWeek: weeks.length ? Math.max(...weeks.map(w => w.km)) : 0,
    from: sessions[0]?.d || null,
    to: sessions[sessions.length - 1]?.d || null,
    provisional: !run?.zones?.thresholdPace
  }
}

export { daysBetween }
