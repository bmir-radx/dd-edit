/**
 * UCUM unit assistance for the Unit field: a curated list of the UCUM codes
 * that actually occur in research data dictionaries (autocomplete), plus a
 * mapping from common informal spellings ("years", "mmHg", "bpm") to their
 * UCUM equivalent so we can offer the correction.
 *
 * Deliberately not a full UCUM engine — the spec's Unit field is free text,
 * so this only assists; it never blocks a value.
 */

export interface UcumUnit {
  code: string
  name: string
}

export const UCUM_UNITS: UcumUnit[] = [
  // time
  { code: 'a', name: 'year' },
  { code: 'mo', name: 'month' },
  { code: 'wk', name: 'week' },
  { code: 'd', name: 'day' },
  { code: 'h', name: 'hour' },
  { code: 'min', name: 'minute' },
  { code: 's', name: 'second' },
  { code: 'ms', name: 'millisecond' },
  // mass
  { code: 'kg', name: 'kilogram' },
  { code: 'g', name: 'gram' },
  { code: 'mg', name: 'milligram' },
  { code: 'ug', name: 'microgram' },
  { code: 'ng', name: 'nanogram' },
  { code: '[lb_av]', name: 'pound' },
  { code: '[oz_av]', name: 'ounce' },
  // length
  { code: 'm', name: 'meter' },
  { code: 'cm', name: 'centimeter' },
  { code: 'mm', name: 'millimeter' },
  { code: 'km', name: 'kilometer' },
  { code: '[in_i]', name: 'inch' },
  { code: '[ft_i]', name: 'foot' },
  // volume
  { code: 'L', name: 'liter' },
  { code: 'dL', name: 'deciliter' },
  { code: 'mL', name: 'milliliter' },
  { code: 'uL', name: 'microliter' },
  // concentration / lab
  { code: 'mg/dL', name: 'milligram per deciliter' },
  { code: 'g/dL', name: 'gram per deciliter' },
  { code: 'g/L', name: 'gram per liter' },
  { code: 'mmol/L', name: 'millimole per liter' },
  { code: 'mol/L', name: 'mole per liter' },
  { code: 'umol/L', name: 'micromole per liter' },
  { code: 'ng/mL', name: 'nanogram per milliliter' },
  { code: 'ug/mL', name: 'microgram per milliliter' },
  { code: 'pg/mL', name: 'picogram per milliliter' },
  { code: 'mEq/L', name: 'milliequivalent per liter' },
  { code: 'U/L', name: 'enzyme unit per liter' },
  { code: '[IU]/L', name: 'international unit per liter' },
  { code: '[IU]/mL', name: 'international unit per milliliter' },
  { code: 'mmol/mol', name: 'millimole per mole' },
  { code: '10*9/L', name: 'billion per liter (cell count)' },
  { code: '10*6/uL', name: 'million per microliter (cell count)' },
  { code: '10*3/uL', name: 'thousand per microliter (cell count)' },
  // rates
  { code: '/min', name: 'per minute' },
  { code: '/h', name: 'per hour' },
  { code: '/d', name: 'per day' },
  { code: '/wk', name: 'per week' },
  { code: '/mo', name: 'per month' },
  { code: '/a', name: 'per year' },
  { code: '/s', name: 'per second' },
  { code: '{beats}/min', name: 'beats per minute' },
  { code: '{breaths}/min', name: 'breaths per minute' },
  { code: 'mL/min', name: 'milliliter per minute' },
  { code: 'mL/min/{1.73_m2}', name: 'mL/min per 1.73 m² (eGFR)' },
  // pressure, temperature, energy
  { code: 'mm[Hg]', name: 'millimeter of mercury' },
  { code: 'kPa', name: 'kilopascal' },
  { code: 'Cel', name: 'degree Celsius' },
  { code: '[degF]', name: 'degree Fahrenheit' },
  { code: 'kcal', name: 'kilocalorie' },
  { code: 'kJ', name: 'kilojoule' },
  // body / composite
  { code: 'kg/m2', name: 'kilogram per square meter (BMI)' },
  { code: 'm2', name: 'square meter (body surface area)' },
  { code: 'mg/kg', name: 'milligram per kilogram (dose)' },
  // dimensionless
  { code: '%', name: 'percent' },
  { code: '1', name: 'dimensionless' },
]

