import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fakeFetch, json, makeProfile, tmp, sv } from './helpers.mjs'
import plugin, { apply, Config, agentTools } from '../lib/index.js'
import { createState } from '../lib/state.js'
import { DEFAULTS, normalizeSettings } from '../lib/config.js'

const SECRET = 'ghp_FAKE_DOCTOR_TEST_VALUE'

function fakeReq(method, url, { headers = {}, body } = {}) {
  const req = new EventEmitter()
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:3080', ...headers }, socket: { remoteAddress: '127.0.0.1' } })
  req.destroy = () => {}
  let flowing = false
  const on = req.on.bind(req)
  req.on = (ev, fn) => { on(ev, fn); if (ev === 'data' && !flowing) { flowing = true; setImmediate(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }) } return req }
  return req
}
const fakeRes = () => ({ statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v }, end(b) { this.body = b ? String(b) : '' }, get json() { return JSON.parse(this.body) } })
const GUARD = { 'x-requested-with': 'dsh-plugin-updates', 'content-type': 'application/json' }

/** A ctx that throws on services it did not inject, like DSH 0.2.x. */
function makeCtx(extra = {}) {
  const effects = []; const routes = []; const tools = []
  const base = {
    fiber: {}, effect: (fn, label) => { const d = fn(); effects.push({ label, d }); return d },
    inject: () => {}, get: () => null, on: () => {},
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    tools: { register: (def) => { tools.push(def); return () => {} } },
    loader: { entries: () => [{ fiber: base.fiber, options: { id: 'plugin-updates', name: 'dsh-plugin-updates' } }], await: () => Promise.resolve() },
    ...extra,
  }
  const ctx = new Proxy(base, { get(t, k) { if (typeof k === 'symbol' || k in t) return t[k]; throw new TypeError(`cannot get "${String(k)}" without inject`) } })
  return { ctx, effects, routes, tools }
}

function boot(ctxExtra, config = {}, o = {}) {
  const profile = makeProfile({ deps: { 'dsh-better-sidebar': '^0.18.0' }, installed: { 'dsh-better-sidebar': '0.18.0' } })
  const f = fakeFetch([[/registry\.npmjs\.org\/dsh-better-sidebar/, () => json({ 'dist-tags': { latest: '0.18.1' }, versions: { '0.18.0': {}, '0.18.1': { engines: { dsh: '>=0.1.5-rc.1 <0.3.0' } } } })]])
  const h = makeCtx(ctxExtra)
  const state = createState({ dir: join(tmp(), 's') })
  const exposed = apply(h.ctx, config, { expose: true, fetch: f, profileDir: profile, state, defineTool: null, ...o })
  return { ...h, ...exposed, f, profile }
}
const call = async (b, method, path, opts) => { const res = fakeRes(); await b.routes[0].handler(fakeReq(method, '/dsh-plugin-updates/api' + path, opts), res); return res }

test('default export is an object with Config (the 0.2.x loader reads Config from it)', () => {
  assert.equal(typeof plugin, 'object')
  assert.equal(plugin.Config, Config)
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['settings', 'webServer', 'tools'])
  assert.ok(Config, 'the harness schemastery was found')
})

test('Config declares every setting; all are live when the harness schemastery supports it (0.2.x), none otherwise (0.1.5)', () => {
  const dict = Config.dict
  for (const k of Object.keys(DEFAULTS)) assert.ok(dict[k], 'declared ' + k)
  const live = Object.values(dict).filter((x) => x.meta && x.meta.volatile).length
  assert.ok(live === 0 || live === Object.keys(DEFAULTS).length, 'live fields: ' + live)
})

test('DSH 0.1.5 settings: register mode, live scope drives behaviour, route writes through the scope', async () => {
  const values = { ...DEFAULTS }
  const seen = {}
  const scope = { get: () => values, update: async (p) => { Object.assign(values, p) }, watch: () => () => {} }
  const b = boot({ settings: { register: (ns, schema, opts) => { seen.ns = ns; seen.base = opts.base; return scope } } })
  assert.equal(b.store.mode, 'register')
  assert.equal(seen.ns, 'dsh-plugin-updates')
  assert.equal(seen.base.intervalHours, 12)
  const view = (await call(b, 'GET', '/settings')).json
  assert.equal(view.mode, 'register'); assert.equal(view.writable, true)
  const r = await call(b, 'POST', '/settings', { method: 'POST', headers: GUARD, body: { patch: { intervalHours: 6, badge: false } } })
  assert.equal(r.statusCode, 200)
  assert.equal(values.intervalHours, 6)
  assert.equal(normalizeSettings(b.store.get()).badge, false)
})

