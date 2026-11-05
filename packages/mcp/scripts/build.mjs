// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bundles the server into dist/cli-main.js (workspace packages inlined, npm
// dependencies external, the @noble crypto libraries too, since the type declarations
// name them), its entry dist/cli.js (src/launch.ts: the compile cache, then the server),
// and copies the data files it reads into data/.
// With --standalone <dir> it writes the server with every dependency inlined,
// <dir>/slicerx-mcp-main.mjs (plus chunks) and its entry <dir>/slicerx-mcp.mjs, and the data
// into <dir>/data/, for bundles such as the Claude Code plugin that ship without node_modules.
// With --step-reader as well (the desktop app's build) the STEP reader goes beside it in <dir>/step-reader: the
// built @slicerx/step-reader with its NOTICE, license texts and SOURCE.md, checked against the SHA-256 lines there.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(pkg, '..', '..')

const flag = process.argv.indexOf('--standalone')
const standalone = flag >= 0 ? resolve(process.argv[flag + 1] ?? '') : undefined
const withStepReader = process.argv.includes('--step-reader')
if (withStepReader && !standalone) throw new Error('--step-reader goes with --standalone <dir>')
const external = ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*']
// The STEP reader is an optional peer dependency, loaded at run time only when it is installed (slicerx_step_read):
// never inlined, not even in the standalone bundle, so the wasm and its licenses stay in their own package.
const optional = ['@slicerx/step-reader']
const outFile = standalone ? join(standalone, 'slicerx-mcp.mjs') : join(pkg, 'dist', 'cli.js')
// The server itself, loaded by the entry once the compile cache is on (a file beside the entry).
const mainName = standalone ? 'slicerx-mcp-main.mjs' : 'cli-main.js'

// A bundled JSON file becomes a string the module parses with JSON.parse, instead of one large object literal: V8 reads
// a string far faster than it compiles the same data as code, and the profiles and the knowledge index are megabytes.
const JSON_AS_STRING_BYTES = 8 * 1024
const jsonAsString = {
  name: 'json-as-string',
  setup(b) {
    b.onLoad({ filter: /\.json$/ }, (args) => {
      const text = readFileSync(args.path, 'utf8')
      if (text.length < JSON_AS_STRING_BYTES) return undefined
      return { contents: `export default JSON.parse(${JSON.stringify(JSON.stringify(JSON.parse(text)))})`, loader: 'js' }
    })
  },
}

// In the server's CLI entries, Ajv and the YAML parser load on first use (src/deferred.ts, src/sdk-ajv.ts). The npm
// build's src/deferred.ts requires yaml from node_modules when first asked, and the launcher points the SDK's import
// of its Ajv provider at dist/sdk-ajv.js (src/launch.ts). The self-contained build has no node_modules, so both files
// become require() calls that esbuild bundles as modules that run only when first called, and the SDK's server and
// client import the stand-in for their provider. The library entries keep the static yaml import, so a host that
// bundles them takes yaml in.
const srcFile = (name) => join(pkg, 'src', name)
const sdkImporter = /[\\/]@modelcontextprotocol[\\/]sdk[\\/]dist[\\/]esm[\\/](?:server|client)[\\/]index\.js$/
const deferredCli = {
  name: 'deferred-cli',
  setup(b) {
    const replace = (name, contents) =>
      b.onLoad({ filter: new RegExp(`[\\\\/]${name.replace('.', '\\.')}$`) }, (args) =>
        args.path === srcFile(name) ? { contents, loader: 'js', resolveDir: dirname(args.path) } : undefined,
      )
    if (!standalone) {
      replace('deferred.ts', "import { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)\nexport const yaml = () => load('yaml')\n")
      return
    }
    replace('deferred.ts', "export const yaml = () => require('yaml')\n")
    replace('sdk-ajv-load.ts', "export const sdkAjv = () => require('@modelcontextprotocol/sdk/validation/ajv')\n")
    b.onResolve({ filter: /^\.\.\/validation\/ajv-provider\.js$/ }, (args) => (sdkImporter.test(args.importer) ? { path: srcFile('sdk-ajv.ts') } : undefined))
  },
}

