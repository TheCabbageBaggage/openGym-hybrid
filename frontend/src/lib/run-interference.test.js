import { describe, it, expect } from 'vitest'
import {
  isLegDay, legDays, checkWeek, checkPlan, proximity, legVolumeMultiplier,
  nearestLegBefore, addIsoDays, LEG_SHARE_THRESHOLD
} from './run-interference.js'
import { cleanRun } from './run-model.js'

/** A routine that is mostly legs. */
const LEGS = { id: 'legs', name: 'Leg Day', ex: [
  { id: 'squat', sets: 4 }, { id: 'rdl', sets: 3 }, { id: 'calf', sets: 3 }
] }
const PUSH = { id: 'push', name: 'Push', ex: [
  { id: 'bench', sets: 3 }, { id: 'ohp', sets: 3 }, { id: 'fly', sets: 3 }
] }
/** Half legs exactly — the boundary the threshold is defined on. */
const HALF = { id: 'half', name: 'Half', ex: [{ id: 'squat', sets: 3 }, { id: 'bench', sets: 3 }] }

// The client mirror's LEG_GROUPS are the exercise library's own `bp` values ("upper legs",
// "lower legs"). This lookup mirrors that; a name like 'quads' would match nothing.
const bp = id => (['squat', 'rdl', 'calf'].includes(id) ? 'upper legs' : 'chest')

describe('isLegDay', () => {
  it('calls a mostly-legs routine a leg day', () => {
    expect(isLegDay(LEGS, bp)).toBe(true)
  })

  it('does not call a push day a leg day', () => {
    expect(isLegDay(PUSH, bp)).toBe(false)
  })

  it('counts sets, not exercise names — an exercise is weighted by its volume', () => {
    // 4 squat sets against 1 bench set: legs dominate by volume, not by count of exercises.
    const r = { ex: [{ id: 'squat', sets: 4 }, { id: 'bench', sets: 1 }] }
    expect(isLegDay(r, bp)).toBe(true)
  })

  it('treats exactly half as a leg day', () => {
    expect(isLegDay(HALF, bp)).toBe(true)
    expect(LEG_SHARE_THRESHOLD).toBe(0.5)
  })

  it('does not guess for a routine it cannot read', () => {
    expect(isLegDay(null, bp)).toBe(false)
    expect(isLegDay({ ex: [] }, bp)).toBe(false)
  })

  it('does not call a routine a leg day when nothing maps to a body part', () => {
    expect(isLegDay(LEGS, () => null)).toBe(false)
  })
})

describe('legDays', () => {
  const S = {
    week: { 1: ['legs'], 3: ['push'], 5: ['legs'] },
    routines: [LEGS, PUSH],
    bodyPartOf: bp
  }
  it('finds every leg day in a range', () => {
    const found = legDays(S, { from: '2026-09-21', to: '2026-09-27' })
    expect(found.map(f => f.d)).toEqual(['2026-09-21', '2026-09-25'])
  })
  it('names the routine, so a warning can say which one', () => {
    expect(legDays(S, { from: '2026-09-21', to: '2026-09-27' })[0].name).toBe('Leg Day')
  })
  it('is empty for a range with no leg work', () => {
    expect(legDays({ week: { 3: ['push'] }, routines: [PUSH], bodyPartOf: bp }, { from: '2026-09-21', to: '2026-09-27' })).toEqual([])
  })
  it('is empty when asked for nothing', () => {
    expect(legDays(S, {})).toEqual([])
    expect(legDays(null, { from: '2026-09-21', to: '2026-09-27' })).toEqual([])
  })
})

describe('nearestLegBefore', () => {
  const legs = [{ d: '2026-09-21', name: 'Leg Day' }, { d: '2026-09-25', name: 'Leg Day' }]
  it('finds the closest leg day before a date', () => {
    expect(nearestLegBefore(legs, '2026-09-26').d).toBe('2026-09-25')
    expect(nearestLegBefore(legs, '2026-09-26').gap).toBe(1)
  })
  it('ignores a leg day that comes after', () => {
    expect(nearestLegBefore(legs, '2026-09-20')).toBe(null)
  })
  it('answers null when there is none', () => {
    expect(nearestLegBefore([], '2026-09-26')).toBe(null)
  })
})

