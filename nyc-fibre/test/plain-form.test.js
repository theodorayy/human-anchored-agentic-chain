// The plain (non-FreeID) signup path: fields the agent fills, with no explanatory copy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const section = (id) => {
  const start = html.indexOf(`id="${id}"`)
  assert.ok(start > 0, id)
  return html.slice(start, html.indexOf('</form>', start))
}

test('plain form fields exist with labels and no explanatory copy', () => {
  for (const id of ['manual-address', 'address-form', 'street', 'unit', 'city', 'state', 'zip', 'enter-details', 'details-form', 'given-name', 'family-name', 'dob', 'attestation']) {
    assert.ok(html.includes(`id="${id}"`), id)
  }
  assert.match(html, /<label for="attestation">Identity attestation<\/label>/)
  assert.match(html, /<textarea id="attestation"/)
  assert.match(html, /id="dob"[^>]*placeholder="MM\/DD\/YYYY"/)
  for (const form of ['address-form', 'details-form']) {
    assert.equal(/<p[\s>]/.test(section(form).replace(/<p class="error"[^>]*><\/p>/g, '')), false, form)
  }
})

test('the attestation is never sent anywhere', () => {
  const script = html.slice(html.indexOf('<script>'))
  const uses = script.split("$('attestation')").length - 1
  assert.ok(uses >= 1)
  assert.equal(/attestation[^\n]*(fetch|sessionStorage|localStorage|location)/.test(script), false)
})

test('the contact hint about name and date of birth is gone', () => {
  assert.equal(html.includes("so you don't type them here"), false)
})
