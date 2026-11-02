// Masking the licence address for display: the server keeps the real address,
// the page only ever sees this form.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maskAddress } from '../api/_address.js'
import { LICENCE_FIELDS } from './fixtures.js'

test('masks street words and the unit, keeps city and state, and shortens the ZIP', () => {
  assert.equal(maskAddress(LICENCE_FIELDS.address), '1•• M••• St, Apt ••, New York, NY 100••')
})

test('keeps street suffixes and abbreviated directions as written, including barcode capitals', () => {
  assert.equal(
    maskAddress({ street_address: '350 W 42ND ST APT 12F', locality: 'NEW YORK', region: 'NY', postal_code: '10036-1234' }),
    '3•• W 4••• ST, APT •••, NEW YORK, NY 100••',
  )
  assert.equal(
    maskAddress({ street_address: '2 West Loop Road', locality: 'New York', region: 'NY', postal_code: '10044' }),
    '2•• W••• Loop Road, New York, NY 100••',
  )
})

test('handles # units, other designators and stray commas', () => {
  assert.equal(
    maskAddress({ street_address: '10 Elm Ave #3', locality: 'Brooklyn', region: 'NY', postal_code: '11201' }),
    '1•• E•• Ave, #••, Brooklyn, NY 112••',
  )
  assert.equal(
    maskAddress({ street_address: '77 Water St, Suite 1200', locality: 'New York', region: 'NY', postal_code: '10005' }),
    '7•• W•••• St, Suite ••••, New York, NY 100••',
  )
})

test('every masked word keeps only its first character', () => {
  const masked = maskAddress({ street_address: '1234 Roosevelt Island Main Street Apt 9Z', postal_code: '10044' })
  for (const hidden of ['1234', 'Roosevelt', 'Island', 'Main', '9Z', '10044']) assert.ok(!masked.includes(hidden), hidden)
  assert.equal(masked, '1••• R•••••••• I••••• M••• Street, Apt ••, 100••')
})

test('an unusual ZIP is fully masked and the country is dropped', () => {
  assert.equal(
    maskAddress({ street_address: '5 Oak Pl', locality: 'Albany', region: 'NY', postal_code: '12A45', country: 'USA' }),
    '5•• O•• Pl, Albany, NY •••••',
  )
})

test('no street means nothing to show', () => {
  assert.equal(maskAddress({ locality: 'New York', region: 'NY', postal_code: '10044' }), null)
  assert.equal(maskAddress({ street_address: '   ' }), null)
  assert.equal(maskAddress(null), null)
})
