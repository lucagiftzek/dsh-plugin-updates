// Regression: every agent tool result (success and error paths) must be lossless JSON by the DSH 0.2.1 rule.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fakeFetch, json, makeProfile, tmp } from './helpers.mjs'
import { assertLossless } from './lossless-check.mjs'
import { apply, agentTools } from '../lib/index.js'
import { createState } from '../lib/state.js'
import { normalizeSettings } from '../lib/config.js'
import { E } from '../lib/errors.js'

const fakeDefine = (def) => def
const ctx = () => new Proxy({ fiber: {}, effect: (fn) => fn(), inject: () => {}, get: () => null, on: () => {}, webServer: { register: () => () => {} }, tools: { register: () => () => {} } }, { get(t, k) { if (typeof k === 'symbol' || k in t) return t[k]; throw new TypeError(`no ${String(k)}`) } })

function realEngine(routes) {
  const profile = makeProfile({ deps: { 'dsh-better-sidebar': '^0.18.0', other: '^1.0.0' }, installed: { 'dsh-better-sidebar': '0.18.0', other: '1.0.0' } })
  const f = fakeFetch(routes)
  const state = createState({ dir: join(tmp(), 's') })
  return apply(ctx(), {}, { expose: true, fetch: f, profileDir: profile, state, defineTool: null }).engine
}
const okRoute = [/registry\.npmjs\.org\/dsh-better-sidebar/, () => json({ 'dist-tags': { latest: '0.18.1' }, versions: { '0.18.0': {}, '0.18.1': { engines: { dsh: '>=0.1.5-rc.1 <0.3.0' } } } })]
const limited = [/registry\.npmjs\.org\/other/, { status: 429, headers: { 'retry-after': '30' }, body: '{}' }]

const throwing = (err) => ({ doctor: async () => ({ status: 'fail', checks: [] }), refresh: () => { throw err }, sweep: async () => { throw err }, status: () => ({ checkedAt: null }), list: () => [], items: () => [] })

async function run(engine, argsList) {
  const defs = agentTools(fakeDefine, () => normalizeSettings({}), { engine })
  assert.deepEqual(defs.map((d) => d.name), ['plugin_updates', 'plugin_updates_doctor'])
  for (const d of defs) for (const args of argsList) {
    const out = await d.execute(args)
    await assertLossless(out, `${d.name}(${JSON.stringify(args)})`)
  }
}
const ARGS = [{}, { scope: 'all' }, { scope: 'safe' }, { scope: 'outdated' }, { scope: 'held' }, { scope: 'local' }, { package: 'nope', scope: 'all' }, { package: 'dsh-better-sidebar' }, { refresh: true }, { refresh: true, scope: 'all' }]

test('success path with healthy and rate-limited registry rows is lossless', async () => {
  const e = realEngine([okRoute, limited])
  await e.sweep()
  await run(e, ARGS)
})

test('refresh error paths (cooldown, disabled, rate limit, unexpected) are lossless', async () => {
  const e = realEngine([okRoute, limited])
  await e.sweep()
  try { await e.refresh() } catch { /* cooldown */ } // leaves the engine inside the cooldown window
  await run(e, [{ refresh: true }])
  const errs = [
    E.raise('PLUPD_REFRESH_COOLDOWN', { retryAfterSec: undefined }),
    E.raise('PLUPD_GITHUB_RATE_LIMITED', { retryAfterSec: undefined, detail: undefined }),
    E.raise('PLUPD_REGISTRY_UNREACHABLE', { retryAfterSec: 12, detail: undefined }),
    E.raise('PLUPD_DISABLED'),
    new Error('boom'), new TypeError('x is not a function'), Object.assign(new Error('with code'), { code: 'ECONNRESET', errno: -104 }),
    { message: 'plain object thrown' }, 'a string thrown', undefined, null, 42,
  ]
  for (const err of errs) await run(throwing(err), [{ refresh: true }, {}, { scope: 'all' }])
})

test('engine returning odd values (undefined fields, NaN, Date) is sanitized at the tool boundary', async () => {
  const row = { name: 'p', kind: 'registry', installed: '1.0.0', latest: undefined, status: 'update-compatible', reason: undefined, candidate: { version: '1.1.0', ref: undefined }, links: { npm: undefined }, retryAfterSec: undefined }
  const engine = { status: () => ({ checkedAt: undefined, running: { version: undefined, line: NaN }, summary: { safe: 1, total: 1 }, noGate: false }), list: () => [row], items: () => [row], refresh: async () => {}, sweep: async () => {}, doctor: async () => ({ status: 'ok', checks: [{ id: 'x', detail: undefined, at: new Date() }], n: -0 }) }
  await run(engine, ARGS)
})
