// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Usage: node --test scripts/fold-changes.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { changeFiles, checkChangelog, foldChanges, parseChange, POINTER } from './fold-changes.mjs'

const script = resolve(import.meta.dirname, 'fold-changes.mjs')
const mcp = resolve(import.meta.dirname, '..', 'packages', 'mcp')

const changelog = (unreleased = POINTER) =>
  ['# Changelog', '', 'All notable changes.', '', '## [Unreleased]', '', unreleased, '', '## [0.2.7] - 2026-10-30', '', '### Added', '', '- Old entry.', ''].join('\n')

test('folds change files under the new version: Added, Changed, Fixed, newest file first', () => {
  const changes = [
    { name: 'feat-b.md', text: '### Fixed\n\n- B fixed.\n\n### Added\n\n- B added.\n  More about B.\n' },
    { name: 'feat-a.md', text: '\n### Added\n\n- A added one.\n- A added two.\n\n### Changed\n\n- A changed.\n\n' },
  ]
  assert.equal(
    foldChanges(changelog(), changes, '0.2.8', '2026-11-06'),
    [
      '# Changelog', '', 'All notable changes.', '', '## [Unreleased]', '', POINTER, '',
      '## [0.2.8] - 2026-11-06', '',
      '### Added', '', '- B added.', '  More about B.', '- A added one.', '- A added two.', '',
      '### Changed', '', '- A changed.', '',
      '### Fixed', '', '- B fixed.', '',
      '## [0.2.7] - 2026-10-30', '', '### Added', '', '- Old entry.', '',
    ].join('\n'),
  )
})

