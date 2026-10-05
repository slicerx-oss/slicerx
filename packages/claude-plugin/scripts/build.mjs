// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds a development copy of the plugin in .dev/ whose MCP server is a local
// build of packages/mcp instead of the published npm package. Use it to try the
// plugin and run its evals before @slicerx/mcp is on npm:
//   claude --plugin-dir packages/claude-plugin/.dev
//   claude plugin eval packages/claude-plugin/.dev --allow-real-servers ...
import { execFileSync } from 'node:child_process'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = join(dirname(fileURLToPath(import.meta.url)), '..')
const dev = join(plugin, '.dev')
rmSync(dev, { recursive: true, force: true })
for (const entry of ['.claude-plugin', 'skills', 'commands', 'evals', 'README.md', 'LICENSE']) {
  cpSync(join(plugin, entry), join(dev, entry), { recursive: true, filter: (src) => !src.includes(`${join('evals', 'results')}`) })
}
execFileSync(process.execPath, [join(plugin, '..', 'mcp', 'scripts', 'build.mjs'), '--standalone', join(dev, 'server')], { stdio: 'inherit' })

// Same server entry and settings as the published plugin, started from the local build.
const mcp = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8'))
mcp.slicerx.command = 'node'
mcp.slicerx.args = ['${CLAUDE_PLUGIN_ROOT}/server/slicerx-mcp.mjs']
writeFileSync(join(dev, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`)
console.log(`development plugin in ${dev}`)
