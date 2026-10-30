import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let personas
let data
before(async () => {
  data = mkdtempSync(join(tmpdir(), 'aurabot-personas-'))
  process.env.AURABOT_DATA_DIR = data
  personas = await import('../src/persona/personas.js')
})

test('deleting a bundled persona keeps it deleted after refreshing the list', () => {
  personas.seedPersonas()
  const file = join(data, 'personas', 'dafeiyu_ayu.md')
  assert.equal(existsSync(file), true)
  personas.deletePersona('dafeiyu_ayu')
  assert.equal(existsSync(file), false)
  assert.equal(personas.listPersonas().some((p) => p.id === 'dafeiyu_ayu'), false)
  assert.equal(existsSync(file), false)
})
