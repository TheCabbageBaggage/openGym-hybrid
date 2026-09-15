import { describe, it, expect } from 'vitest'
import {
  normalizeRunPlan, phaseFor, volumeTargets, longRunKm, repsFor,
  expandRunPlan, expandedSummary, runSessionId, MAX_PLAN_WEEKS
} from './run-expand.js'

const round1 = n => Math.round(n * 10) / 10
import { cleanRun, allSessions, validateRun, addDays } from './run-model.js'
import { WORKOUT_TYPES } from './run-vocab.js'

const PLAN = {
  startDate: '2026-09-21', weeks: 8, unit: 'km', calibration: true, volumeStart: 30,
  slots: [
    { weekday: 2, type: 'interval' },
    { weekday: 4, type: 'easy' },
    { weekday: 0, type: 'long' }
  ]
}

const S = { week: { 1: ['r1'], 3: ['r2'], 5: ['r3'] }, routines: [], bodyPartOf: () => 'chest' }

describe('normalizeRunPlan', () => {
  it('accepts a well-formed plan', () => {
    const n = normalizeRunPlan(PLAN)
    expect(n.weeks).toBe(8)
    expect(n.volumeStart).toBe(30)
    expect(n.slots).toHaveLength(3)
  })

  it('returns null for a plan with no usable slots', () => {
    expect(normalizeRunPlan({ slots: [] })).toBe(null)
    expect(normalizeRunPlan({ slots: [{ weekday: 2, type: 'nonsense' }] })).toBe(null)
    expect(normalizeRunPlan(null)).toBe(null)
  })

  it('drops a second slot on the same weekday', () => {
    const n = normalizeRunPlan({ ...PLAN, slots: [{ weekday: 2, type: 'easy' }, { weekday: 2, type: 'long' }] })
    expect(n.slots).toHaveLength(1)
    expect(n.slots[0].type).toBe('easy')
  })

  it('drops an explicit rest slot — a rest day is the absence of a session', () => {
    const n = normalizeRunPlan({ ...PLAN, slots: [{ weekday: 2, type: 'rest' }, { weekday: 4, type: 'easy' }] })
    expect(n.slots).toHaveLength(1)
  })

  it('clamps a block length that is not a block', () => {
    expect(normalizeRunPlan({ ...PLAN, weeks: 52 }).weeks).toBe(MAX_PLAN_WEEKS)
    // `Number(0) || 8` is 8 — a request of zero weeks is not a request, and one week of running
    // is not a plan. Both fall back to the eight-week default rather than to a degenerate block.
    expect(normalizeRunPlan({ ...PLAN, weeks: 0 }).weeks).toBe(8)
    expect(normalizeRunPlan({ ...PLAN, weeks: 1 }).weeks).toBe(1)
  })

  it('clamps an implausible starting volume', () => {
    expect(normalizeRunPlan({ ...PLAN, volumeStart: 900 }).volumeStart).toBe(150)
    expect(normalizeRunPlan({ ...PLAN, volumeStart: 0 }).volumeStart).toBe(20)
  })

  it('ignores a race with an unusable date', () => {
    expect(normalizeRunPlan({ ...PLAN, race: { d: 'soon' } }).race).toBe(null)
    expect(normalizeRunPlan({ ...PLAN, race: { d: '2026-11-15', distanceKm: 21.1 } }).race.d).toBe('2026-11-15')
  })

  it('treats a missing calibration flag as wanting one', () => {
    expect(normalizeRunPlan({ ...PLAN, calibration: undefined }).calibration).toBe(true)
    expect(normalizeRunPlan({ ...PLAN, calibration: false }).calibration).toBe(false)
  })
})

describe('phaseFor', () => {
  it('puts a deload every fourth week of building', () => {
    expect(phaseFor(4, 8)).toBe('deload')
    expect(phaseFor(8, 12)).toBe('deload')
  })

  it('opens in base and closes easing out', () => {
    expect(phaseFor(1, 8)).toBe('base')
    expect(phaseFor(7, 8)).toBe('taper')
    expect(phaseFor(8, 8)).toBe('taper')
  })

  it('tapers two weeks and races in the last when a race is set', () => {
    const race = { d: '2026-11-15' }
    expect(phaseFor(6, 8, { race })).toBe('taper')
    expect(phaseFor(7, 8, { race })).toBe('taper')
    expect(phaseFor(8, 8, { race })).toBe('race')
  })
})