describe('checkWeek — the long run', () => {
  const session = (over = {}) => ({ id: 'x', d: '2026-09-23', type: 'long', km: 12, ...over })

  it('passes when the long run is 48 hours after the leg day', () => {
    const legs = [{ d: '2026-09-21', name: 'Leg Day' }]
    expect(checkWeek([session()], legs)).toEqual([])
  })

  it('blocks a long run the day after a leg day', () => {
    const legs = [{ d: '2026-09-22', name: 'Leg Day' }]
    const c = checkWeek([session()], legs)
    expect(c).toHaveLength(1)
    expect(c[0].kind).toBe('leg-long')
    expect(c[0].hours).toBe(24)
    expect(c[0].required).toBe(48)
  })

  it('blocks a long run on the same day as a leg day', () => {
    const legs = [{ d: '2026-09-23', name: 'Leg Day' }]
    expect(checkWeek([session()], legs)).toHaveLength(1)
  })

  it('says which leg day and how close it was', () => {
    const legs = [{ d: '2026-09-22', name: 'Leg Day' }]
    expect(checkWeek([session()], legs)[0].message).toContain('24 h')
    expect(checkWeek([session()], legs)[0].message).toContain('Leg Day')
  })

  it('checks the long run explicitly, not through the quality flag', () => {
    // The long run is not "quality" in the 80/20 sense, and riding on that flag is exactly how
    // the most important session ends up unprotected.
    const legs = [{ d: '2026-09-22', name: 'Leg Day' }]
    expect(checkWeek([session()], legs)).toHaveLength(1)
  })
})

describe('checkWeek — quality sessions', () => {
  it('blocks an interval session the day after a leg day', () => {
    const legs = [{ d: '2026-09-21', name: 'Leg Day' }]
    const c = checkWeek([{ id: 'i', d: '2026-09-22', type: 'interval' }], legs)
    expect(c).toHaveLength(1)
    expect(c[0].kind).toBe('leg-quality')
  })

  it('blocks an interval session on the leg day itself', () => {
    const legs = [{ d: '2026-09-22', name: 'Leg Day' }]
    expect(checkWeek([{ id: 'i', d: '2026-09-22', type: 'interval' }], legs)).toHaveLength(1)
  })

  it('passes an easy run the day after a leg day — active recovery is fine', () => {
    const legs = [{ d: '2026-09-21', name: 'Leg Day' }]
    expect(checkWeek([{ id: 'e', d: '2026-09-22', type: 'easy' }], legs)).toEqual([])
  })

  it('passes a recovery run the day after a leg day', () => {
    const legs = [{ d: '2026-09-21', name: 'Leg Day' }]
    expect(checkWeek([{ id: 'r', d: '2026-09-22', type: 'recovery' }], legs)).toEqual([])
  })

  it('treats strides as free — they do not spend a rule', () => {
    const legs = [{ d: '2026-09-21', name: 'Leg Day' }]
    expect(checkWeek([{ id: 's', d: '2026-09-22', type: 'strides' }], legs)).toEqual([])
  })
})

describe('checkWeek — deload slack', () => {
  it('allows 24 hours in a deload week, because the leg day is lighter too', () => {
    const legs = [{ d: '2026-09-22', name: 'Leg Day' }]
    const s = [{ id: 'x', d: '2026-09-23', type: 'long' }]
    expect(checkWeek(s, legs, { deload: true })).toEqual([])
    expect(checkWeek(s, legs)).toHaveLength(1)
  })

  it('still blocks a long run on the leg day itself, even in a deload', () => {
    const legs = [{ d: '2026-09-23', name: 'Leg Day' }]
    expect(checkWeek([{ id: 'x', d: '2026-09-23', type: 'long' }], legs, { deload: true })).toHaveLength(1)
  })
})

describe('checkWeek — several sessions', () => {
  it('reports every conflict, not just the first', () => {
    const legs = [{ d: '2026-09-21', name: 'Leg Day' }]
    const sessions = [
      { id: 'a', d: '2026-09-22', type: 'interval' },
      { id: 'b', d: '2026-09-22', type: 'long' }
    ]
    expect(checkWeek(sessions, legs)).toHaveLength(2)
  })

  it('is empty for a week with no leg days at all', () => {
    const sessions = [{ id: 'a', d: '2026-09-23', type: 'interval' }, { id: 'b', d: '2026-09-27', type: 'long' }]
    expect(checkWeek(sessions, [])).toEqual([])
  })

  it('is empty for no sessions', () => {
    expect(checkWeek([], [{ d: '2026-09-21', name: 'L' }])).toEqual([])
    expect(checkWeek(null, [])).toEqual([])
  })
})

