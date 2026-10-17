// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { withWindowsCredential } from '../../../packages/mcp/test/helpers/windows-credential'

/** A remembered test credential, isolated from installed clients on every platform. */
export async function withClientCredential<T>(dir: string, key: string, use: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const base = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !entry[0].toUpperCase().startsWith('SLICERX_MCP_LINK')))
  const environment = (ref: string, identifier: string) => ({ ...base, SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier })
  if (process.platform === 'win32') return withWindowsCredential(key, (ref, identifier) => use(environment(ref, identifier)))

  const ref = 'slicerx-agent-test'
  const identifier = `app.slicerx.test.${randomUUID()}`
  const bin = join(dir, 'bin')
  const keyFile = join(dir, 'key')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(keyFile, key, { mode: 0o600 })
  mkdirSync(bin)
  const script = `#!/bin/sh\nfor a in "$@"; do [ "$a" = ${quote(`${ref}.${identifier}`)} ] && exec cat ${quote(keyFile)}; done\nexit 44\n`
  for (const tool of ['security', 'secret-tool']) {
    const path = join(bin, tool)
    writeFileSync(path, script)
    chmodSync(path, 0o755)
  }
  return use({ ...environment(ref, identifier), PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` })
}
