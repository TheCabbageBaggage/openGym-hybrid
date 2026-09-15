import { describe, it, expect } from 'vitest'
import {
  EMPTY_RUN, ensureRun, hasRun, allSessions, findSession, weekOfSession,
  cleanRun, cleanStructure, cleanSession, cleanActual, validateRun,
  structureKm, daysBetween, addDays, weekdayOf, iso, routinesOn, strengthOn,
  planRange, planTotals, compliance, MAX_RUN_WEEKS
} from './run-model.js'

describe('run namespace', () => {
  it('is absent from a strength-only profile and created on demand', () => {
    const S = { routines: [] }
    expect(hasRun(S)).toBe(false)
    expect(S.run).toBeUndefined()
    const r = ensureRun(S)
    expect(r.weeks).toEqual([])
    expect(hasRun(S)).toBe(false)
  })

  it('does not mutate a profile it is only asked about', () => {
    const S = { routines: [] }
    hasRun(S); allSessions(S.run); findSession(S.run, 'x')
    expect(S.run).toBeUndefined()
  })

  it('has the server schema key set', () => {
    expect(Object.keys(EMPTY_RUN).sort()).toEqual(['calibration', 'updatedAt', 'weeks', 'zones'])
  })
})

describe('dates', () => {
  it('is pure civil-date arithmetic in UTC', () => {
    expect(addDays('2026-09-21', 6)).toBe('2026-09-27')
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('names the weekday the way a slot does, 0 = Sunday', () => {
    expect(weekdayOf('2026-09-20')).toBe(0)
    expect(weekdayOf('2026-09-21')).toBe(1)
    expect(weekdayOf('2026-09-26')).toBe(6)
  })

  it('counts whole days between two civil dates', () => {
    expect(daysBetween('2026-09-21', '2026-09-23')).toBe(2)
    expect(daysBetween('2026-09-23', '2026-09-21')).toBe(-2)
    expect(daysBetween(null, '2026-09-21')).toBe(null)
  })

  it('uses the UTC date, so a browser west of Greenwich does not shift the plan', () => {
    expect(iso(Date.UTC(2026, 8, 21, 0, 30))).toBe('2026-09-21')
  })
})

describe('strength lookups', () => {
  const S = { week: { 1: ['r1'], 3: ['r2', 'r3'], 5: 'r4' } }
  it('folds a legacy bare string and a list to the same answer', () => {
    expect(routinesOn(S, '2026-09-21')).toEqual(['r1'])      // Monday
    expect(routinesOn(S, '2026-09-23')).toEqual(['r2', 'r3']) // Wednesday
    expect(routinesOn(S, '2026-09-25')).toEqual(['r4'])      // Friday
    expect(routinesOn(S, '2026-09-22')).toEqual([])
  })
  it('answers whether a strength session is planned', () => {
    expect(strengthOn(S, '2026-09-21')).toBe(true)
    expect(strengthOn(S, '2026-09-22')).toBe(false)
  })
})

describe('structure cleaning', () => {
  it('keeps a distance structure and drops a mixed one', () => {
    const ok = cleanStructure([{ rep: 6, dist: 800, paceZone: 'interval', restSec: 90 }])
    expect(ok).toEqual([{ rep: 6, dist: 800, paceZone: 'interval', restSec: 90 }])
    expect(cleanStructure([{ rep: 6, dist: 800 }, { rep: 3, timeSec: 180 }])).toEqual([])
  })

  it('keeps a time structure', () => {
    expect(cleanStructure([{ rep: 5, timeSec: 180, paceZone: 'interval', restSec: 90 }]))
      .toHaveLength(1)
  })

  it('clamps rep counts to something a screen can show', () => {
    expect(cleanStructure([{ rep: 999, dist: 800 }])[0].rep).toBe(20)
    expect(cleanStructure([{ rep: 0, dist: 800 }])[0].rep).toBe(1)
  })

  it('refuses a repetition with neither distance nor time', () => {
    expect(cleanStructure([{ rep: 5, paceZone: 'easy' }])).toEqual([])
    expect(cleanStructure(null)).toEqual([])
  })

  it('drops restSec when it is not a number', () => {
    expect(cleanStructure([{ rep: 4, dist: 1000, restSec: null }])[0].restSec).toBeUndefined()
  })
})

describe('session cleaning', () => {
  it('drops a session with no usable date', () => {
    expect(cleanSession({ type: 'easy', d: 'tomorrow' })).toBe(null)
    expect(cleanSession({ type: 'easy' })).toBe(null)
  })

  it('drops an explicit rest session — a rest day is the absence of one', () => {
    expect(cleanSession({ type: 'rest', d: '2026-09-21' })).toBe(null)
  })

  it('keeps a plain easy run', () => {
    const s = cleanSession({ id: 'a', d: '2026-09-21', type: 'easy', km: 8.4 })
    expect(s.km).toBe(8.4)
    expect(s.done).toBe(false)
    expect(s.structure).toBeUndefined()
  })

  it('rounds distance but does not invent one', () => {
    expect(cleanSession({ d: '2026-09-21', type: 'easy', km: 8.44 }).km).toBe(8.4)
    expect(cleanSession({ d: '2026-09-21', type: 'easy' }).km).toBe(null)
  })

  it('keeps an actual result, including a Garmin one', () => {
    const s = cleanSession({
      d: '2026-09-21', type: 'easy', km: 10, done: true,
      actual: { km: 10.02, sec: 3001, avgHR: 148, source: 'garmin' }
    })
    expect(s.actual.source).toBe('garmin')
    expect(s.actual.km).toBe(10.02)
  })

  it('returns null for an actual with nothing in it', () => {
    expect(cleanActual({})).toBe(null)
    expect(cleanActual(null)).toBe(null)
  })

  it('trims notes and treats blank as absent', () => {
    expect(cleanSession({ d: '2026-09-21', type: 'easy', notes: '  + 6 x 20 s Strides ' }).notes)
      .toBe('+ 6 x 20 s Strides')
    expect(cleanSession({ d: '2026-09-21', type: 'easy', notes: '   ' }).notes).toBeUndefined()
  })
})

describe('plan cleaning', () => {
  it('sorts sessions by date and renumbers weeks', () => {
    const run = cleanRun({
      run: {
        weeks: [
          { wk: 9, phase: 'base', sessions: [{ d: '2026-09-28', type: 'easy', km: 6 }, { d: '2026-09-26', type: 'long', km: 12 }] },
          { wk: 3, phase: 'base', sessions: [{ d: '2026-09-21', type: 'easy', km: 6 }] }
        ]
      }
    })
    expect(run.weeks.map(w => w.wk)).toEqual([1, 2])
    expect(run.weeks[0].sessions[0].d).toBe('2026-09-21')
    expect(run.weeks[1].sessions.map(s => s.d)).toEqual(['2026-09-26', '2026-09-28'])
  })

  it('drops an empty week rather than keeping a week with nothing in it', () => {
    const run = cleanRun({ run: { weeks: [{ wk: 1, sessions: [] }, { wk: 2, sessions: [{ d: '2026-09-21', type: 'easy', km: 5 }] }] } })
    expect(run.weeks).toHaveLength(1)
    expect(run.weeks[0].wk).toBe(1)
  })

  it('caps the number of weeks', () => {
    const weeks = Array.from({ length: 60 }, (_, i) => ({
      wk: i + 1, sessions: [{ d: addDays('2026-01-01', i * 7), type: 'easy', km: 5 }]
    }))
    expect(cleanRun({ run: { weeks } }).weeks).toHaveLength(MAX_RUN_WEEKS)
  })

  it('computes a missing week total from its sessions', () => {
    const run = cleanRun({ run: { weeks: [{ sessions: [{ d: '2026-09-21', type: 'easy', km: 6 }, { d: '2026-09-23', type: 'easy', km: 4.5 }] }] } })
    expect(run.weeks[0].km).toBe(10.5)
  })
})

describe('validation', () => {
  const week = (km, sessions) => ({ wk: 1, phase: 'base', km, sessions })

  it('accepts a plain coherent week', () => {
    expect(validateRun(cleanRun({
      run: { weeks: [week(10, [{ id: 'a', d: '2026-09-21', type: 'easy', km: 10 }])] }
    }))).toEqual([])
  })

  it('catches two sessions on one day', () => {
    const problems = validateRun(cleanRun({
      run: { weeks: [week(10, [
        { id: 'a', d: '2026-09-21', type: 'easy', km: 5 },
        { id: 'b', d: '2026-09-21', type: 'easy', km: 5 }
      ])] }
    }))
    expect(problems.some(p => p.includes('two sessions'))).toBe(true)
  })

  it('catches a duplicate session id', () => {
    const problems = validateRun({
      weeks: [{ wk: 1, phase: 'base', km: 12, sessions: [
        { id: 'same', d: '2026-09-21', type: 'easy', km: 6 },
        { id: 'same', d: '2026-09-23', type: 'easy', km: 6 }
      ] }]
    })
    expect(problems.some(p => p.includes('duplicate'))).toBe(true)
  })

  it('catches a session with no distance', () => {
    const problems = validateRun({
      weeks: [{ wk: 1, phase: 'base', km: 6, sessions: [{ id: 'a', d: '2026-09-21', type: 'easy', km: null }] }]
    })
    expect(problems.some(p => p.includes('no distance'))).toBe(true)
  })

  it('catches a structure that does not fit its session', () => {
    const problems = validateRun({
      weeks: [{ wk: 1, phase: 'base', km: 6, sessions: [{
        id: 'a', d: '2026-09-21', type: 'interval', km: 5,
        structure: [{ rep: 10, dist: 1000, paceZone: 'interval' }]
      }] }]
    })
    expect(problems.some(p => p.includes('longer than the session'))).toBe(true)
  })

  it('returns a problem for a plan that is not one', () => {
    expect(validateRun(null)).toEqual(['no plan'])
  })
})

describe('structureKm', () => {
  it('adds the repetitions and the warm-up allowance', () => {
    // 6 x 800 m = 4.8 km, plus 3 km of warm-up and cool-down
    expect(structureKm([{ rep: 6, dist: 800 }])).toBe(7.8)
  })
  it('estimates a time structure at 5:00/km', () => {
    // 5 x 3 min = 15 min at 5:00/km = 3 km, plus 3
    expect(structureKm([{ rep: 5, timeSec: 180 }])).toBe(6)
  })
  it('is zero for no structure', () => {
    expect(structureKm(null)).toBe(0)
  })
})

describe('display helpers', () => {
  const run = cleanRun({
    run: { weeks: [
      { wk: 1, phase: 'base', sessions: [
        { id: 'a', d: '2026-09-21', type: 'easy', km: 6, done: true },
        { id: 'b', d: '2026-09-26', type: 'long', km: 12, done: false }
      ] },
      { wk: 2, phase: 'base', sessions: [
        { id: 'c', d: '2026-09-28', type: 'easy', km: 7, done: false }
      ] }
    ] }
  })

  it('reports the plan range', () => {
    expect(planRange(run)).toEqual({ from: '2026-09-21', to: '2026-09-28' })
  })

  it('totals the plan', () => {
    expect(planTotals(run)).toEqual({ km: 25, weeks: 2, avgKm: 12.5 })
  })

  it('measures compliance against the sessions that were due', () => {
    const c = compliance(run, '2026-09-22')
    expect(c.due).toBe(1)
    expect(c.done).toBe(1)
    expect(c.ratio).toBe(1)
  })

  it('counts a missed session once its day has passed', () => {
    const c = compliance(run, '2026-09-27')
    expect(c.due).toBe(2)
    expect(c.done).toBe(1)
    expect(c.missed).toEqual(['b'])
  })
})

describe('session lookup', () => {
  const run = cleanRun({
    run: { weeks: [{ wk: 1, sessions: [{ id: 'a', d: '2026-09-21', type: 'easy', km: 6 }] }] }
  })
  it('finds a session and its week', () => {
    expect(findSession(run, 'a').km).toBe(6)
    expect(weekOfSession(run, 'a').wk).toBe(1)
    expect(findSession(run, 'zz')).toBe(null)
    expect(weekOfSession(run, 'zz')).toBe(null)
  })
  it('flattens every session with its week number', () => {
    expect(allSessions(run)[0].wk).toBe(1)
  })
})