test('lists Breaking first and Removed before Fixed, and says so when nothing changed', () => {
  const out = foldChanges(changelog(), [{ name: 'x.md', text: '### Fixed\n- F.\n### Removed\n- R.\n### Breaking\n- K.\n' }], '0.3.0', '2026-12-01')
  assert.match(out, /## \[0\.3\.0\] - 2026-12-01\n\n### Breaking\n\n- K\.\n\n### Removed\n\n- R\.\n\n### Fixed\n\n- F\.\n\n## \[0\.2\.7\]/)
  assert.match(foldChanges(changelog(), [], '0.2.8', '2026-11-06'), /## \[0\.2\.8\] - 2026-11-06\n\nNo changes\.\n\n## \[0\.2\.7\]/)
})

test('refuses a malformed change file, naming it', () => {
  assert.throws(() => parseChange('- no heading\n', 'a.md'), /a\.md: "- no heading" comes before the first ### heading/)
  assert.throws(() => parseChange('### Improved\n- x\n', 'a.md'), /a\.md: "### Improved" is not one of ### Breaking, ### Added/)
  assert.throws(() => parseChange('## Added\n- x\n', 'a.md'), /a\.md: "## Added" is not one of/)
  assert.throws(() => parseChange('### Added\n- x\n### Added\n- y\n', 'a.md'), /a\.md: ### Added appears twice/)
  assert.throws(() => parseChange('### Added\n\n### Fixed\n- y\n', 'a.md'), /a\.md: ### Added has no entry/)
  assert.throws(() => parseChange('### Added\nplain text\n', 'a.md'), /a\.md: the first line under ### Added is not a "- " entry/)
  assert.throws(() => parseChange('\n\n', 'a.md'), /a\.md: no ### Added, ### Changed or ### Fixed heading/)
  assert.deepEqual(parseChange('### Changed\r\n\r\n- Windows line ends.\r\n'), { Changed: '- Windows line ends.' })
})

test('refuses entries written straight into Unreleased, a version already there and a bad version or date', () => {
  assert.throws(() => checkChangelog(changelog(`${POINTER}\n\n### Added\n\n- Edited by hand.`)), /must hold only this line/)
  assert.throws(() => foldChanges(changelog('### Added\n\n- Edited by hand.'), [], '0.2.8', '2026-11-06'), /must hold only this line/)
  assert.throws(() => foldChanges(changelog(), [], '0.2.7', '2026-11-06'), /already has a ## \[0\.2\.7\] section/)
  assert.throws(() => foldChanges(changelog(), [], 'v0.2.8', '2026-11-06'), /not a version/)
  assert.throws(() => foldChanges(changelog(), [], '0.2.8', '11/06/2026'), /not a date/)
  assert.throws(() => checkChangelog('# Changelog\n'), /no "## \[Unreleased\]" section/)
})

test('the command folds a package and deletes its change files, newest commit first, keeping README.md', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sx-fold-'))
  try {
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: tmp, stdio: 'pipe' })
    const commit = (date) => {
      git('add', '.')
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', date], { cwd: tmp, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
    }
    git('init', '-q')
    mkdirSync(join(tmp, 'changes'))
    writeFileSync(join(tmp, 'CHANGELOG.md'), changelog())
    writeFileSync(join(tmp, 'changes', 'README.md'), '# Change files\n')
    writeFileSync(join(tmp, 'changes', 'zz-older.md'), '### Added\n\n- Older.\n')
    commit('2026-11-01T00:00:00Z')
    writeFileSync(join(tmp, 'changes', 'aa-newer.md'), '### Added\n\n- Newer.\n')
    commit('2026-11-02T00:00:00Z')
    writeFileSync(join(tmp, 'changes', 'mm-uncommitted.md'), '### Fixed\n\n- Not committed yet.\n')
    assert.deepEqual(changeFiles(join(tmp, 'changes')).map((c) => c.name), ['mm-uncommitted.md', 'aa-newer.md', 'zz-older.md'])

    assert.match(execFileSync(process.execPath, [script, tmp, '--check'], { encoding: 'utf8' }), /CHANGELOG\.md and 3 change files are well formed/)
    execFileSync(process.execPath, [script, tmp, '0.2.8', '--date', '2026-11-06'], { stdio: 'pipe' })
    assert.match(readFileSync(join(tmp, 'CHANGELOG.md'), 'utf8'), /## \[Unreleased\]\n\n.+\n\n## \[0\.2\.8\] - 2026-11-06\n\n### Added\n\n- Newer\.\n- Older\.\n\n### Fixed\n\n- Not committed yet\.\n\n## \[0\.2\.7\]/)
    assert.deepEqual(readdirSync(join(tmp, 'changes')), ['README.md'])

    // a bad file stops the fold before anything is written or deleted
    const before = readFileSync(join(tmp, 'CHANGELOG.md'), 'utf8')
    writeFileSync(join(tmp, 'changes', 'bad.md'), 'no heading\n')
    const r = (() => {
      try {
        execFileSync(process.execPath, [script, tmp, '0.2.9'], { stdio: 'pipe' })
        return ''
      } catch (e) {
        return String(e.stderr)
      }
    })()
    assert.match(r, /fold-changes: bad\.md: "no heading" comes before the first ### heading/)
    assert.equal(readFileSync(join(tmp, 'CHANGELOG.md'), 'utf8'), before)
    assert.ok(existsSync(join(tmp, 'changes', 'bad.md')))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("@slicerx/mcp's change files are well formed and CHANGELOG.md lists no entry under Unreleased", () => {
  checkChangelog(readFileSync(join(mcp, 'CHANGELOG.md'), 'utf8'))
  for (const c of changeFiles(join(mcp, 'changes'))) parseChange(c.text, `packages/mcp/changes/${c.name}`)
  // a fold of the files on this commit writes a version section, as a release would
  const tmp = mkdtempSync(join(tmpdir(), 'sx-fold-mcp-'))
  try {
    cpSync(join(mcp, 'CHANGELOG.md'), join(tmp, 'CHANGELOG.md'))
    cpSync(join(mcp, 'changes'), join(tmp, 'changes'), { recursive: true })
    execFileSync(process.execPath, [script, tmp, '99.0.0', '--date', '2026-11-06'], { stdio: 'pipe' })
    assert.match(readFileSync(join(tmp, 'CHANGELOG.md'), 'utf8'), /## \[Unreleased\]\n\n.+\n\n## \[99\.0\.0\] - 2026-11-06\n/)
    assert.deepEqual(readdirSync(join(tmp, 'changes')), ['README.md'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
