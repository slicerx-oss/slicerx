// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes TOOLS.md from the tool list, as the server lists it with demo printers and the geometry engine on (a stand-in
// sx-geom; no tool is called). The release that bumps the version runs it through scripts/fold-changes.mjs, so
// TOOLS.md on main can be behind the registry between releases. Run from packages/mcp:
//   pnpm tools-doc            write TOOLS.md
//   pnpm tools-doc --check    exit 1, naming the tools that differ, when TOOLS.md is behind the registry
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { createContext, serverTools } from '../src/index'
import { parseToolsDoc, toolsDoc } from '../src/tooldocs'

const file = join(import.meta.dirname, '..', 'TOOLS.md')
const dir = mkdtempSync(join(tmpdir(), 'sx-tools-doc-'))
try {
  const geom = join(dir, process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')
  writeFileSync(geom, '')
  chmodSync(geom, 0o755)
  const ctx = await createContext({ engine: 'stub', sxGeomBin: geom, printers: 'demo', allowDirs: [dir], outDir: join(dir, 'out'), profilesDir: join(dir, 'profiles'), policy: DEFAULT_POLICY })
  const want = toolsDoc(serverTools(ctx))
  const have = readFileSync(file, 'utf8')
  if (!process.argv.includes('--check')) {
    writeFileSync(file, want)
    console.log(have === want ? 'TOOLS.md is up to date' : 'TOOLS.md written from the tool list')
  } else if (have !== want) {
    const key = (r: { name: string; version: string }) => `${r.name} ${r.version}`
    const now = new Set(parseToolsDoc(want).rows.map(key))
    const old = new Set(parseToolsDoc(have).rows.map(key))
    const added = [...now].filter((k) => !old.has(k))
    const gone = [...old].filter((k) => !now.has(k))
    console.log(`TOOLS.md is behind the tool list: ${added.length} new or changed (${added.slice(0, 5).join(', ') || 'descriptions only'}), ${gone.length} gone or changed`)
    process.exitCode = 1
  } else console.log('TOOLS.md is up to date')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
