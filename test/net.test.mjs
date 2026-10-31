import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeFetch, json, setup, makeRes } from './helpers.mjs'
import { MAX_BYTES } from '../lib/net.js'

const REG = 'https://registry.npmjs.org/some-pkg'
const rejectsWith = async (p, code) => { try { await p } catch (e) { assert.equal(e.code, code, e.message); return e } assert.fail('expected ' + code) }

test('ETag: first 200 caches the reduction, the next call sends If-None-Match and a 304 returns the cache', async () => {
  const f = fakeFetch([[REG, (u, init) => (init.headers['if-none-match'] === '"v1"' ? { status: 304, headers: {} } : json({ a: 1 }, { etag: '"v1"' }))]])
  const { net, state } = setup({ fetch: f })
  const a = await net.get(REG)
  assert.deepEqual(a.data, { a: 1 }); assert.equal(a.cached, false)
  assert.equal(state.data.etags[REG].etag, '"v1"')
  const b = await net.get(REG)
  assert.deepEqual(b.data, { a: 1 }); assert.equal(b.cached, true)
  assert.equal(net.stats.notModified, 1)
})

test('allowlist: unknown hosts, http and credentials are refused before any request', async () => {
  const f = fakeFetch([])
  const { net } = setup({ fetch: f })
  for (const u of ['https://registry.npmmirror.com/x', 'http://registry.npmjs.org/x', 'https://user:pw' + '@registry.npmjs.org/x', 'https://evil.example.com/x']) {
    await rejectsWith(net.get(u), 'PLUPD_REGISTRY_HOST_BLOCKED')
  }
  assert.equal(f.calls.length, 0)
})

test('allowHosts is an explicit opt-in', async () => {
  const f = fakeFetch([[/internal\.example\.com/, json({ ok: 1 })]])
  const { net } = setup({ fetch: f, settings: { allowHosts: ['internal.example.com'] } })
  assert.equal((await net.get('https://internal.example.com/p')).data.ok, 1)
})

test('redirects to other hosts are refused, redirects inside the allowlist are followed', async () => {
  const f = fakeFetch([
    [REG, { status: 301, headers: { location: 'https://registry.npmmirror.com/some-pkg' } }],
    ['https://api.github.com/repos/o/old', { status: 301, headers: { location: 'https://api.github.com/repositories/42' } }],
    ['https://api.github.com/repositories/42', json({ moved: true })],
  ])
  const { net } = setup({ fetch: f })
  const e = await rejectsWith(net.get(REG), 'PLUPD_REGISTRY_HOST_BLOCKED')
  assert.match(e.message, /npmmirror/)
  assert.equal(f.calls.length, 1, 'the mirror was never contacted')
  assert.equal((await net.get('https://api.github.com/repos/o/old')).data.moved, true)
})

test('response size cap', async () => {
  const f = fakeFetch([[REG, { status: 200, headers: { 'content-length': String(MAX_BYTES + 1) }, body: '{}' }]])
  const { net } = setup({ fetch: f })
  await rejectsWith(net.get(REG), 'PLUPD_RESPONSE_TOO_LARGE')
})

test('GitHub: stops below 10 remaining until the reset time', async () => {
  let n = 0
  const f = fakeFetch([[/api\.github\.com/, () => { n++; return json({ n }, { etag: '"e' + n + '"', headers: { 'x-ratelimit-remaining': '9', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } }) }]])
  const { net } = setup({ fetch: f })
  await net.get('https://api.github.com/repos/o/a')
  const e = await rejectsWith(net.get('https://api.github.com/repos/o/b'), 'PLUPD_GITHUB_RATE_LIMITED')
  assert.ok(e.body.retryAfterSec > 0 && e.body.retryAfterSec <= 600)
  assert.equal(f.calls.length, 1, 'no second request was made')
})

test('GitHub: 403 with remaining 0 and Retry-After backs off and is remembered in state', async () => {
  const f = fakeFetch([[/api\.github\.com/, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '120' }, body: '{}' }]])
  const { net, state } = setup({ fetch: f })
  const e = await rejectsWith(net.get('https://api.github.com/repos/o/a'), 'PLUPD_GITHUB_RATE_LIMITED')
  assert.equal(e.body.retryAfterSec, 120)
  assert.ok(state.data.rate.github.blockedUntil > Date.now())
  await rejectsWith(net.get('https://api.github.com/repos/o/b'), 'PLUPD_GITHUB_RATE_LIMITED')
  assert.equal(f.calls.length, 1)
})

test('registry 429 backs off as unreachable, never as success', async () => {
  const f = fakeFetch([[REG, { status: 429, headers: { 'retry-after': '30' }, body: '' }]])
  const { net } = setup({ fetch: f })
  await rejectsWith(net.get(REG), 'PLUPD_REGISTRY_UNREACHABLE')
  await rejectsWith(net.get(REG), 'PLUPD_REGISTRY_UNREACHABLE')
  assert.equal(f.calls.length, 1)
})

test('network errors are unreachable per host', async () => {
  const f = async () => { throw new Error('ECONNRESET') }
  const { net } = setup({ fetch: f })
  await rejectsWith(net.get(REG), 'PLUPD_REGISTRY_UNREACHABLE')
  await rejectsWith(net.get('https://api.github.com/repos/o/a'), 'PLUPD_GITHUB_UNREACHABLE')
})

test('at most 4 concurrent requests per host', async () => {
  let live = 0; let peak = 0
  const f = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live--; return makeRes({ status: 200, body: '{}' }) }
  const { net } = setup({ fetch: f })
  await Promise.all(Array.from({ length: 12 }, (_, i) => net.get(`https://registry.npmjs.org/p${i}`)))
  assert.ok(peak <= 4 && peak >= 2, 'peak ' + peak)
})

test('the GitHub token comes from the NAMED variable, goes only to api.github.com and is never stored', async () => {
  const SECRET = 'ghp_FAKE_NET_TEST_VALUE'
  const f = fakeFetch([[/./, json({ ok: 1 })]])
  const { net, state } = setup({ fetch: f, settings: { githubTokenEnv: 'MY_GH_TOKEN' }, env: { MY_GH_TOKEN: SECRET } })
  await net.get('https://api.github.com/repos/o/a')
  await net.get(REG)
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer ' + SECRET)
  assert.equal(f.calls[1].init.headers.authorization, undefined)
  assert.ok(!JSON.stringify(state.data).includes(SECRET))
})

test('404 is returned as null data, not cached', async () => {
  const f = fakeFetch([[REG, { status: 404, body: '{}' }]])
  const { net, state } = setup({ fetch: f })
  const r = await net.get(REG)
  assert.equal(r.status, 404); assert.equal(r.data, null)
  assert.equal(Object.keys(state.data.etags).length, 0)
})
