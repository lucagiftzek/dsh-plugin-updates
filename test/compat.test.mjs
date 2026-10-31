import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gate, decide, isHeld, reduceMeta } from '../lib/compat.js'
import { SEED_HOLDS } from '../lib/config.js'
import { sv } from './helpers.mjs'

// Real registry data trimmed to the gate fields (test/fixtures/registry.json).
const fx = JSON.parse(readFileSync(new URL('./fixtures/registry.json', import.meta.url), 'utf8'))
const cands = (n) => Object.entries(fx[n].versions).map(([version, meta]) => ({ version, meta }))
const run = (name, installed, running, extra = {}) => decide(cands(name), { sv, running, installed, hold: SEED_HOLDS[name], ...extra })

const H015 = '0.1.5-rc.1'
const H021 = '0.2.1-rc.5'

test('gate rule: engines.dsh decides alone, otherwise every dsh peer must match', () => {
  assert.equal(gate(sv, H015, { e: '>=0.1.5-rc.1 <0.3.0', p: { '@deepseek-ai/dsh-tools': '^0.2.1-rc.1' } }).verdict, 'pass')
  assert.equal(gate(sv, H015, { p: { '@deepseek-ai/dsh-tools': '^0.1.5-rc.1', '@deepseek-ai/dsh-llm': '^0.2.1-rc.1' } }).verdict, 'fail')
  assert.equal(gate(sv, H015, {}).verdict, 'none')
  assert.equal(gate(sv, '', { e: '>=0.1.0' }).verdict, 'unknown')
})

test('prereleases count: a final-only range refuses an rc, a -0 range accepts it', () => {
  assert.equal(gate(sv, H021, { e: '>=0.2.1' }).verdict, 'fail')
  assert.equal(gate(sv, H021, { e: '>=0.2.1-0 <0.3.0' }).verdict, 'pass')
  assert.equal(gate(sv, '0.2.1', { e: '>=0.2.1' }).verdict, 'pass')
})

test('failure direction: below the range needs a newer core, above needs an older one', () => {
  assert.equal(gate(sv, H015, { e: '>=0.2.1-0 <0.3.0' }).direction, 'newer')
  assert.equal(gate(sv, '0.3.1', { e: '>=0.1.0 <0.3.0' }).direction, 'older')
})

test('better-sidebar 0.18 vs 0.28.2: a 0.2.x-only build is never offered to a 0.1.5 host', () => {
  const a = run('dsh-better-sidebar', '0.18.0', H015)
  assert.equal(a.latest.version, '0.28.2')
  assert.notEqual(a.candidate.version, '0.28.2')
  assert.equal(a.blockedLatest.version, '0.28.2')
  assert.equal(a.blockedLatest.direction, 'newer')
  assert.ok(sv.lt(a.candidate.version, '0.19.0'), 'only the 0.18 line stays on offer (0.19 to 0.27 are holds)')
  const b = run('dsh-better-sidebar', '0.18.0', H021)
  assert.equal(b.candidate.version, '0.28.2')
  assert.equal(b.status, 'update-compatible')
})

test('better-sidebar stepping stones are held, not offered', () => {
  const a = run('dsh-better-sidebar', '0.18.1', H021)
  assert.ok(a.heldVersions.includes('0.19.1'))
  assert.ok(!a.heldVersions.includes('0.28.2'))
  assert.equal(isHeld(sv, H021, SEED_HOLDS['dsh-better-sidebar'], '0.19.1'), true)
  assert.equal(isHeld(sv, H021, SEED_HOLDS['dsh-better-sidebar'], '0.28.2'), false)
})

test('element-source 0.1.1 vs 0.2.x: 0.2.x is held on both hosts, 0.1.1 is the offer', () => {
  for (const host of [H015, H021]) {
    const d = run('dsh-element-source', '0.1.0', host)
    assert.equal(d.candidate.version, '0.1.1', host)
    assert.deepEqual(d.heldVersions.sort(), ['0.2.0', '0.2.1'])
    assert.equal(d.status, 'update-compatible')
  }
})

test('dsh-github: 0.7.28 is not offered to 0.1.5 (engines), and the conditional hold cuts the 0.1.7-line builds', () => {
  const g = gate(sv, H015, fx['@perrylink/dsh-github'].versions['0.7.28'])
  assert.equal(g.verdict, 'fail')
  assert.equal(g.source, 'engines')
  const a = run('@perrylink/dsh-github', '0.7.4', H015)
  assert.ok(sv.lte(a.candidate.version, '0.7.10'), 'got ' + a.candidate.version)
  const b = run('@perrylink/dsh-github', '0.7.4', H021)
  assert.equal(b.candidate.version, '0.7.28')
})

test('continue: the hold applies on 0.1.x only', () => {
  const a = run('@weibaohui/dsh-continue', '0.3.0', H015)
  assert.ok(sv.lt(a.candidate.version, '0.3.2'))
  const b = run('@weibaohui/dsh-continue', '0.3.0', H021)
  assert.equal(b.candidate.version, '0.3.12')
})

test('a package that declares nothing is "verify by hand", never "compatible"', () => {
  const d = run('dsh-image-gen', '0.8.0', H015)
  assert.equal(d.status, 'no-declared-range')
})

test('needs-newer-core when every newer version is out of range', () => {
  const d = decide([{ version: '2.0.0', meta: { e: '>=0.2.1-0 <0.3.0' } }], { sv, running: H015, installed: '1.0.0' })
  assert.equal(d.status, 'update-needs-newer-core')
  assert.equal(d.candidate.version, '2.0.0')
})

test('deprecated, prerelease and older versions are never offered', () => {
  const d = decide([
    { version: '1.2.0', meta: { d: 1 } }, { version: '1.3.0-rc.1', meta: {} }, { version: '0.9.0', meta: {} },
  ], { sv, running: H015, installed: '1.0.0' })
  assert.equal(d.status, 'up-to-date')
})

test('ignore a version and snooze a package', () => {
  const o = { sv, running: H021, installed: '0.7.4' }
  const base = decide(cands('@perrylink/dsh-github'), { ...o, userState: {} })
  const ign = decide(cands('@perrylink/dsh-github'), { ...o, userState: { ignored: base.candidate.version } })
  assert.equal(ign.status, 'ignored')
  const newer = decide(cands('@perrylink/dsh-github'), { ...o, userState: { ignored: '0.7.5' } })
  assert.equal(newer.status, 'update-compatible', 'ignoring an older version does not hide a newer one')
  const sn = decide(cands('@perrylink/dsh-github'), { ...o, now: 1000, userState: { snoozedUntil: 5000 } })
  assert.equal(sn.status, 'snoozed')
  const expired = decide(cands('@perrylink/dsh-github'), { ...o, now: 9000, userState: { snoozedUntil: 5000 } })
  assert.equal(expired.status, 'update-compatible')
})

test('unknown running version never yields "compatible"', () => {
  const d = run('@kenz1117/dsh-ui-usage-billing', '1.4.13', '')
  assert.equal(d.status, 'unknown')
})

test('reduceMeta keeps only the gate fields', () => {
  const m = reduceMeta({ engines: { dsh: '>=1', node: '>=20' }, peerDependencies: { react: '18', '@deepseek-ai/dsh-tools': '^1' }, deprecated: 'x', description: 'long text' })
  assert.deepEqual(m, { e: '>=1', p: { '@deepseek-ai/dsh-tools': '^1' }, d: 1 })
})
