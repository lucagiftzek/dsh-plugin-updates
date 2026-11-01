import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { E, CATALOG } from '../lib/errors.js'
import { parseSkillFile, createSkillProvider } from '../lib/plugin-skills.js'

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

test('docs/ERRORS.md covers every code in the catalog (drift test)', () => {
  assert.deepEqual(E.missingFromDoc(read('docs/ERRORS.md')), [])
})

test('every ERRORS.md troubleshooting link and every catalog docs anchor resolves', () => {
  const ts = read('docs/TROUBLESHOOTING.md')
  const anchors = new Set([...ts.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]))
  for (const m of read('docs/ERRORS.md').matchAll(/TROUBLESHOOTING\.md#([\w-]+)/g)) assert.ok(anchors.has(m[1]), 'missing anchor ' + m[1])
  const errs = read('docs/ERRORS.md')
  for (const [code, def] of Object.entries(E.codes)) {
    assert.match(def.docs, /^docs\/ERRORS\.md#plupd_/)
    assert.ok(errs.includes('### ' + code))
  }
  for (const m of ts.matchAll(/\]\(#([\w-]+)\)/g)) assert.ok(anchors.has(m[1]), 'quick index points to missing anchor ' + m[1])
})

test('catalog: INTERNAL exists and codes carry hint and status', () => {
  assert.ok(CATALOG.PLUPD_INTERNAL)
  for (const [c, d] of Object.entries(CATALOG)) { assert.ok(d.hint, c); assert.ok(d.status >= 400, c) }
  for (const c of ['PLUPD_PROFILE_NOT_FOUND', 'PLUPD_DSH_VERSION_UNKNOWN', 'PLUPD_REGISTRY_UNREACHABLE', 'PLUPD_REGISTRY_HOST_BLOCKED', 'PLUPD_GITHUB_RATE_LIMITED', 'PLUPD_SPEC_UNSUPPORTED', 'PLUPD_LOCKFILE_UNREADABLE', 'PLUPD_RESPONSE_TOO_LARGE', 'PLUPD_STATE_WRITE_FAILED', 'PLUPD_REFRESH_COOLDOWN']) assert.ok(CATALOG[c], c)
})

test('error messages scrub tokens, credentials and home paths', () => {
  const b = E.tool('PLUPD_INTERNAL', { detail: 'failed for ghp_ABCDEFGH12345678 at /ho' + 'me/someone/x with Bearer abcdefgh12345678 https://u:p' + '@example.com/' })
  const text = JSON.stringify(b)
  assert.ok(!/ghp_ABCDEFGH|abcdefgh12345678|someone|u:p@/.test(text), text)
})

test('doctor skill: valid frontmatter, folder name equals skill name, registered as a bundled provider', () => {
  const raw = read('skills/plugin-updates-doctor/SKILL.md')
  const { meta } = parseSkillFile(raw)
  assert.equal(meta.name, 'plugin-updates-doctor')
  const p = createSkillProvider('dsh-plugin-updates', new URL('../skills/', import.meta.url))
  assert.equal(p.count, 1)
})

test('package.json: files, engines, dsh block, author, license', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.files.includes('docs') && pkg.files.includes('skills') && pkg.files.includes('lib') && pkg.files.includes('cordis.patch.yml'))
  assert.equal(pkg.name, '@lucagiftzek/dsh-plugin-updates')
  assert.equal(pkg.engines.dsh, '>=0.1.5-rc.1 <0.3.0')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(pkg.author, { name: 'Luca Tzekos', url: 'https://jobopportunitiesapi.org' })
  assert.equal(pkg.license, 'MIT')
  assert.ok(existsSync(new URL('../LICENSE', import.meta.url)))
})

test('README: scoped-name note, doctor section, privacy hosts, JOA footer identical to the model plugin', () => {
  const r = read('README.md')
  assert.match(r, /@jobopportunitiesapi\/dsh-plugin-updates/)
  assert.match(r, /## When something goes wrong/)
  assert.match(r, /registry\.npmjs\.org/); assert.match(r, /api\.github\.com/)
  assert.match(r, /Built by Luca Tzekos, who also makes \[\*\*Job Opportunities API\*\*\]\(https:\/\/jobopportunitiesapi\.org\)/)
  assert.ok(r.trimEnd().endsWith('is the best thanks.'))
})