if (!standalone) rmSync(join(pkg, 'dist'), { recursive: true, force: true })
await build({
  entryPoints: standalone ? { 'slicerx-mcp-main': join(pkg, 'src', 'cli.ts') } : { 'cli-main': join(pkg, 'src', 'cli.ts') },
  // Code splitting keeps dynamic imports in their own chunks, so a server loads the stock printer profiles only when a
  // tool reads them. Without it esbuild also wraps shared modules in lazy initializers, and in the self-contained build
  // zod's schemas are then used before they exist.
  outdir: standalone ?? join(pkg, 'dist'),
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  ...(standalone ? { outExtension: { '.js': '.mjs' } } : {}),
  plugins: [jsonAsString, deferredCli],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: standalone ? optional : [...external, ...optional],
  // Bundled CommonJS dependencies call require(); give the ESM output one.
  ...(standalone ? { banner: { js: "import { createRequire as __sxCreateRequire } from 'node:module'; const require = __sxCreateRequire(import.meta.url);" } } : {}),
  // The self-contained build has no node_modules beside it, so a missing STEP reader is not an npm install away.
  define: { __SLICERX_STANDALONE__: standalone ? 'true' : 'false' },
  legalComments: standalone ? 'eof' : 'inline',
  logLevel: 'warning',
})
// The entry: node built-ins only, so it loads in no time and nothing else is compiled before the cache is on.
await build({
  entryPoints: [join(pkg, 'src', 'launch.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  define: { SX_MCP_MAIN: JSON.stringify(`./${mainName}`), ...(standalone ? {} : { SX_MCP_AJV: JSON.stringify('./sdk-ajv.js') }) },
  legalComments: 'inline',
  logLevel: 'warning',
})
// The npm build's stand-in for the SDK's Ajv provider: a file of its own, since the SDK's import is pointed at it.
if (!standalone) {
  await build({
    entryPoints: [join(pkg, 'src', 'sdk-ajv.ts')],
    outfile: join(pkg, 'dist', 'sdk-ajv.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: [...external, ...optional],
    legalComments: 'inline',
    logLevel: 'warning',
  })
}

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
    external: [...external, ...optional],
    define: { __SLICERX_STANDALONE__: 'false' },
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
// The X mark, served as sample:x-mark: the showcase model, whose exact faces look right up close.
mkdirSync(join(data, 'samples'), { recursive: true })
cpSync(join(repo, 'packages', 'core', 'bench', 'models', 'x-mark-showcase.stl'), join(data, 'samples', 'x-mark-showcase.stl'))
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
  [join(repo, 'docs', 'integrators', 'updates.md'), 'integrators/updates.md'],
  [join(repo, 'docs', 'integrators', 'kit-manifest.md'), 'integrators/kit-manifest.md'],
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

// The STEP reader beside the self-contained server, where the server looks for it first (src/toolbox/step-read.ts).
if (standalone) {
  const dir = join(standalone, 'step-reader')
  rmSync(dir, { recursive: true, force: true })
  if (withStepReader) {
    const reader = join(repo, 'packages', 'step-reader')
    execFileSync(process.execPath, [join(reader, 'scripts', 'build.mjs'), dir], { stdio: 'inherit' })
    // Type declarations are for the npm package only.
    rmSync(join(dir, 'src-types'), { recursive: true, force: true })
    for (const f of readdirSync(dir)) if (f.endsWith('.d.ts')) rmSync(join(dir, f))
    // ES modules with a .js name, wherever the folder is unpacked.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@slicerx/step-reader', private: true, type: 'module' }, null, 2) + '\n')
    for (const f of readdirSync(reader)) {
      if (f === 'NOTICE' || f === 'SOURCE.md' || f === 'OCCT_LGPL_EXCEPTION.txt' || /^LICENSE-.+/.test(f)) cpSync(join(reader, f), join(dir, f))
    }
    // The object code shipped must be the one the source offer describes.
    const source = readFileSync(join(reader, 'SOURCE.md'), 'utf8')
    for (const f of ['occt-import-js.mjs', 'occt-import-js.wasm']) {
      const sha = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')
      const line = source.split('\n').find((l) => l.startsWith(`- \`${f}\``))
      if (!line?.includes(sha)) throw new Error(`step-reader/${f} (sha256 ${sha}) is not the build packages/step-reader/SOURCE.md lists`)
    }
  }
}

// Self-contained type declarations for the library entries.
if (!standalone) {
  execFileSync(process.execPath, [join(repo, 'scripts', 'emit-types.mjs'), pkg, 'index=src/index.ts', 'agents=src/agents.ts'], { stdio: 'inherit' })
}
console.log(`built ${outFile} and ${data}`)
