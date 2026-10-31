/**
 * Allowlisted, rate-limit aware HTTP for the two hosts this plugin may contact.
 *
 *  - https only; host must be registry.npmjs.org, api.github.com or in allowHosts
 *  - redirects are followed manually and only to allowed hosts (max 3)
 *  - conditional requests (ETag / If-None-Match); a 304 returns the cached reduction
 *  - responses capped at 8 MB
 *  - at most 4 concurrent requests per host
 *  - GitHub: stops below 10 remaining, honours Retry-After and the reset time
 *  - the token (when configured) is read from the NAMED environment variable at
 *    call time, sent only to api.github.com and never stored or logged
 */
import { E } from './errors.js'
import { ALLOWED_HOSTS } from './config.js'

export const MAX_BYTES = 8 * 1024 * 1024
export const PER_HOST = 4
export const GITHUB_MIN_REMAINING = 10
export const TIMEOUT_MS = 20000

export function hostAllowed(url, extra = []) {
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const h = u.hostname.toLowerCase()
  return ALLOWED_HOSTS.includes(h) || extra.map((x) => String(x).toLowerCase()).includes(h)
}

const hget = (res, name) => {
  try {
    const h = res && res.headers
    if (!h) return null
    if (typeof h.get === 'function') return h.get(name)
    const v = h[name] ?? h[name.toLowerCase()]
    return v === undefined ? null : String(v)
  } catch { return null }
}

async function readCapped(res, cap) {
  const len = Number(hget(res, 'content-length'))
  if (Number.isFinite(len) && len > cap) throw E.raise('PLUPD_RESPONSE_TOO_LARGE')
  const body = res.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) { try { await reader.cancel() } catch {} throw E.raise('PLUPD_RESPONSE_TOO_LARGE') }
      chunks.push(value)
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
  }
  const text = await res.text()
  if (Buffer.byteLength(text, 'utf8') > cap) throw E.raise('PLUPD_RESPONSE_TOO_LARGE')
  return text
}

class Semaphore {
  constructor(n) { this.n = n; this.q = [] }
  async run(fn) {
    if (this.n <= 0) await new Promise((r) => this.q.push(r))
    else this.n -= 1
    try { return await fn() } finally {
      const next = this.q.shift()
      if (next) next(); else this.n += 1
    }
  }
}

/**
 * @param o.fetch   fetch implementation (default globalThis.fetch)
 * @param o.state   createState() result
 * @param o.cfg     () => normalized settings
 * @param o.version plugin version for the User-Agent
 */