test('DSH 0.2.1 settings: forms mode writes the profile row by entry id', async () => {
  const updates = []
  const settings = { describe: () => [{ ns: 'plugin-updates', user: {} }], update: async (id, patch, rev) => { updates.push([id, patch, rev]) }, configure: () => {} }
  const b = boot({ settings }, { ...DEFAULTS })
  assert.equal(b.store.mode, 'forms')
  assert.equal(b.store.entryId, 'plugin-updates')
  const ok = await call(b, 'POST', '/settings', { method: 'POST', headers: GUARD, body: { patch: { channels: ['latest', 'next'] } } })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(updates[0].slice(0, 2), ['plugin-updates', { channels: ['latest', 'next'] }])
  const bad = await call(b, 'POST', '/settings', { method: 'POST', headers: GUARD, body: { patch: { nonsense: 1 } } })
  assert.equal(bad.statusCode, 400); assert.equal(bad.json.code, 'PLUPD_BAD_REQUEST')
  const wrongType = await call(b, 'POST', '/settings', { method: 'POST', headers: GUARD, body: { patch: { intervalHours: 'soon' } } })
  assert.equal(wrongType.statusCode, 400)
})

test('a ctx without a settings service runs on defaults, read-only', async () => {
  const b = boot({ settings: undefined })
  assert.equal(b.store.mode, 'config')
  const view = (await call(b, 'GET', '/settings')).json
  assert.equal(view.writable, false)
  assert.equal(view.values.intervalHours, 12)
  assert.equal(view.values.registry, 'https://registry.npmjs.org')
  const w = await call(b, 'POST', '/settings', { method: 'POST', headers: GUARD, body: { patch: { badge: false } } })
  assert.equal(w.statusCode, 400)
  const h = (await call(b, 'GET', '/health')).json
  assert.equal(h.ok, true)
})

test('works with zero configuration: first sweep from defaults on a real profile', async () => {
  const b = boot({ settings: undefined })
  const res = await b.engine.sweep()
  assert.equal(res.items.length, 1)
  assert.equal(res.items[0].name, 'dsh-better-sidebar')
})

