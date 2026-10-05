// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bundles the server into dist/cli.js (workspace packages inlined, npm
// dependencies external) and copies the data files it reads into data/.
// With --standalone <dir> it writes one self-contained file with every
// dependency inlined, <dir>/slicerx-mcp.mjs (plus chunks), and the data into <dir>/data/,
// for bundles such as the Claude Code plugin that ship without node_modules.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(pkg, '..', '..')

const flag = process.argv.indexOf('--standalone')
const standalone = flag >= 0 ? resolve(process.argv[flag + 1] ?? '') : undefined
const outFile = standalone ? join(standalone, 'slicerx-mcp.mjs') : join(pkg, 'dist', 'cli.js')

if (!standalone) rmSync(join(pkg, 'dist'), { recursive: true, force: true })
await build({
  entryPoints: standalone ? { 'slicerx-mcp': join(pkg, 'src', 'cli.ts') } : [join(pkg, 'src', 'cli.ts')],
  // Code splitting keeps dynamic imports in their own chunks. Without it esbuild wraps shared
  // modules in lazy initializers, and zod's schemas are then used before they exist.
  ...(standalone ? { outdir: standalone, splitting: true, outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]' } : { outfile: outFile }),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: standalone ? [] : ['@modelcontextprotocol/sdk', 'zod', 'yaml'],
  // Bundled CommonJS dependencies call require(); give the ESM output one.
  ...(standalone ? { banner: { js: "import { createRequire as __sxCreateRequire } from 'node:module'; const require = __sxCreateRequire(import.meta.url);" } } : {}),
  legalComments: standalone ? 'eof' : 'inline',
  logLevel: 'warning',
})

// The library entries for hosts that start the server in-process (createContext, createSlicerxServer)
// and for apps that write MCP client configs (agents).
if (!standalone) {
  await build({
    entryPoints: [join(pkg, 'src', 'index.ts'), join(pkg, 'src', 'agents.ts')],
    outdir: join(pkg, 'dist'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['@modelcontextprotocol/sdk', 'zod', 'yaml'],
    legalComments: 'inline',
    logLevel: 'warning',
  })
}

const data = join(standalone ?? pkg, 'data')
rmSync(data, { recursive: true, force: true })
mkdirSync(join(data, 'settings'), { recursive: true })
mkdirSync(join(data, 'connect'), { recursive: true })
cpSync(join(repo, 'knowledge'), join(data, 'knowledge'), { recursive: true })
cpSync(join(repo, 'packages', 'connect', 'fixtures', 'demo-fleet.json'), join(data, 'connect', 'demo-fleet.json'))
// The reference X, served as sample:x-mark.
mkdirSync(join(data, 'samples'), { recursive: true })
cpSync(join(repo, 'packages', 'core', 'bench', 'models', 'x-mark.stl'), join(data, 'samples', 'x-mark.stl'))
// Integrator guides served as slicerx://docs/... resources (see src/docs.ts for the ids).
const docs = join(data, 'docs')
mkdirSync(docs, { recursive: true })
for (const [from, to] of [
  [join(repo, 'docs', 'install.md'), 'install.md'],
  [join(repo, 'docs', 'embedding.md'), 'embedding.md'],
  [join(repo, 'docs', 'build-on-the-engine.md'), 'build-on-the-engine.md'],
  [join(repo, 'packages', 'ui', 'THEMING.md'), 'theming-ui.md'],
  [join(repo, 'packages', 'ui', 'viewport', 'THEMING.md'), 'theming-viewport.md'],
  [join(pkg, 'README.md'), 'mcp.md'],
  [join(repo, 'docs', 'integrators', 'AGENTS.md'), 'integrators/AGENTS.md'],
  [join(repo, 'docs', 'integrators', 'quickstart.md'), 'integrators/quickstart.md'],
]) {
  if (!existsSync(from)) continue
  mkdirSync(dirname(join(docs, to)), { recursive: true })
  cpSync(from, join(docs, to))
}
const settingsDocs = join(repo, 'packages', 'settings', 'docs')
if (existsSync(settingsDocs)) cpSync(settingsDocs, join(docs, 'settings'), { recursive: true })
const printerDocs = join(repo, 'packages', 'connect', 'docs')
if (existsSync(printerDocs)) cpSync(printerDocs, join(docs, 'printers'), { recursive: true })
// The bundle inlines the stock printer profiles (packages/profiles), which are AGPL-3.0-or-later, and the
// UltiMaker profiles from Cura (packages/profiles/cura), which are LGPL-3.0-or-later.
cpSync(join(repo, 'packages', 'profiles', 'LICENSE'), join(standalone ?? join(pkg, 'dist'), 'LICENSE-AGPL-profiles.txt'))
cpSync(join(repo, 'packages', 'profiles', 'cura', 'LICENSE'), join(standalone ?? join(pkg, 'dist'), 'LICENSE-LGPL-cura-profiles.txt'))

// Self-contained type declarations for the library entries.
if (!standalone) {
  execFileSync(process.execPath, [join(repo, 'scripts', 'emit-types.mjs'), pkg, 'index=src/index.ts', 'agents=src/agents.ts'], { stdio: 'inherit' })
}
console.log(`built ${outFile} and ${data}`)
