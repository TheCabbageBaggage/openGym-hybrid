/* Pace zones and pace formatting, on the client.
 *
 * Mirror of `api/coach/run/zones.js`. The single most misreadable thing in this feature is the
 * direction of a pace band: a *slower* pace is a *larger* number of seconds per kilometre, so
 * `easy: [345, 390]` means "between 5:45 and 6:30" — fastest number first. That direction is
 * fixed here once, in `zonesFrom`, and every reader goes through `zoneOf` or `targetPace`
 * rather than doing arithmetic on the bounds.
 *
 * HYBRID: new file.
 */
import { ZONE_PCT, ZONES } from './run-vocab.js'

export const KM_PER_MI = 1.609344
const isNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * The zone table for a threshold pace, in seconds per kilometre, fastest bound first.
 * `null` when there is no threshold pace — and that is meaningful: a plan with no zones cannot
 * prescribe a pace, and every caller has to handle that rather than defaulting to zero.
 */
export function zonesFrom(thresholdPace) {
  if (!isNum(thresholdPace)) return null
  const out = {}
  for (const z of ZONES) {
    const [fastPct, slowPct] = ZONE_PCT[z]
    out[z] = [
      Math.round(thresholdPace * fastPct / 100),
      Math.round(thresholdPace * slowPct / 100)
    ]
  }
  return out
}

/**
 * Which zone a pace falls in. Bands overlap on purpose (recovery 125–140 and easy 115–130 share
 * 125–130), so the tie-break is the fixed ZONES order and the first match wins — otherwise the
 * same run classifies differently on two devices.
 */
export function zoneOf(paceSec, paceZones) {
  if (!isNum(paceSec) || !paceZones) return null
  for (const z of ZONES) {
    const band = paceZones[z]
    if (band && paceSec >= band[0] && paceSec <= band[1]) return z
  }
  return paceSec < (paceZones.interval?.[0] ?? Infinity) ? 'repetition' : 'recovery'
}

/** The pace to run a session at, from its zone. Falls back to easy when the zone is unknown. */
export function targetPace(type, zone, paceZones) {
  const band = paceZones?.[zone] || paceZones?.easy
  if (!band) return null
  return Math.round((band[0] + band[1]) / 2)
}

/* ============================ unit conversion ============================ */
// Storage is kilometres and seconds per kilometre, always. The unit switch happens here and
// nowhere else — a plan built in miles and one built in kilometres are the same plan.

export const unitScale = unit => (unit === 'mi' ? KM_PER_MI : 1)
export const toDisplayPace = (secPerKm, unit) => (unit === 'mi' ? secPerKm * KM_PER_MI : secPerKm)
export const toDisplayDist = (km, unit) => (unit === 'mi' ? km / KM_PER_MI : km)
export const fromDisplayDist = (v, unit) => (unit === 'mi' ? v * KM_PER_MI : v)

/** `300` → `"5:00"`. Seconds per unit, formatted to mm:ss. */
export function displayPace(secPerKm, unit = 'km') {
  const s = Math.round(toDisplayPace(secPerKm, unit))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** `300, 'km'` → `"5:00 /km"`. The label the views show on a session card. */
export const paceLabel = (secPerKm, unit = 'km') =>
  secPerKm ? `${displayPace(secPerKm, unit)} /${unit}` : null

/** `8.4, 'km'` → `"8.4"`; in miles `"5.2"`. One decimal, no unit suffix. */
export const distLabel = (km, unit = 'km') => {
  const v = toDisplayDist(km, unit)
  return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
}

/** A zone band as a readable range: `"5:45–6:30"`. */
export function bandLabel(band, unit = 'km') {
  if (!band) return null
  return `${displayPace(band[0], unit)}–${displayPace(band[1], unit)}`
}

/** A structure repetition as one line: `"6 x 800 m @ 4:45 /km · 90 s rest"`. */
export function structureLine(r, unit = 'km', paceZones = null) {
  if (!r) return ''
  const work = r.dist
    ? `${r.rep} x ${Math.round(toDisplayDist(r.dist / 1000, unit) * 1000)} m`
    : `${r.rep} x ${displayPace(r.timeSec, 'km').replace(':', ' min ')}${r.timeSec % 60 === 0 ? '' : ' s'}`
  const zone = r.paceZone && paceZones?.[r.paceZone] ? ` @ ${bandLabel(paceZones[r.paceZone], unit)} /${unit}` : ''
  const rest = r.restSec ? ` · ${r.restSec} s rest` : ''
  return `${work}${zone}${rest}`
}
