// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Usage: node scripts/devkit-eval.mjs [path/to/installed/mcp/dist/cli.js]
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cli = resolve(process.argv[2] ?? 'packages/mcp/dist/cli.js')
const project = mkdtempSync(join(tmpdir(), 'sx-devkit-eval-'))
const args = [cli, 'register', '--client', 'codex', '--scope', 'project', '--allow-dir', 'models with spaces']
const run = (extra = []) => JSON.parse(execFileSync(process.execPath, [...args, ...extra], { cwd: project, encoding: 'utf8' }))
try {
  const preview = run(['--dry-run'])
  assert.equal(preview.scope, 'project')
  assert.equal(preview.path, join(project, '.codex', 'config.toml'))
  assert.equal(preview.written, false)
  assert.equal(existsSync(join(project, '.codex')), false)
  assert.match(preview.content, /^\[mcp_servers\.slicerx\]\n/)
  const command = JSON.parse(preview.content.split('\n')[1].slice('command = '.length))
  const serverArgs = JSON.parse(preview.content.split('\n')[2].slice('args = '.length))
  assert.equal(command, process.execPath)
  assert.deepEqual(serverArgs, [cli, '--allow-dir', join(project, 'models with spaces'), '--printers', 'off'])
  assert.equal(run().written, true)
  assert.equal(readFileSync(preview.path, 'utf8'), preview.content)
  assert.equal(run().written, false)
  writeFileSync(preview.path, '# existing project settings\n')
  assert.equal(run(['--dry-run']).written, false)
  const refused = spawnSync(process.execPath, args, { cwd: project, encoding: 'utf8' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /already exists/)
  assert.equal(readFileSync(preview.path, 'utf8'), '# existing project settings\n')
  const invalid = spawnSync(process.execPath, [cli, 'register', '--client', 'codex', '--scope', 'user'], { cwd: project, encoding: 'utf8' })
  assert.equal(invalid.status, 1)
  console.log('Project registration: dry-run, paths, write, repeat, existing-file preservation and scope checks passed.')
} finally {
  rmSync(project, { recursive: true, force: true })
}
