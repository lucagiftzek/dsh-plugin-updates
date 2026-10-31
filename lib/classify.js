/**
 * Classify a dependency by its SPECIFIER, never by its name. Pure, no network.
 *
 * kinds:
 *   registry  semver range, dist-tag or npm: alias        -> registry.npmjs.org
 *   github    github:o/r[#ref], git+https://github.com/..., owner/repo shorthand
 *   release   https://github.com/o/r/releases/download/<tag>/<file>.tgz
 *   local     link: file: workspace: or a bare path
 *   manual    anything else (other git hosts, other tarballs, unknown)
 */

const NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const SEG_RE = /^[A-Za-z0-9_.-]{1,100}$/
const REF_RE = /^[A-Za-z0-9_.\-+/]{1,120}$/
const TAG_RE = /^[A-Za-z0-9_.\-+]{1,100}$/

export const isPackageName = (n) => typeof n === 'string' && n.length <= 214 && NAME_RE.test(n)
export const isRepoSeg = (s) => typeof s === 'string' && SEG_RE.test(s) && s !== '.' && s !== '..'
export const isRef = (s) => typeof s === 'string' && REF_RE.test(s) && !s.includes('..')
export const isTagName = (s) => typeof s === 'string' && TAG_RE.test(s)

function cleanRepo(r) { return String(r).replace(/\.git$/i, '') }

/**
 * @param {string} spec dependency value from package.json
 * @param {{ validRange?: (r: string) => string | null }} [sv] semver for the range test
 */
export function classifySpecifier(spec, sv = null) {
  const s = typeof spec === 'string' ? spec.trim() : ''
  if (!s) return { kind: 'manual', reason: 'empty specifier' }

  if (/^(link|file|workspace):/i.test(s)) {
    const path = s.replace(/^(link|file|workspace):/i, '')
    return { kind: 'local', scheme: s.slice(0, s.indexOf(':')).toLowerCase(), path }
  }
  if (/^(\.{1,2}\/|\/|~\/)/.test(s)) return { kind: 'local', scheme: 'path', path: s }

  // https://github.com/<o>/<r>/releases/download/<tag>/<file>
  let m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/?#]+)$/i.exec(s)
  if (m && isRepoSeg(m[1]) && isRepoSeg(m[2]) && isTagName(m[3])) {
    return { kind: 'release', owner: m[1], repo: cleanRepo(m[2]), tag: m[3], file: m[4], url: s }
  }

  // github: shorthand, git+https/ssh/git URLs, https://github.com/o/r(.git)#ref
  m = /^github:([^/#\s]+)\/([^/#\s]+)(?:#(.+))?$/i.exec(s)
    || /^git\+(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com[/:]([^/]+)\/([^/#\s]+?)(?:\.git)?(?:#(.+))?$/i.exec(s)
    || /^git:\/\/github\.com\/([^/]+)\/([^/#\s]+?)(?:\.git)?(?:#(.+))?$/i.exec(s)
    || /^https:\/\/github\.com\/([^/]+)\/([^/#\s]+?)(?:\.git)?(?:#(.+))?$/i.exec(s)
    || /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+)(?:#(.+))?$/.exec(s)
  if (m && isRepoSeg(m[1]) && isRepoSeg(cleanRepo(m[2]))) {
    const ref = m[3] ? m[3].replace(/^semver:/, '') : ''
    return { kind: 'github', owner: m[1], repo: cleanRepo(m[2]), ref: isRef(ref) ? ref : '', refRaw: m[3] || '' }
  }
  if (/^(git\+|git:|ssh:|git@)/i.test(s)) return { kind: 'manual', reason: 'git remote outside github.com', gitHost: hostOf(s) }
  if (/^https?:\/\//i.test(s)) return { kind: 'manual', reason: 'pinned URL tarball (not a GitHub release)' }

  // npm:alias@range
  m = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.+))?$/.exec(s)
  if (m && isPackageName(m[1])) return { kind: 'registry', alias: m[1], range: m[2] || 'latest' }

  if (/^[a-z][a-z0-9._-]*$/i.test(s) && !/^v?\d/.test(s)) return { kind: 'registry', range: s, tag: s }
  const valid = sv && typeof sv.validRange === 'function' ? sv.validRange(s) !== null : /^[\s\dxX*^~<>=|.v+\-a-zA-Z]+$/.test(s)
  if (valid) return { kind: 'registry', range: s }
  return { kind: 'manual', reason: 'unrecognized specifier' }
}

function hostOf(s) {
  const m = /(?:@|\/\/)([^/:#\s]+)/.exec(s)
  return m ? m[1].toLowerCase() : ''
}

/** Parse an upstream map value "owner/repo[@base]". */
export function parseUpstream(value) {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@([A-Za-z0-9_.+-]+))?$/.exec(String(value || '').trim())
  if (!m || !isRepoSeg(m[1]) || !isRepoSeg(m[2])) return null
  return { owner: m[1], repo: m[2], base: m[3] || '' }
}

/** github.com owner/repo from a git remote url (https or scp style); null for any other host. */
export function githubRemote(url) {
  const s = String(url || '').trim()
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|git\+https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s)
  if (!m || !isRepoSeg(m[1]) || !isRepoSeg(m[2])) return null
  return { owner: m[1], repo: m[2] }
}
