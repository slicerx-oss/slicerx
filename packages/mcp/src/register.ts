// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** Register only in the current project; dry runs print the same file without writing it. */
export function registerProject(args: string[], cli: string): void {
  const { values } = parseArgs({ args, strict: true, options: {
    client: { type: 'string' }, scope: { type: 'string' },
    'allow-dir': { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' },
  } })
  if (values.client !== 'codex' || values.scope !== 'project') {
    throw new Error('register requires --client codex --scope project')
  }
  const path = resolve('.codex/config.toml')
  const serverArgs = [resolve(cli), ...(values['allow-dir'] ?? []).flatMap((dir) => ['--allow-dir', resolve(dir)]), '--printers', 'off']
  const content = `[mcp_servers.slicerx]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(serverArgs)}\n`
  const result = { client: values.client, scope: values.scope, path, content, written: false }
  if (!values['dry-run']) {
    if (existsSync(dirname(path)) && lstatSync(dirname(path)).isSymbolicLink()) throw new Error('Project .codex directory must not be a symbolic link')
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink() || readFileSync(path, 'utf8') !== content) {
        throw new Error('Project config already exists. Use --dry-run and merge its content into .codex/config.toml.')
      }
    } else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, { flag: 'wx', mode: 0o600 })
      result.written = true
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
