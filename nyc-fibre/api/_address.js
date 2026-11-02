// Masks a licence address for display, so the page (and any agent driving it)
// can confirm "that's my place" without learning the address. Runs on the
// server only; the real address never leaves it.
//
//   { street_address: '1 Main St Apt 4B', locality: 'New York', region: 'NY', postal_code: '10044' }
//   → '1•• M••• St, Apt ••, New York, NY 100••'
//
// Rules:
// - Street words keep their first character; the rest become bullets (at least two).
// - Street-type suffixes (St, Ave, …) and abbreviated directions (N, SW, …) are kept.
// - A unit designator (Apt, Unit, Suite, Fl, #, …) is kept; the unit itself is fully bulleted.
// - City and state are shown as they are; the ZIP keeps its first three digits.
// - The country is dropped.

const BULLET = '•'
const STREET_SUFFIXES = new Set([
  'st', 'street', 'ave', 'av', 'avenue', 'rd', 'road', 'blvd', 'boulevard', 'pl', 'place',
  'ln', 'lane', 'dr', 'drive', 'ct', 'court', 'ter', 'terrace', 'pkwy', 'parkway', 'hwy',
  'highway', 'way', 'sq', 'square', 'plz', 'plaza', 'cir', 'circle', 'loop', 'tpke', 'expy',
])
const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'])
const UNIT_DESIGNATORS = new Set([
  'apt', 'apartment', 'unit', 'ste', 'suite', 'fl', 'floor', 'rm', 'room', 'bsmt', 'ph',
])

const bare = (token) => token.replace(/\.$/, '').toLowerCase()
const bullets = (count) => BULLET.repeat(Math.max(2, count))
const clean = (value) => (typeof value === 'string' ? value.replace(/[\s,]+/g, ' ').trim() : '')

function maskWord(word) {
  const chars = Array.from(word)
  return chars[0] + bullets(chars.length - 1)
}

function maskStreet(streetAddress) {
  const tokens = clean(streetAddress).split(' ').filter(Boolean)
  const unitAt = tokens.findIndex((token) => UNIT_DESIGNATORS.has(bare(token)) || token.startsWith('#'))
  const street = (unitAt === -1 ? tokens : tokens.slice(0, unitAt)).map((token) =>
    STREET_SUFFIXES.has(bare(token)) || DIRECTIONS.has(bare(token)) ? token : maskWord(token),
  )
  if (unitAt === -1) return street.join(' ')

  const [designator, ...unit] = tokens.slice(unitAt)
  let maskedUnit
  if (designator.startsWith('#')) {
    // '#4B' or '# 4B'
    const rest = [designator.slice(1), ...unit].filter(Boolean)
    maskedUnit = `#${rest.map((part) => bullets(Array.from(part).length)).join(' ') || bullets(0)}`
  } else {
    maskedUnit = [designator, ...unit.map((part) => bullets(Array.from(part).length))].join(' ')
  }
  return [street.join(' '), maskedUnit].filter(Boolean).join(', ')
}

function maskZip(postalCode) {
  const zip = clean(postalCode)
  if (!zip) return ''
  const match = /^(\d{3})\d{2}(?:-?\d{4})?$/.exec(zip)
  return match ? `${match[1]}${BULLET.repeat(2)}` : BULLET.repeat(5)
}

/**
 * @param {{ street_address?: string, locality?: string, region?: string, postal_code?: string }} address
 * @returns {string | null} the masked address, or null when there is no street to show
 */
export function maskAddress(address) {
  if (!address || typeof address !== 'object' || !clean(address.street_address)) return null
  const street = maskStreet(address.street_address)
  const locality = clean(address.locality)
  const stateZip = [clean(address.region), maskZip(address.postal_code)].filter(Boolean).join(' ')
  return [street, locality, stateZip].filter(Boolean).join(', ')
}