const BY_CODE = new Map(UCUM_UNITS.map((u) => [u.code, u]))

/** The curated entry for an exact UCUM code, or undefined. */
export function ucumUnit(code: string): UcumUnit | undefined {
  return BY_CODE.get(code.trim())
}

/** Common informal spellings → the UCUM code to suggest. Keys lowercase. */
const INFORMAL: Record<string, string> = {
  years: 'a', year: 'a', yr: 'a', yrs: 'a',
  months: 'mo', month: 'mo', mos: 'mo',
  weeks: 'wk', week: 'wk', wks: 'wk',
  days: 'd', day: 'd',
  hours: 'h', hour: 'h', hr: 'h', hrs: 'h',
  minutes: 'min', minute: 'min', mins: 'min',
  seconds: 's', second: 's', sec: 's', secs: 's',
  percent: '%', pct: '%',
  pounds: '[lb_av]', pound: '[lb_av]', lb: '[lb_av]', lbs: '[lb_av]',
  ounces: '[oz_av]', ounce: '[oz_av]', oz: '[oz_av]',
  inches: '[in_i]', inch: '[in_i]', in: '[in_i]',
  feet: '[ft_i]', foot: '[ft_i]', ft: '[ft_i]',
  celsius: 'Cel', '°c': 'Cel', degc: 'Cel',
  fahrenheit: '[degF]', '°f': '[degF]', degf: '[degF]',
  liters: 'L', liter: 'L', litres: 'L', litre: 'L',
  milliliters: 'mL', milliliter: 'mL', cc: 'mL',
  grams: 'g', gram: 'g',
  kilograms: 'kg', kilogram: 'kg', kgs: 'kg',
  milligrams: 'mg', milligram: 'mg',
  mcg: 'ug', micrograms: 'ug', microgram: 'ug',
  mmhg: 'mm[Hg]', 'mm hg': 'mm[Hg]',
  bpm: '{beats}/min',
  iu: '[IU]',
  meters: 'm', meter: 'm', metres: 'm', metre: 'm',
  centimeters: 'cm', centimeter: 'cm',
  // rate words and "per …" phrasings (also handled compositionally below)
  'per annum': '/a', yearly: '/a', annually: '/a',
  monthly: '/mo', weekly: '/wk', daily: '/d', hourly: '/h',
  'beats/min': '{beats}/min', 'breaths/min': '{breaths}/min',
  // common misprints / regional spellings
  'years old': 'a',
  millimeters: 'mm', millimeter: 'mm', millimetres: 'mm', millimetre: 'mm',
  milimeter: 'mm', milimeters: 'mm',
  centimetres: 'cm', centimetre: 'cm',
  kilometers: 'km', kilometer: 'km', kilometres: 'km', kilometre: 'km',
  millilitres: 'mL', millilitre: 'mL', mililiter: 'mL', mililiters: 'mL',
  deciliter: 'dL', deciliters: 'dL', decilitre: 'dL', decilitres: 'dL',
  microliter: 'uL', microliters: 'uL', microlitre: 'uL', microlitres: 'uL',
  nanogram: 'ng', nanograms: 'ng',
  gramme: 'g', grammes: 'g', gm: 'g', gms: 'g',
  kilogramme: 'kg', kilogrammes: 'kg',
  mgs: 'mg', ltr: 'L',
  'degrees celsius': 'Cel', 'degrees fahrenheit': '[degF]',
  'per cent': '%', percentage: '%',
  // micro-sign variants (both U+00B5 and U+03BC show up in pasted data)
  µg: 'ug', μg: 'ug', 'µg/ml': 'ug/mL', 'μg/ml': 'ug/mL',
  µl: 'uL', μl: 'uL', 'µmol/l': 'umol/L', 'μmol/l': 'umol/L',
  // exponent notations
  m2: 'm2', 'm^2': 'm2', 'm²': 'm2', 'kg/m^2': 'kg/m2', 'kg/m²': 'kg/m2',
  // case fixes — UCUM is case-sensitive, and these get typed lowercase a lot
  // (a correctly-cased value lowercases onto itself and yields no suggestion)
  l: 'L', ml: 'mL', dl: 'dL', ul: 'uL',
  'mg/dl': 'mg/dL', 'g/dl': 'g/dL', 'g/l': 'g/L',
  'mmol/l': 'mmol/L', 'mol/l': 'mol/L', 'umol/l': 'umol/L',
  'ng/ml': 'ng/mL', 'ug/ml': 'ug/mL', 'pg/ml': 'pg/mL',
  'meq/l': 'mEq/L', 'u/l': 'U/L', 'iu/l': '[IU]/L', 'iu/ml': '[IU]/mL',
  cel: 'Cel', kpa: 'kPa',
}

