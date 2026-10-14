// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { registerProject } from '../packages/mcp/src/register.ts'

test('project registration previews, preserves existing settings and refuses user scope', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sx-register-'))
  const previous = process.cwd()
  const args = ['--client', 'codex', '--scope', 'project', '--allow-dir', 'my models']
  const output = []
  t.mock.method(process.stdout, 'write', (value) => { output.push(JSON.parse(value)); return true })
  try {
    process.chdir(root)
    registerProject([...args, '--dry-run'], '/app/cli.js')
    assert.equal(existsSync('.codex'), false)
    const preview = output.at(-1)
    assert.equal(preview.path, join(root, '.codex/config.toml'))
    assert.equal(preview.written, false)
    registerProject(args, '/app/cli.js')
    assert.equal(output.at(-1).written, true)
    assert.equal(readFileSync(preview.path, 'utf8'), preview.content)
    registerProject(args, '/app/cli.js')
    assert.equal(output.at(-1).written, false)
    writeFileSync(preview.path, '# keep this\n')
    assert.throws(() => registerProject(args, '/app/cli.js'), /already exists/)
    assert.equal(readFileSync(preview.path, 'utf8'), '# keep this\n')
    assert.throws(() => registerProject(['--client', 'codex', '--scope', 'user'], '/app/cli.js'), /--scope project/)
  } finally {
    process.chdir(previous)
    rmSync(root, { recursive: true, force: true })
  }
})

test('project registration does not follow a config directory symlink', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sx-register-'))
  const other = mkdtempSync(join(tmpdir(), 'sx-register-other-'))
  const previous = process.cwd()
  try {
    process.chdir(root)
    symlinkSync(other, '.codex', process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => registerProject(['--client', 'codex', '--scope', 'project'], '/app/cli.js'), /symbolic link/)
    assert.equal(existsSync(join(other, 'config.toml')), false)
  } finally {
    process.chdir(previous)
    rmSync(root, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})
