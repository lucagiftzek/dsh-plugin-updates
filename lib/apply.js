/**
 * Suggested apply commands. The plugin NEVER runs these: they are text for a
 * human (or an agent acting on the human's request). Every interpolated value
 * is validated first so the text is shell-safe.
 */
import { isPackageName, isRepoSeg, isTagName, isRef } from './classify.js'

export const MEMORY_CAP = 'systemd-run --user --scope -p MemoryMax=1500M -p MemorySwapMax=0'
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function profileDirText(profileName) {
  const n = /^[A-Za-z0-9_.-]{1,60}$/.test(profileName || '') ? profileName : 'web'
  return `"\${DSH_HOME:-$HOME/.dsh}/profiles/${n}"`
}

const wrap = (inner) => `XDG_RUNTIME_DIR=/run/user/$(id -u) ${MEMORY_CAP} ${inner}`

/**
 * @param it { name, kind, cls, spec }
 * @param cand { version, ref? } the candidate to apply
 * @returns {{ applyHint: string|null, manualHint: string|null, spec?: string }}
 */
export function buildApply(it, cand, { profileName = 'web', installed = '' } = {}) {
  if (!cand || !it) return { applyHint: null, manualHint: null }
  const pdir = profileDirText(profileName)
  const base = `pnpm --dir ${pdir} add --save-exact --ignore-scripts`
  const k = it.kind
  if (k === 'registry') {
    const name = it.cls && it.cls.alias ? it.cls.alias : it.name
    if (!isPackageName(name) || !VERSION_RE.test(cand.version || '')) return { applyHint: null, manualHint: 'Name or version failed validation; apply by hand.' }
    const spec = it.cls && it.cls.alias ? `${it.name}@npm:${name}@${cand.version}` : `${name}@${cand.version}`
    return { applyHint: wrap(`${base} ${spec}`), manualHint: null, spec }
  }
  if (k === 'github') {
    const { owner, repo } = it.cls
    const ref = cand.ref && cand.ref.value
    if (!isPackageName(it.name) || !isRepoSeg(owner) || !isRepoSeg(repo) || !isRef(ref)) return { applyHint: null, manualHint: 'Reference failed validation; apply by hand.' }
    const spec = `${it.name}@github:${owner}/${repo}#${ref}`
    return { applyHint: wrap(`${base} '${spec}'`), manualHint: null, spec }
  }
  if (k === 'release') {
    const { owner, repo, tag, file } = it.cls
    const newTag = cand.ref && cand.ref.tag
    if (!isTagName(newTag) || !isRepoSeg(owner) || !isRepoSeg(repo)) return { applyHint: null, manualHint: 'Release tag failed validation; apply by hand.' }
    let newFile = file
    if (installed && file.includes(installed)) newFile = file.replace(installed, cand.version)
    if (cand.ref.assets && cand.ref.assets.length && !cand.ref.assets.includes(newFile)) {
      return { applyHint: null, manualHint: `Release ${newTag} has no asset named ${newFile}; pick the asset by hand on the releases page.` }
    }
    if (!/^[A-Za-z0-9_.+-]{1,200}$/.test(newFile)) return { applyHint: null, manualHint: 'Asset name failed validation; apply by hand.' }
    const url = `https://github.com/${owner}/${repo}/releases/download/${newTag}/${newFile}`
    return { applyHint: wrap(`${base} '${it.name}@${url}'`), manualHint: null, spec: url }
  }
  if (k === 'local') {
    return { applyHint: null, manualHint: 'Local folder: update it with git (pull or rebase onto the upstream tag), rebuild if the plugin has a client bundle, then restart or reload. No package manager command applies.' }
  }
  return { applyHint: null, manualHint: 'No automatic command for this specifier; update by hand.' }
}

/** Links built only from validated parts, never from registry or GitHub prose. */
export function buildLinks(it, installed, cand) {
  const links = {}
  const k = it.kind
  if (k === 'registry') {
    const name = it.cls && it.cls.alias ? it.cls.alias : it.name
    if (isPackageName(name)) {
      links.npm = `https://www.npmjs.com/package/${name}`
      if (cand && VERSION_RE.test(cand.version)) links.changelog = `https://www.npmjs.com/package/${name}/v/${cand.version}`
    }
  }
  const gh = it.cls && it.cls.owner ? it.cls : it.upstreamRepo
  if (gh && isRepoSeg(gh.owner) && isRepoSeg(gh.repo)) {
    const root = `https://github.com/${gh.owner}/${gh.repo}`
    links.repo = root
    links.releases = `${root}/releases`
    const nt = cand && cand.ref && (cand.ref.tag || (cand.ref.kind === 'tag' && cand.ref.value))
    if (nt && isTagName(nt)) {
      links.changelog = `${root}/releases/tag/${nt}`
      const it0 = it.installedTag
      if (it0 && isTagName(it0)) links.compare = `${root}/compare/${it0}...${nt}`
    } else if (cand && cand.ref && cand.ref.kind === 'head' && it.installedCommit) {
      links.compare = `${root}/compare/${it.installedCommit}...${cand.ref.value}`
    }
  }
  return links
}