export function createNet({ fetch: fetchImpl = globalThis.fetch, state, cfg, now = Date.now, version = '0.0.0', env = process.env, warn = () => {} }) {
  const sems = new Map()
  const stats = { requests: 0, notModified: 0, github: 0, registry: 0 }
  const sem = (host) => { if (!sems.has(host)) sems.set(host, new Semaphore(PER_HOST)); return sems.get(host) }
  const rate = () => { state.data.rate = state.data.rate || {}; return state.data.rate }

  function guardBlocked(host) {
    const r = rate()
    const t = now()
    if (host === 'api.github.com') {
      const g = r.github || {}
      if (g.blockedUntil && g.blockedUntil > t) throw E.raise('PLUPD_GITHUB_RATE_LIMITED', { retryAfterSec: Math.ceil((g.blockedUntil - t) / 1000) })
      if (typeof g.remaining === 'number' && g.remaining < GITHUB_MIN_REMAINING && g.resetAt && g.resetAt > t) {
        throw E.raise('PLUPD_GITHUB_RATE_LIMITED', { retryAfterSec: Math.ceil((g.resetAt - t) / 1000) })
      }
    } else {
      const g = r[host] || {}
      if (g.blockedUntil && g.blockedUntil > t) throw E.raise('PLUPD_REGISTRY_UNREACHABLE', { detail: `backing off after a rate limit response, ${Math.ceil((g.blockedUntil - t) / 1000)} s left` })
    }
  }

  function noteHeaders(host, res) {
    if (host !== 'api.github.com') return
    const rem = hget(res, 'x-ratelimit-remaining')
    const reset = hget(res, 'x-ratelimit-reset')
    const g = (rate().github = rate().github || {})
    if (rem !== null && rem !== '' && Number.isFinite(Number(rem))) g.remaining = Number(rem)
    if (reset && Number.isFinite(Number(reset))) g.resetAt = Number(reset) * 1000
    if (g.remaining > GITHUB_MIN_REMAINING) delete g.blockedUntil
  }

  function noteLimited(host, res) {
    const ra = Number(hget(res, 'retry-after'))
    const reset = Number(hget(res, 'x-ratelimit-reset'))
    let until = now() + 60000
    if (Number.isFinite(ra) && ra > 0) until = now() + ra * 1000
    else if (Number.isFinite(reset) && reset * 1000 > now()) until = reset * 1000
    until = Math.min(until, now() + 3600000)
    const key = host === 'api.github.com' ? 'github' : host
    const g = (rate()[key] = rate()[key] || {})
    g.blockedUntil = until
    return Math.ceil((until - now()) / 1000)
  }

  /**
   * GET one URL. `reduce(text, contentType)` turns the body into the small value
   * that is cached under the ETag. Returns { status, data, cached } where status 404 gives data null.
   */
  async function get(url, { accept = 'application/json', reduce = (t) => JSON.parse(t), noCache = false, cacheKey = '' } = {}) {
    const key = cacheKey || url
    const c = cfg()
    let current = url
    for (let hop = 0; hop <= 3; hop++) {
      if (!hostAllowed(current, c.allowHosts)) throw E.raise('PLUPD_REGISTRY_HOST_BLOCKED', { detail: safeHost(current) })
      const u = new URL(current)
      const host = u.hostname.toLowerCase()
      guardBlocked(host)
      const cached = noCache ? null : state.data.etags[hop === 0 ? key : current]
      const headers = { accept, 'user-agent': `dsh-plugin-updates/${version}` }
      if (cached && cached.etag) headers['if-none-match'] = cached.etag
      if (host === 'api.github.com') {
        headers['x-github-api-version'] = '2022-11-28'
        const tokenName = c.githubTokenEnv
        const token = tokenName ? env[tokenName] : ''
        if (token) headers.authorization = `Bearer ${token}`
      }
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
      let res
      stats.requests += 1
      stats[host === 'api.github.com' ? 'github' : 'registry'] += 1
      try {
        res = await sem(host).run(() => fetchImpl(current, { method: 'GET', headers, redirect: 'manual', signal: ctl.signal }))
      } catch (e) {
        clearTimeout(timer)
        throw E.raise(host === 'api.github.com' ? 'PLUPD_GITHUB_UNREACHABLE' : 'PLUPD_REGISTRY_UNREACHABLE', { detail: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) })
      }
      try {
        noteHeaders(host, res)
        const status = res.status
        if (status >= 300 && status < 400 && status !== 304) {
          const loc = hget(res, 'location')
          if (!loc) throw E.raise(host === 'api.github.com' ? 'PLUPD_GITHUB_UNREACHABLE' : 'PLUPD_REGISTRY_UNREACHABLE', { detail: `redirect ${status} without location` })
          let next
          try { next = new URL(loc, current).toString() } catch { throw E.raise('PLUPD_REGISTRY_HOST_BLOCKED', { detail: 'unparseable redirect' }) }
          if (!hostAllowed(next, c.allowHosts)) throw E.raise('PLUPD_REGISTRY_HOST_BLOCKED', { detail: `redirect to ${safeHost(next)}` })
          current = next
          continue
        }
        if (status === 304) {
          stats.notModified += 1
          if (cached && cached.data !== undefined) { cached.at = now(); return { status: 200, data: cached.data, cached: true } }
          return get(url, { accept, reduce, noCache: true, cacheKey })
        }
        if (status === 404) return { status: 404, data: null, cached: false }
        if (status === 429 || (status === 403 && host === 'api.github.com' && (hget(res, 'x-ratelimit-remaining') === '0' || hget(res, 'retry-after')))) {
          const secs = noteLimited(host, res)
          throw E.raise(host === 'api.github.com' ? 'PLUPD_GITHUB_RATE_LIMITED' : 'PLUPD_REGISTRY_UNREACHABLE', { retryAfterSec: secs, detail: host === 'api.github.com' ? undefined : 'rate limited' })
        }
        if (status < 200 || status >= 300) throw E.raise(host === 'api.github.com' ? 'PLUPD_GITHUB_UNREACHABLE' : 'PLUPD_REGISTRY_UNREACHABLE', { detail: `HTTP ${status}` })
        const text = await readCapped(res, MAX_BYTES)
        let data
        try { data = reduce(text, hget(res, 'content-type') || '') } catch (e) { throw E.raise(host === 'api.github.com' ? 'PLUPD_GITHUB_UNREACHABLE' : 'PLUPD_REGISTRY_UNREACHABLE', { detail: 'unparseable response' }) }
        const etag = hget(res, 'etag')
        if (etag && !noCache) state.data.etags[key] = { etag, data, at: now() }
        return { status: 200, data, cached: false }
      } finally { clearTimeout(timer) }
    }
    throw E.raise('PLUPD_REGISTRY_HOST_BLOCKED', { detail: 'too many redirects' })
  }

  return { get, stats, hostAllowed: (u) => hostAllowed(u, cfg().allowHosts) }
}

function safeHost(u) { try { return new URL(u).hostname } catch { return 'invalid url' } }
