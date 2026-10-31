/** HTTP routes under /dsh-plugin-updates/api. POSTs touch only the plugin's own state. */
import { E } from './errors.js'

export const PLUGIN_ID = 'dsh-plugin-updates'
export const API_PREFIX = '/' + PLUGIN_ID + '/api'
const MAX_BODY = 64 * 1024

const isLoopback = (a) => /^(127\.|::1$|::ffff:127\.|localhost)/.test(String(a || ''))

/** State-changing request gate: custom header + JSON + same origin + loopback (or the host admission when it offers one). */
export function postGate(req, ctx) {
  const h = req.headers || {}
  if (h['x-requested-with'] !== PLUGIN_ID) return false
  if (String(h['content-type'] || '').split(';')[0].trim() !== 'application/json') return false
  if (h.origin) {
    try { if (new URL(h.origin).host !== h.host) return false } catch { return false }
  }
  try {
    const conn = ctx && ctx.connection
    if (conn && typeof conn.admit === 'function') {
      const a = conn.admit({ headers: h, remoteAddress: req.socket && req.socket.remoteAddress, method: req.method, url: req.url })
      if (a && (a.ok === false || a.status >= 400)) return false
      return true
    }
  } catch { /* fall through to loopback */ }
  return isLoopback(req.socket && req.socket.remoteAddress)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = []
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(E.raise('PLUPD_BAD_REQUEST', { detail: 'body too large' })); try { req.destroy() } catch {} } else chunks.push(c) })
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(E.raise('PLUPD_BAD_REQUEST', { detail: 'invalid JSON' })) } })
    req.on('error', reject)
  })
}

function json(res, status, body) {
  if (!res.headersSent) { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store') }
  res.end(JSON.stringify(body))
}

/** settings: { view(): object, update(patch): Promise } supplied by index.js */
export function makeHandler({ engine, settings, ctx, version }) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const path = url.pathname.replace(API_PREFIX, '').replace(/\/+$/, '') || '/'
      if (req.method === 'GET') {
        if (path === '/health') return json(res, 200, { ok: true, plugin: PLUGIN_ID, version })
        if (path === '/status') return json(res, 200, engine.status())
        if (path === '/list') {
          const scope = url.searchParams.get('scope') || 'all'
          return json(res, 200, { ok: true, status: engine.status(), packages: engine.list({ scope, pkg: url.searchParams.get('pkg') || '' }) })
        }
        if (path === '/detail') return json(res, 200, { ok: true, package: await engine.detail(url.searchParams.get('pkg') || '') })
        if (path === '/doctor') return json(res, 200, await engine.doctor({ probe: url.searchParams.get('probe') !== '0' }))
        if (path === '/settings') return json(res, 200, { ok: true, ...settings.view() })
        return E.send(res, 'PLUPD_BAD_REQUEST', { status: 404, detail: 'unknown route' })
      }
      if (req.method === 'POST') {
        if (!postGate(req, ctx)) return E.send(res, 'PLUPD_FORBIDDEN')
        const body = await readBody(req)
        const pkg = typeof body.pkg === 'string' ? body.pkg : ''
        if (path === '/refresh') {
          const p = engine.refresh()
          p.catch((e) => console.error('dsh-plugin-updates: ' + E.logLine(E.from(e).code, e && e.message)))
          return json(res, 202, { ok: true, started: true, status: engine.status() })
        }
        if (path === '/ignore') return json(res, 200, { ok: true, package: await engine.ignore(pkg, typeof body.version === 'string' ? body.version : '') })
        if (path === '/unignore') return json(res, 200, { ok: true, package: await engine.unignore(pkg) })
        if (path === '/snooze') return json(res, 200, { ok: true, package: await engine.snooze(pkg, body.days) })
        if (path === '/settings') {
          if (!body.patch || typeof body.patch !== 'object') return E.send(res, 'PLUPD_BAD_REQUEST', { detail: 'patch is required' })
          return json(res, 200, { ok: true, ...(await settings.update(body.patch)) })
        }
        return E.send(res, 'PLUPD_BAD_REQUEST', { status: 404, detail: 'unknown route' })
      }
      return E.send(res, 'PLUPD_BAD_REQUEST', { status: 405, detail: 'method not allowed' })
    } catch (e) {
      const b = E.from(e)
      if (b.code === 'PLUPD_INTERNAL') console.error('dsh-plugin-updates: ' + E.logLine(b.code, e && e.message))
      return E.send(res, b.code, { ...(b.retryAfterSec ? { retryAfterSec: b.retryAfterSec } : {}) })
    }
  }
}