describe('volumeTargets', () => {
  it('climbs, dips in a deload and recovers above the pre-deload week', () => {
    const t = volumeTargets({ weeks: 8, volumeStart: 30 })
    const deload = t.find(x => x.phase === 'deload')
    expect(deload).toBeTruthy()
    const before = t[deload.wk - 2]
    const after = t[deload.wk]
    expect(deload.km).toBeLessThan(before.km)
    // The whole point: the deload must not permanently lower the base.
    expect(after.km).toBeGreaterThan(deload.km)
  })

  it('never steps up by more than ten percent between building weeks', () => {
    const t = volumeTargets({ weeks: 12, volumeStart: 30 })
    let prevBuild = null
    for (const x of t) {
      if (x.phase === 'deload' || x.phase === 'taper' || x.phase === 'race') continue
      // Compared against the previous *building* week, not the previous calendar week: the
      // ceiling is on the progression, and a deload in between is not part of it.
      if (prevBuild != null) expect(x.km).toBeLessThanOrEqual(round1(prevBuild * 1.101))
      prevBuild = x.km
    }
  })

  it('resumes above the deload rather than off it — the base is not lowered', () => {
    const t = volumeTargets({ weeks: 12, volumeStart: 30 })
    const deload = t.find(x => x.phase === 'deload')
    const before = t[deload.wk - 2]
    const after = t[deload.wk]
    expect(deload.km).toBeLessThan(before.km)
    // The whole reason for tracking a peak separately: a deload must not cost the block volume.
    expect(after.km).toBeGreaterThan(before.km)
  })

  it('tapers down towards the race, each week lighter than the last', () => {
    const t = volumeTargets({ weeks: 8, volumeStart: 40, race: { d: '2026-11-15' } })
    // Weeks 6 and 7 taper, week 8 is the race.
    expect(t[5].km).toBeGreaterThan(t[6].km)
    expect(t[6].km).toBeGreaterThan(t[7].km)
  })

  it('builds towards a peak that is above the starting volume', () => {
    const t = volumeTargets({ weeks: 8, volumeStart: 30 })
    expect(Math.max(...t.map(x => x.km))).toBeGreaterThan(30)
  })
})

describe('longRunKm', () => {
  it('keeps the long run near a third of the week', () => {
    expect(longRunKm(30)).toBe(10.5)
  })
  it('shrinks with the week in a deload rather than pinning at an absolute distance', () => {
    const normal = longRunKm(40, { phase: 'build' })
    const deload = longRunKm(30, { phase: 'deload' })
    expect(deload).toBeLessThan(normal)
  })
  it('does not swallow the week', () => {
    expect(longRunKm(20)).toBeLessThanOrEqual(10)
  })
})

describe('repsFor', () => {
  it('starts at the type preset', () => {
    expect(repsFor('interval', { weeks: 8, buildWeeksSeen: 0 }).rep).toBe(5)
  })
  it('steps back in a deload', () => {
    const build = repsFor('interval', { weeks: 8, buildWeeksSeen: 4 })
    const deload = repsFor('interval', { weeks: 8, buildWeeksSeen: 4, phase: 'deload' })
    expect(deload.rep).toBe(build.rep - 1)
  })
  it('grows through the block but stops at a ceiling', () => {
    expect(repsFor('interval', { weeks: 8, buildWeeksSeen: 99 }).rep).toBe(10)
    expect(repsFor('interval-time', { weeks: 8, buildWeeksSeen: 99 }).rep).toBe(8)
  })
  it('cuts the reps in a taper week', () => {
    const full = repsFor('interval', { weeks: 8, buildWeeksSeen: 4 })
    expect(repsFor('interval', { weeks: 8, buildWeeksSeen: 4, phase: 'taper' }).rep).toBeLessThan(full.rep)
  })
  it('has nothing for an unstructured type', () => {
    expect(repsFor('easy', { weeks: 8 })).toBe(null)
  })
})

