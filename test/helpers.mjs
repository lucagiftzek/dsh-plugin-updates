import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createState } from '../lib/state.js'
import { createNet } from '../lib/net.js'
import { loadSemver } from '../lib/compat.js'
import { normalizeSettings } from '../lib/config.js'

export const sv = loadSemver(import.meta.url)
export const tmp = (p = 'plupd-') => mkdtempSync(join(tmpdir(), p))

/** A fetch double: routes is a list of [test(url, init), reply] where reply is a function or an object. */
export function fakeFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    for (const [test, reply] of routes) {
      const hit = typeof test === 'string' ? String(url) === test : test instanceof RegExp ? test.test(String(url)) : test(String(url), init)
      if (!hit) continue
      const r = typeof reply === 'function' ? await reply(String(url), init, calls.length) : reply
      return makeRes(r)
    }
    return makeRes({ status: 404, body: '{}' })
  }
  fn.calls = calls
  return fn
}
export function makeRes({ status = 200, headers = {}, body = '' }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return { status, headers: { get: (k) => (k.toLowerCase() in h ? h[k.toLowerCase()] : null) }, text: async () => text }
}
export const json = (body, extra = {}) => ({ status: 200, headers: { etag: extra.etag || 'W/"x"', ...(extra.headers || {}) }, body })

export function setup({ fetch, settings = {}, env = {} } = {}) {
  const dir = tmp()
  const state = createState({ dir: join(dir, 'state') })
  const cfgObj = normalizeSettings(settings)
  const cfg = () => cfgObj
  const net = createNet({ fetch, state, cfg, version: 'test', env })
  return { dir, state, cfg, cfgObj, net }
}

/** Build a throwaway profile: package.json, optional lockfile, installed versions, linked folders. */
export function makeProfile({ deps = {}, bundles = [], installed = {}, lock = '', links = {} } = {}) {
  const dir = tmp('plupd-profile-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: deps, dsh: { profile: { bundles } } }))
  if (lock) writeFileSync(join(dir, 'pnpm-lock.yaml'), lock)
  for (const [n, v] of Object.entries(installed)) {
    const d = join(dir, 'node_modules', ...n.split('/'))
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: n, version: v }))
  }
  for (const [rel, def] of Object.entries(links)) {
    const d = join(dir, rel)
    mkdirSync(join(d, '.git'), { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: def.name || rel, version: def.version }))
    writeFileSync(join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(d, '.git', 'refs', 'heads'), { recursive: true })
    if (def.sha) writeFileSync(join(d, '.git', 'refs', 'heads', 'main'), def.sha + '\n')
    writeFileSync(join(d, '.git', 'config'), `[remote "origin"]\n\turl = ${def.origin || ''}\n`)
  }
  return dir
}
export const sha = (c) => c.repeat(40)
