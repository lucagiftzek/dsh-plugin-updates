import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySpecifier, parseUpstream, githubRemote } from '../lib/classify.js'
import { sv } from './helpers.mjs'

const k = (s) => classifySpecifier(s, sv)

test('registry specifiers: ranges, exact, tags, aliases', () => {
  for (const s of ['0.1.0', '^0.18.0', '~1.2.3', '>=1.0.0 <2', '1.x', '*', 'latest', 'next']) assert.equal(k(s).kind, 'registry', s)
  assert.equal(k('npm:real-name@^1.2.0').alias, 'real-name')
  assert.equal(k('npm:@scope/real@1.0.0').alias, '@scope/real')
  assert.equal(k('latest').tag, 'latest')
})

test('local specifiers: link, file, workspace, bare paths', () => {
  assert.equal(k('link:/opt/x/plugin').kind, 'local')
  assert.equal(k('link:../plugin').path, '../plugin')
  assert.equal(k('file:./vendor/p.tgz').kind, 'local')
  assert.equal(k('workspace:*').kind, 'local')
  assert.equal(k('../sibling').kind, 'local')
})

test('github specifiers: shorthand, git+https, https, owner/repo, with refs', () => {
  assert.deepEqual({ ...k('github:omdsh-dev/dsh-deep-research') }, { kind: 'github', owner: 'omdsh-dev', repo: 'dsh-deep-research', ref: '', refRaw: '' })
  assert.equal(k('github:dream12347/dsh-session-manager#v0.2.2').ref, 'v0.2.2')
  assert.equal(k('git+https://github.com/o/r.git#abc1234').repo, 'r')
  assert.equal(k('git+ssh://git@github.com/o/r.git').owner, 'o')
  assert.equal(k('https://github.com/o/r').kind, 'github')
  assert.equal(k('o/r#main').kind, 'github')
})

test('release tarballs are classified by URL, not by name', () => {
  const c = k('https://github.com/ManoloRemiddi/dsh-steering/releases/download/v0.1.0/dsh-steering-0.1.0.tgz')
  assert.equal(c.kind, 'release'); assert.equal(c.tag, 'v0.1.0'); assert.equal(c.repo, 'dsh-steering'); assert.equal(c.file, 'dsh-steering-0.1.0.tgz')
})

test('everything else is manual and never reaches the registry', () => {
  assert.equal(k('git+https://gitlab.example.com/o/r.git').kind, 'manual')
  assert.equal(k('https://example.com/pkg.tgz').kind, 'manual')
  assert.equal(k('').kind, 'manual')
  assert.equal(k('git@bitbucket.org:o/r.git').kind, 'manual')
})

test('hostile strings do not become repositories', () => {
  assert.notEqual(k('github:../../etc#x').kind, 'github')
  assert.notEqual(k('github:o/r#a b').ref, 'a b')
})

test('upstream and remote parsers', () => {
  assert.deepEqual(parseUpstream('Fisfzy/dsh-ego-browser'), { owner: 'Fisfzy', repo: 'dsh-ego-browser', base: '' })
  assert.equal(parseUpstream('o/r@1.1.2').base, '1.1.2')
  assert.equal(parseUpstream('nonsense'), null)
  assert.deepEqual(githubRemote('https://github.com/PerryLink/dsh-session-pin.git'), { owner: 'PerryLink', repo: 'dsh-session-pin' })
  assert.deepEqual(githubRemote('git@github.com:o/r.git'), { owner: 'o', repo: 'r' })
  assert.equal(githubRemote('/srv/git/local.git'), null)
  assert.equal(githubRemote('https://git.example.com/o/r.git'), null)
})