test('routes: GET list/status/detail, POST gate, cooldown, ignore/unignore/snooze', async () => {
  const b = boot({ settings: undefined }, {}, { })
  await b.engine.sweep()
  const st = (await call(b, 'GET', '/status')).json
  assert.equal(st.ok, true); assert.equal(st.summary.total, 1)
  const list = (await call(b, 'GET', '/list?scope=all')).json
  assert.equal(list.packages.length, 1)
  assert.equal((await call(b, 'GET', '/detail?pkg=nope')).json.code, 'PLUPD_PACKAGE_UNKNOWN')
  // gate
  const noHeader = await call(b, 'POST', '/ignore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { pkg: 'dsh-better-sidebar' } })
  assert.equal(noHeader.statusCode, 403); assert.equal(noHeader.json.code, 'PLUPD_FORBIDDEN')
  const crossOrigin = await call(b, 'POST', '/ignore', { method: 'POST', headers: { ...GUARD, origin: 'https://evil.example.com' }, body: { pkg: 'dsh-better-sidebar' } })
  assert.equal(crossOrigin.statusCode, 403)
  const remote = fakeReq('POST', '/dsh-plugin-updates/api/ignore', { headers: GUARD, body: { pkg: 'x' } }); remote.socket.remoteAddress = '203.0.113.5'
  const rr = fakeRes(); await b.routes[0].handler(remote, rr); assert.equal(rr.statusCode, 403)
  const ig = await call(b, 'POST', '/ignore', { method: 'POST', headers: { ...GUARD, origin: 'http://127.0.0.1:3080' }, body: { pkg: 'dsh-better-sidebar' } })
  assert.equal(ig.statusCode, 200); assert.equal(ig.json.package.status, 'ignored')
  assert.equal((await call(b, 'POST', '/unignore', { method: 'POST', headers: GUARD, body: { pkg: 'dsh-better-sidebar' } })).json.package.status, 'update-compatible')
  assert.equal((await call(b, 'POST', '/snooze', { method: 'POST', headers: GUARD, body: { pkg: 'dsh-better-sidebar', days: 2 } })).json.package.status, 'snoozed')
  const r1 = await call(b, 'POST', '/refresh', { method: 'POST', headers: GUARD, body: {} })
  assert.equal(r1.statusCode, 202)
  await new Promise((r) => setTimeout(r, 30))
  const r2 = await call(b, 'POST', '/refresh', { method: 'POST', headers: GUARD, body: {} })
  assert.equal(r2.statusCode, 429); assert.equal(r2.json.code, 'PLUPD_REFRESH_COOLDOWN'); assert.ok(r2.json.docs.includes('ERRORS.md#plupd_refresh_cooldown'))
  assert.equal((await call(b, 'GET', '/nope')).statusCode, 404)
})

test('every error body has code, message, hint and docs', async () => {
  const b = boot({ settings: undefined })
  const res = await call(b, 'POST', '/ignore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: {} })
  for (const k of ['ok', 'error', 'code', 'message', 'hint', 'docs']) assert.ok(k in res.json, k)
  assert.equal(res.json.ok, false)
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('doctor runs, never throws, and leaks no secret', async () => {
  process.env.PLUPD_TEST_TOKEN = SECRET
  try {
    const b = boot({ settings: undefined }, { githubTokenEnv: 'PLUPD_TEST_TOKEN' })
    const res = await call(b, 'GET', '/doctor?probe=0')
    assert.equal(res.statusCode, 200)
    assert.ok(['ok', 'warn', 'fail'].includes(res.json.status))
    const ids = res.json.checks.map((c) => c.id)
    for (const id of ['dsh-version', 'settings', 'profile', 'state', 'hosts']) assert.ok(ids.includes(id), id)
    assert.ok(!res.body.includes(SECRET))
    assert.ok(!/\/home\//.test(res.body), 'no home path')
    assert.equal(res.json.docs, 'docs/TROUBLESHOOTING.md')
  } finally { delete process.env.PLUPD_TEST_TOKEN }
})

test('doctor reports a missing profile as a coded failure instead of throwing', async () => {
  const b = boot({ settings: undefined }, {}, { profileDir: join(tmp(), 'missing') })
  const d = (await call(b, 'GET', '/doctor?probe=0')).json
  const p = d.checks.find((c) => c.id === 'profile')
  assert.equal(p.status, 'fail'); assert.equal(p.code, 'PLUPD_PROFILE_NOT_FOUND')
})

test('tools compile with the REAL defineTool and are read-only', async () => {
  let defineTool = null
  for (const base of [import.meta.url, process.env.HOME + '/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/package.json']) {
    try { defineTool = createRequire(base)('@deepseek-ai/dsh-tools').defineTool; if (defineTool) break } catch {}
  }
  if (!defineTool) return // harness not present: nothing to compile against
  const b = boot({ settings: undefined })
  await b.engine.sweep()
  const defs = agentTools(defineTool, () => normalizeSettings({}), { engine: b.engine })
  assert.deepEqual(defs.map((d) => d.name), ['plugin_updates', 'plugin_updates_doctor'])
  const d = defs[0]
  assert.match(d.description, /never run pnpm add/i)
  assert.match(d.description, /applyHint/)
  const out = await d.execute({ scope: 'all' })
  assert.equal(out.ok, true)
  assert.ok(out.packages.some((p) => p.name === 'dsh-better-sidebar' && p.applyHint && /MemoryMax=1500M/.test(p.applyHint)))
  const safe = await d.execute({ scope: 'safe' })
  assert.ok(safe.packages.every((p) => p.status === 'update-compatible'))
  const miss = await d.execute({ package: 'nope', scope: 'all' })
  assert.equal(miss.code, 'PLUPD_PACKAGE_UNKNOWN')
})

test('the plugin registers the route, tools (when defineTool resolves), and the doctor skill', () => {
  const calls = []
  const fakeDefine = (def) => def
  const b = boot({ settings: undefined, inject: (names, cb) => { calls.push(names); try { cb({ skills: { registerProvider: (fn) => calls.push(fn().name) } }) } catch {} } }, {}, { defineTool: fakeDefine })
  assert.equal(b.routes.length, 1)
  assert.equal(b.routes[0].path, '/dsh-plugin-updates/api')
  assert.deepEqual(b.tools.map((t) => t.name), ['plugin_updates', 'plugin_updates_doctor'])
  assert.ok(calls.includes('plugin-dsh-plugin-updates'), 'skill provider registered')
})

test('no em or en dashes anywhere in the repository text', () => {
  const root = new URL('..', import.meta.url).pathname
  const bad = []
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === '.git') continue
      const p = join(d, n)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (/\.(png|ico|tgz)$/.test(n)) continue
      if (/[\u2013\u2014]/.test(readFileSync(p, 'utf8'))) bad.push(p.replace(root, ''))
    }
  }
  walk(root)
  assert.deepEqual(bad, [])
})
