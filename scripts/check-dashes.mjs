// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fails when an em dash (U+2014) or en dash (U+2013) appears in tracked text files.
// Usage: node scripts/check-dashes.mjs [paths...]   (defaults to the source trees)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'

const roots = process.argv.slice(2)
const defaults = ['docs', 'apps', 'packages', 'supabase', 'scripts', 'README.md', 'CONTRIBUTING.md']
// Generated bundles carry third-party text we don't control; their sources are checked instead.
const generated = [/^packages\/claude-plugin\/server\//, /^packages\/mcp\/dist\//, /^packages\/mcp\/data\//, /\/dist\//]
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)

// Third-party code and data keep their own wording. Vendored code sits in a folder with a SOURCE.md
// (THIRD-PARTY.md), and the data files that cannot carry a header are the paths REUSE.toml annotates.
const vendored = git(['ls-files', '--', ':(glob)**/SOURCE.md']).map((f) => `${posix.dirname(f)}/`)
const annotated = existsSync('REUSE.toml') ? [...readFileSync('REUSE.toml', 'utf8').matchAll(/^path\s*=\s*(.+)$/gm)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((q) => q[1])) : []
const thirdParty = (f) => vendored.some((dir) => f.startsWith(dir)) || annotated.some((glob) => posix.matchesGlob(f, glob))

const files = git(['ls-files', '-co', '--exclude-standard', '--', ...(roots.length ? roots : defaults)])
  .filter((f) => !generated.some((re) => re.test(f)))
  .filter((f) => !thirdParty(f))

const bad = new RegExp('[' + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + ']')
let hits = 0
for (const f of files) {
  let text
  try { text = readFileSync(f, 'utf8') } catch { continue }
  if (text.includes('\u0000')) continue
  text.split('\n').forEach((line, i) => {
    if (bad.test(line)) { hits++; console.log(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`) }
  })
}
if (hits) { console.error(`check-dashes: ${hits} line(s) with an em or en dash`); process.exit(1) }