// Case-insensitive code lookup, for token resolution ("ML" -> mL).
const CODE_BY_LOWER = new Map<string, string>()
for (const u of UCUM_UNITS) {
  if (!CODE_BY_LOWER.has(u.code.toLowerCase())) CODE_BY_LOWER.set(u.code.toLowerCase(), u.code)
}

// A curated unit's human-readable name is itself a common way to write the
// unit ("beats per minute", "millimeter of mercury") — resolve those too.
const CODE_BY_NAME = new Map<string, string>()
for (const u of UCUM_UNITS) {
  if (!CODE_BY_NAME.has(u.name.toLowerCase())) CODE_BY_NAME.set(u.name.toLowerCase(), u.code)
}

/** Resolve one token (a code, an informal spelling, or a miscased code). */
function resolveUnitToken(token: string): UcumUnit | null {
  const t = token.trim()
  if (t === '') return null
  const exact = BY_CODE.get(t)
  if (exact !== undefined) return exact
  const informal = INFORMAL[t.toLowerCase()]
  if (informal !== undefined) return BY_CODE.get(informal) ?? { code: informal, name: informal }
  const ci = CODE_BY_LOWER.get(t.toLowerCase())
  return ci !== undefined ? (BY_CODE.get(ci) ?? null) : null
}

/** Prefer the curated entry for a composed code; else synthesize one. */
function composed(code: string, name: string): UcumUnit {
  return BY_CODE.get(code) ?? { code, name }
}

/**
 * A UCUM suggestion for an informal unit spelling, or null when the value is
 * already the suggested code / has no known mapping. Case-insensitive on the
 * informal side (UCUM itself is case-sensitive, e.g. mL vs ml). Beyond the
 * spelling table, three compositional shapes resolve from their parts:
 * "per year" → /a, "mg per dl" → mg/dL, and slash compounds of informal
 * tokens ("mcg/ml" → ug/mL).
 */
export function ucumSuggestion(value: string): UcumUnit | null {
  const raw = value.trim()
  if (raw === '') return null
  // Normalize the noise misprints share: trailing periods ("hr."), runs of
  // whitespace. The original text still decides the ≠-suggestion guard.
  const norm = raw.replace(/\.+$/, '').replace(/\s+/g, ' ')
  const lower = norm.toLowerCase()

  let unit: UcumUnit | null = null
  const direct = INFORMAL[lower] ?? CODE_BY_NAME.get(lower)
  if (direct !== undefined) {
    unit = BY_CODE.get(direct) ?? { code: direct, name: direct }
  } else if (lower.startsWith('per ')) {
    const base = resolveUnitToken(norm.slice(4))
    if (base !== null) unit = composed(`/${base.code}`, `per ${base.name}`)
  } else {
    const perParts = norm.split(/ per /i)
    const slashParts = norm.split('/')
    const parts = perParts.length === 2 ? perParts : slashParts.length === 2 ? slashParts : null
    if (parts !== null) {
      const left = resolveUnitToken(parts[0])
      const right = resolveUnitToken(parts[1])
      if (left !== null && right !== null) {
        unit = composed(`${left.code}/${right.code}`, `${left.name} per ${right.name}`)
      }
    }
  }

  if (unit === null || unit.code === raw) return null
  return unit
}