describe('checkPlan', () => {
  const run = cleanRun({ run: { weeks: [
    { wk: 1, phase: 'base', sessions: [
      { id: 'a', d: '2026-09-22', type: 'interval', km: 8 },
      { id: 'b', d: '2026-09-27', type: 'long', km: 14 }
    ] }
  ] } })
  const S = { week: { 1: ['legs'] }, routines: [LEGS], bodyPartOf: bp }

  it('finds the conflict a week holds', () => {
    // Legs on Monday, intervals on Tuesday — 24 h, and the rule wants 48.
    const { conflicts } = checkPlan(run, S)
    expect(conflicts.length).toBeGreaterThan(0)
  })

  it('is empty for a week that respects the rules', () => {
    const clean = cleanRun({ run: { weeks: [
      { wk: 1, phase: 'base', sessions: [
        { id: 'a', d: '2026-09-24', type: 'interval', km: 8 },
        { id: 'b', d: '2026-09-27', type: 'long', km: 14 }
      ] }
    ] } })
    expect(checkPlan(clean, S).conflicts).toEqual([])
  })

  it('looks back before the week for a leg day it has to respect', () => {
    // Legs on the Friday *before* the plan starts; the first run is the following Monday.
    const S2 = { week: { 5: ['legs'] }, routines: [LEGS], bodyPartOf: bp }
    const r = cleanRun({ run: { weeks: [
      { wk: 1, phase: 'base', sessions: [{ id: 'a', d: '2026-09-28', type: 'interval', km: 8 }] }
    ] } })
    // 2026-09-25 is the Friday before; Monday the 28th is 72 h later, so it passes.
    expect(checkPlan(r, S2).conflicts).toEqual([])
  })

  it('handles a plan with nothing in it', () => {
    expect(checkPlan({ weeks: [] }, S).conflicts).toEqual([])
    expect(checkPlan(null, S).conflicts).toEqual([])
  })
})

describe('proximity', () => {
  it('reports how close each long run and quality session sits to a leg day', () => {
    const run = cleanRun({ run: { weeks: [
      { wk: 1, phase: 'base', sessions: [
        { id: 'a', d: '2026-09-23', type: 'long', km: 14 },
        { id: 'b', d: '2026-09-25', type: 'easy', km: 6 }
      ] }
    ] } })
    const S = { week: { 1: ['legs'] }, routines: [LEGS], bodyPartOf: bp }
    const p = proximity(run, S)
    // Only the long run is reported; an easy run is not a session the rule is about.
    expect(p).toHaveLength(1)
    expect(p[0].type).toBe('long')
    expect(p[0].hoursAfterLegDay).toBe(48)
  })

  it('says so when there is no leg day to be near', () => {
    const run = cleanRun({ run: { weeks: [
      { wk: 1, phase: 'base', sessions: [{ id: 'a', d: '2026-09-23', type: 'long', km: 14 }] }
    ] } })
    expect(proximity(run, { week: {}, routines: [], bodyPartOf: bp })[0].hoursAfterLegDay).toBe(null)
  })
})

describe('legVolumeMultiplier', () => {
  const run = cleanRun({ run: { weeks: [
    { wk: 1, phase: 'build', sessions: [
      { id: 'a', d: '2026-09-22', type: 'interval', km: 8 },
      { id: 'b', d: '2026-09-24', type: 'threshold', km: 10 },
      { id: 'c', d: '2026-09-27', type: 'long', km: 14 }
    ] },
    { wk: 2, phase: 'build', sessions: [
      { id: 'd', d: '2026-09-29', type: 'interval', km: 8 },
      { id: 'e', d: '2026-10-04', type: 'long', km: 14 }
    ] }
  ] } })

  it('brings leg volume down when two quality runs are in the week', () => {
    expect(legVolumeMultiplier(run, 1)).toBe(0.75)
  })
  it('leaves it alone with one quality run', () => {
    expect(legVolumeMultiplier(run, 2)).toBe(1)
  })
  it('leaves it alone for a week that does not exist', () => {
    expect(legVolumeMultiplier(run, 99)).toBe(1)
  })
})

describe('addIsoDays', () => {
  it('crosses a month boundary', () => {
    expect(addIsoDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addIsoDays('2026-09-21', -3)).toBe('2026-09-18')
  })
})
