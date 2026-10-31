/**
 * Plugin-owned state file (never the profile): cache validators, last result,
 * ignore and snooze choices, rate-limit memory. Atomic writes (temp file + rename).
 */
import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { E } from './errors.js'

export const STATE_VERSION = 1

export function stateDir(env = process.env) {
  if (env.DSH_PLUGIN_UPDATES_STATE_DIR) return env.DSH_PLUGIN_UPDATES_STATE_DIR
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-plugin-updates')
}

const fresh = () => ({
  version: STATE_VERSION, etags: {}, results: null, sweep: null,
  ignored: {}, snoozed: {}, rate: {}, notice: {}, refreshAt: 0,
})

export function createState({ dir = stateDir(), now = Date.now, warn = () => {} } = {}) {
  const file = join(dir, 'state.json')
  const st = { data: fresh(), lastWriteError: null, loaded: false }
  let writing = Promise.resolve()

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (parsed && parsed.version === STATE_VERSION) st.data = { ...fresh(), ...parsed }
    } catch { /* first run or unreadable: start empty */ }
    st.loaded = true
    return st.data
  }

  function prune() {
    const cutoff = now() - 30 * 86400000
    for (const [k, v] of Object.entries(st.data.etags)) if (!v || (v.at || 0) < cutoff) delete st.data.etags[k]
    const t = now()
    for (const [k, v] of Object.entries(st.data.snoozed)) if (!(v > t)) delete st.data.snoozed[k]
  }

  /** Serialized atomic save. Failure keeps memory state and records PLUPD_STATE_WRITE_FAILED. */
  function save() {
    writing = writing.then(async () => {
      prune()
      const tmp = `${file}.tmp-${process.pid}-${now()}`
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await writeFile(tmp, JSON.stringify(st.data), { mode: 0o600 })
        await rename(tmp, file)
        try { await chmod(file, 0o600) } catch {}
        st.lastWriteError = null
      } catch (e) {
        st.lastWriteError = e && e.message ? e.message : String(e)
        warn(E.logLine('PLUPD_STATE_WRITE_FAILED', st.lastWriteError))
        try { await unlink(tmp) } catch {}
      }
    })
    return writing
  }

  return { file, dir, st, get data() { return st.data }, load, save, get lastWriteError() { return st.lastWriteError } }
}