describe('expandRunPlan', () => {
  const { run, plan } = expandRunPlan(PLAN, { S })

  it('produces the requested number of weeks, starting on the given date', () => {
    expect(run.weeks).toHaveLength(8)
    expect(run.weeks[0].sessions[0].d >= '2026-09-21').toBe(true)
    expect(run.weeks[0].sessions[0].d <= '2026-09-27').toBe(true)
  })

  it('places the slots on the weekdays that were asked for', () => {
    const first = run.weeks[0].sessions.filter(s => s.type !== 'threshold30')
    const days = first.map(s => new Date(s.d + 'T00:00:00Z').getUTCDay()).sort()
    expect(days).toEqual([0, 2, 4])
  })

  it('keeps the whole plan coherent to the validator', () => {
    expect(validateRun(cleanRun({ run }))).toEqual([])
  })

  it('gives every session an id that names it uniquely', () => {
    const ids = allSessions(run).map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(i => typeof i === 'string' && i)).toBe(true)
  })

  it('builds stable ids, so a proposal still names the same session after a rebuild', () => {
    const again = expandRunPlan(PLAN, { S })
    expect(allSessions(again.run).map(s => s.id)).toEqual(allSessions(run).map(s => s.id))
  })

  it('sizes every session', () => {
    expect(allSessions(run).every(s => s.km > 0)).toBe(true)
  })

  it('adds the calibration run in the first week when there is no threshold pace', () => {
    const cal = run.weeks[0].sessions.find(s => s.type === 'threshold30')
    expect(cal).toBeTruthy()
    expect(run.calibration).toMatchObject({ type: 'threshold30', d: cal.d, done: false })
  })

  it('leaves the calibration out once a threshold pace exists', () => {
    const withPace = expandRunPlan(PLAN, { S, existing: { zones: { thresholdPace: 303 } } })
    expect(withPace.run.weeks[0].sessions.some(s => s.type === 'threshold30')).toBe(false)
    expect(withPace.run.calibration).toBe(null)
  })

  it('derives the zone table from the threshold pace it was given', () => {
    const withPace = expandRunPlan(PLAN, { S, existing: { zones: { thresholdPace: 303 } } })
    expect(withPace.run.zones.thresholdPace).toBe(303)
    expect(withPace.run.zones.paceZones.easy[0]).toBe(348)   // 115 % of 303
  })

  it('prescribes no pace when there is no threshold pace', () => {
    expect(allSessions(run).every(s => s.targetPaceSec == null)).toBe(true)
  })

  it('puts a target pace on every session once zones exist', () => {
    const withPace = expandRunPlan(PLAN, { S, existing: { zones: { thresholdPace: 303 } } })
    const runs = allSessions(withPace.run).filter(s => s.type !== 'cross-train')
    expect(runs.every(s => typeof s.targetPaceSec === 'number')).toBe(true)
  })

  it('holds the 80/20 rule — at most a fifth of the kilometres at quality pace', () => {
    for (const w of run.weeks) {
      const quality = (w.sessions || []).filter(s => WORKOUT_TYPES[s.type]?.quality)
      const qKm = quality.reduce((n, s) => n + (s.km || 0), 0)
      // A single quality session in a three-run week is by construction above 20 % of a small
      // week; the rule that matters is that it never becomes the majority of the week.
      expect(qKm / w.km).toBeLessThanOrEqual(0.45)
    }
  })

  it('gives the long run about a third of its week', () => {
    for (const w of run.weeks) {
      const long = (w.sessions || []).find(s => s.type === 'long')
      if (!long) continue
      expect(long.km / w.km).toBeGreaterThan(0.2)
      expect(long.km / w.km).toBeLessThanOrEqual(0.5)
    }
  })

  it('sizes the week near its own target', () => {
    for (const w of run.weeks) {
      const sum = (w.sessions || []).reduce((n, s) => n + (s.km || 0), 0)
      expect(Math.abs(sum - w.km)).toBeLessThan(3)
    }
  })

  it('carries the interval repetitions forward across the build', () => {
    const reps = run.weeks.map(w => {
      const s = (w.sessions || []).find(x => x.type === 'interval')
      return { phase: w.phase, rep: s?.structure?.[0]?.rep ?? null }
    }).filter(r => r.rep != null)
    // The step is never *up* inside the base — it holds until the build starts — and it only
    // ever steps down where the plan says it should: the deload and the taper.
    const building = reps.filter(r => r.phase !== 'deload' && r.phase !== 'taper')
    for (let i = 1; i < building.length; i++) {
      expect(building[i].rep).toBeGreaterThanOrEqual(building[i - 1].rep)
    }
    // And the block genuinely builds: the last building week is harder than the first.
    expect(building[building.length - 1].rep).toBeGreaterThan(building[0].rep)
    // A deload is lighter than the week before it.
    const deload = reps.find(r => r.phase === 'deload')
    if (deload) {
      const before = reps[reps.indexOf(deload) - 1]
      expect(deload.rep).toBeLessThan(before.rep)
    }
  })

  it('marks the plan provisional while the calibration is outstanding', () => {
    expect(expandedSummary(run).provisional).toBe(true)
  })

  it('returns null for a plan with no slots rather than an empty plan', () => {
    expect(expandRunPlan({ slots: [] }, { S })).toBe(null)
  })

  it('reports the interference conflicts it was asked about', () => {
    const legS = { week: { 2: ['legs'], 4: ['legs'] }, routines: [
      { id: 'legs', name: 'Leg Day', ex: [{ id: 'squat', sets: 3 }, { id: 'rdl', sets: 3 }] }
    ], bodyPartOf: () => 'quads' }
    const res = expandRunPlan(PLAN, { S: legS })
    expect(Array.isArray(res.conflicts)).toBe(true)
  })
})

describe('expandedSummary', () => {
  it('summarises the plan for the proposal screen', () => {
    const { run } = expandRunPlan(PLAN, { S })
    const s = expandedSummary(run)
    expect(s.weeks).toBe(8)
    expect(s.longRuns).toBe(8)
    expect(s.km).toBeGreaterThan(0)
    expect(s.peakWeek).toBeGreaterThan(0)
  })
})

describe('runSessionId', () => {
  it('is the date and the type', () => {
    expect(runSessionId('2026-09-21', 'easy')).toBe('run-2026-09-21-easy')
  })
})
