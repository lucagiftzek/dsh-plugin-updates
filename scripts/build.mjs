#!/usr/bin/env node
/**
 * dsh-plugin-updates: browser-half build (same shape as dsh-phone / dsh-hpc).
 *
 * Bundles src/client.jsx into lib/client.js wrapped in a ModuleLoader factory.
 * format MUST be 'cjs': the factory returns module.exports ('iife' would leave
 * module.exports empty and the whole web UI would fail to boot).
 *
 * lib/client.js is live (HMR). So the bundle is built in memory, loaded through a
 * stub __ModuleLoader__ and checked for { apply, inject } first, and only then
 * written to a temp file and renamed over lib/client.js.
 *
 * Run: node scripts/build.mjs
 */
import { build } from 'esbuild'
import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join(root, 'lib', 'client.js')
const ID = '@lucagiftzek/dsh-plugin-updates'

mkdirSync(join(root, 'lib'), { recursive: true })

const banner = [
  'window.__ModuleLoader__.load({',
  "  id: '@lucagiftzek/dsh-plugin-updates',",
  '  factory: function (require) {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
].join('\n')
const footer = ['    return module.exports;', '  }', '});'].join('\n')

export function loadClientBundle(source) {
  let loaded
  const window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
  runInNewContext(source, { window, console })
  if (!loaded || typeof loaded.factory !== 'function') throw new Error('bundle never called window.__ModuleLoader__.load({ id, factory })')
  const stubs = { react: { useState() {}, useEffect() {}, useRef() {} }, 'react/jsx-runtime': { jsx() {}, jsxs() {}, Fragment: 'Fragment' } }
  const exported = loaded.factory((name) => {
    if (!(name in stubs)) throw new Error('bundle requires ' + JSON.stringify(name) + ', which the shell does not provide')
    return stubs[name]
  })
  return { id: loaded.id, exported }
}

export function verifyClientBundle(source) {
  if (source.includes('@deepseek-ai/')) throw new Error('client bundle purity: @deepseek-ai value imports must not reach the client bundle')
  const { id, exported } = loadClientBundle(source)
  if (id !== ID) throw new Error('bundle registers id ' + JSON.stringify(id) + ', expected ' + JSON.stringify(ID))
  if (!exported || typeof exported.apply !== 'function') throw new Error('factory exports ' + JSON.stringify(Object.keys(exported || {})) + ' with no apply()')
  if (JSON.stringify(exported.inject) !== '["slots"]') throw new Error('inject is ' + JSON.stringify(exported.inject) + ', expected ["slots"] (better-sidebar must stay optional)')
}

async function main() {
  const result = await build({
    entryPoints: [join(root, 'src', 'client.jsx')],
    bundle: true, outfile, write: false, format: 'cjs', platform: 'browser',
    target: ['chrome110', 'firefox110', 'safari16'], jsx: 'automatic',
    banner: { js: banner }, footer: { js: footer },
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    minify: true, sourcemap: false, legalComments: 'none', logLevel: 'info',
  })
  const source = result.outputFiles.find((f) => f.path === outfile)?.text
  if (!source) throw new Error('esbuild produced no ' + outfile)
  verifyClientBundle(source)
  const tmp = outfile + '.tmp-' + process.pid
  writeFileSync(tmp, source)
  renameSync(tmp, outfile)
  console.log('dsh-plugin-updates: bundle verified ({ apply, inject }) and written to lib/client.js')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error('dsh-plugin-updates build failed, lib/client.js left untouched:', err.message || err); process.exit(1) })
}
