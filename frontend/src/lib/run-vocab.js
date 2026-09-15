/* The nineteen running workout types, and what the app knows about each one.
 *
 * Mirror of `api/coach/run/vocab.js`, reduced to what the browser needs: the type names, the
 * structure a type starts from, which zone it is run at, and which types count as quality work.
 * The server holds the same table; `run-model.test.js` pins the key set so a type added on one
 * side and not the other fails a test rather than producing a card the other end cannot render.
 *
 * HYBRID: new file.
 */
import { KM_PER_MI } from './run-zones.js'

/** `[fast, slow]` percentages of threshold pace — the server's table, and the fixtures pin it. */
export const ZONE_PCT = {
  recovery:   [125, 140],
  easy:       [115, 130],
  marathon:   [103, 110],
  threshold:  [ 99, 103],
  interval:   [ 90,  98],
  repetition: [ 85,  92],
  race:       [ 95, 101],
  max:        [ 95, 100]
}
export const ZONES = Object.keys(ZONE_PCT)

export const UNITS = ['km', 'mi']

/** The thirty-minute threshold test — the first session of every plan. */
export const CALIBRATION = { type: 'threshold30', minutes: 30, steadyMinutes: 20 }

/**
 * The workout types. `zone` is the pace band a session of this type is run at; `quality` marks
 * the sessions that count against the 80/20 rule; `structure` is the repetition preset the
 * plan builder starts from.
 *
 * `interval` and `interval-time` are the same session in two units — metres on a track,
 * minutes on a treadmill. They are separate types rather than one type with a flag because the
 * switch between them is a legal, named change (`run-change-structure`), and a flag would make
 * "which unit is this session in" a question with two answers.
 */
export const WORKOUT_TYPES = {
  easy:         { zone: 'easy',       quality: false, structure: null },
  recovery:     { zone: 'recovery',   quality: false, structure: null },
  long:         { zone: 'easy',       quality: false, structure: null },
  tempo:        { zone: 'threshold',  quality: true,  structure: { rep: 1, timeSec: 1200, paceZone: 'threshold', restSec: 0 } },
  threshold:    { zone: 'threshold',  quality: true,  structure: { rep: 4, timeSec: 480, paceZone: 'threshold', restSec: 90 } },
  cruise:       { zone: 'threshold',  quality: true,  structure: { rep: 5, timeSec: 300, paceZone: 'threshold', restSec: 60 } },
  interval:     { zone: 'interval',   quality: true,  structure: { rep: 5, dist: 800, paceZone: 'interval', restSec: 90 } },
  'interval-time': { zone: 'interval', quality: true, structure: { rep: 5, timeSec: 180, paceZone: 'interval', restSec: 90 } },
  fartlek:      { zone: 'interval',   quality: true,  structure: { rep: 6, timeSec: 120, paceZone: 'interval', restSec: 60 } },
  hills:        { zone: 'interval',   quality: true,  structure: { rep: 8, timeSec: 60, paceZone: 'interval', restSec: 120 } },
  strides:      { zone: 'repetition', quality: false, structure: { rep: 6, timeSec: 25, paceZone: 'repetition', restSec: 60 } },
  progression:  { zone: 'threshold',  quality: true,  structure: null },
  'race-pace':  { zone: 'race',       quality: true,  structure: { rep: 4, dist: 1000, paceZone: 'race', restSec: 90 } },
  'time-trial': { zone: 'max',        quality: true,  structure: null },
  taper:        { zone: 'easy',       quality: false, structure: null },
  shakeout:     { zone: 'recovery',   quality: false, structure: null },
  'cross-train': { zone: null,        quality: false, structure: null },
  rest:         { zone: null,        quality: false, structure: null },
  race:         { zone: 'race',       quality: true,  structure: null }
}
export const RUN_TYPES = Object.keys(WORKOUT_TYPES)

/** The types a weekly plan is built from, in the order a picker shows them. */
export const TYPE_ORDER = [
  'easy', 'long', 'recovery', 'tempo', 'threshold', 'cruise', 'interval', 'interval-time',
  'fartlek', 'hills', 'strides', 'progression', 'race-pace', 'time-trial', 'taper',
  'shakeout', 'cross-train', 'race'
]

/** Whether a type counts as quality work (the 80/20 rule's numerator). */
export const isQuality = type => !!WORKOUT_TYPES[type]?.quality

/** Whether a type's structure is measured in distance — what the structure editor keys off. */
export const structureUnit = structure => {
  if (!Array.isArray(structure) || !structure.length) return null
  return structure[0].dist != null ? 'dist' : structure[0].timeSec != null ? 'time' : null
}

/** A short human label. The i18n pack can override these; they are the fallback. */
export const TYPE_LABEL = t => t
