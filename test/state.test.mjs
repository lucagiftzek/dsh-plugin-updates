import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createState } from '../lib/state.js'
import { tmp } from './helpers.mjs'

test('state is written atomically (no temp file left) with mode 0600 and survives a reload', async () => {
  const dir = join(tmp(), 's')
  const s = createState({ dir })
  s.data.ignored.pkg = '1.2.3'
  await s.save()
  assert.deepEqual(readdirSync(dir), ['state.json'])
  assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600)
  const s2 = createState({ dir })
  await s2.load()
  assert.equal(s2.data.ignored.pkg, '1.2.3')
})

test('a corrupt state file starts empty instead of throwing', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'state.json'), '{not json')
  const s = createState({ dir })
  await s.load()
  assert.deepEqual(s.data.ignored, {})
})

test('a failed write is recorded as PLUPD_STATE_WRITE_FAILED and memory state survives', async () => {
  const base = tmp()
  const dir = join(base, 'ro')
  mkdirSync(dir)
  chmodSync(dir, 0o500)
  const lines = []
  const s = createState({ dir: join(dir, 'sub'), warn: (m) => lines.push(m) })
  s.data.ignored.x = '1'
  await s.save()
  chmodSync(dir, 0o700)
  if (process.getuid && process.getuid() === 0) return // root can write anywhere
  assert.ok(s.lastWriteError)
  assert.match(lines[0], /^PLUPD_STATE_WRITE_FAILED/)
  assert.equal(s.data.ignored.x, '1')
})

test('old etag entries and expired snoozes are pruned on save', async () => {
  const dir = tmp()
  const now = () => 100 * 86400000
  const s = createState({ dir, now })
  s.data.etags.old = { etag: 'x', data: 1, at: 1 }
  s.data.etags.fresh = { etag: 'y', data: 2, at: now() }
  s.data.snoozed.gone = 5
  await s.save()
  const j = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.deepEqual(Object.keys(j.etags), ['fresh'])
  assert.deepEqual(j.snoozed, {})
})
