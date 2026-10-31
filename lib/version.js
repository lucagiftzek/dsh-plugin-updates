/** Running DSH core version: setting override, test env, harness package, process walk-up. */
import { requireFromHarness } from './dual-settings.js'
import { hostVersion } from './plugin-errors.js'

export function detectRunning({ override = '', sv, metaUrl, env = process.env } = {}) {
  const valid = (v) => (sv ? sv.valid(v) : /^\d+\.\d+\.\d+/.test(v || ''))
  if (override && valid(override)) return { version: override, source: 'setting' }
  if (env.DSH_PLUGIN_UPDATES_DSH_VERSION && valid(env.DSH_PLUGIN_UPDATES_DSH_VERSION)) return { version: env.DSH_PLUGIN_UPDATES_DSH_VERSION, source: 'env' }
  try {
    const pkg = requireFromHarness('@deepseek-ai/dsh/package.json', metaUrl)
    if (pkg && valid(pkg.version)) return { version: pkg.version, source: 'harness' }
  } catch { /* next */ }
  return { version: '', source: 'unknown' }
}

/** Async fallback: walk up from the running entry script. */
export async function detectRunningAsync(opts) {
  const sync = detectRunning(opts)
  if (sync.version) return sync
  const v = await hostVersion()
  return v ? { version: v, source: 'process' } : sync
}
