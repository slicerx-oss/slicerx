// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Regenerates the checked-in generated files in place and fails when any of them differs from what is committed.
// Each generator reads only files in this repo (no network, no environment, nothing outside the checkout) and
// writes the same bytes every time. All generators run even after one fails, so a single run lists every file
// that needs regenerating, together with the command that fixes it.
//
//   node scripts/check-generated.mjs              run every generator
//   node scripts/check-generated.mjs "ui gen:icons"   run only the named ones (names as in the list below)
//
// The generators write into the working tree, so after a failure the regenerated files are there to commit.
// Run it on Linux or macOS (or in WSL), as CI does: on Windows gen:profiles cannot load the printer catalog and kb:build
// writes backslashes into kb.json, so those two report drift that is not there.
// Output is compared with what git has, so a regenerated file that is not committed yet still counts as drift.
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const win = process.platform === 'win32'

// Order matters where one generator reads another's output: knowledge.json feeds the printer profiles, and
// the icon tables feed design/icons.js.
const GENERATORS = [
  { name: 'settings gen:knowledge', run: ['pnpm', '--filter', '@slicerx/settings', 'gen:knowledge'], outputs: ['packages/settings/knowledge.json'] },
  { name: 'settings gen:profiles', run: ['pnpm', '--filter', '@slicerx/settings', 'gen:profiles'], outputs: ['packages/settings/profiles/printers.json'] },
  { name: 'settings gen:defaults', run: ['pnpm', '--filter', '@slicerx/settings', 'gen:defaults'], outputs: ['packages/settings/defaults.json'] },
  { name: 'settings gen:reference', run: ['pnpm', '--filter', '@slicerx/settings', 'gen:reference'], outputs: ['packages/settings/docs/reference'] },
  { name: 'pilot kb:build', run: ['pnpm', '--filter', '@slicerx/pilot', 'kb:build'], outputs: ['packages/pilot/src/kb/generated/kb.json'] },
  {
    name: 'ui gen:icons',
    run: ['pnpm', '--filter', '@slicerx/ui', 'gen:icons'],
    outputs: ['icon-names', 'icon-startup', 'icon-small', 'icon-paths'].map((f) => `packages/ui/src/icons/${f}.ts`),
  },
  { name: 'design sync', run: ['node', 'design/sync.mjs'], outputs: ['design/tokens.css', 'design/icons.js'] },
  { name: 'edition-config neutral', run: ['pnpm', '--filter', '@slicerx/edition-config', 'neutral'], outputs: ['packages/edition-config/src/neutral.generated.ts'] },
]

const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const tail = (text, lines) => text.trimEnd().split('\n').slice(-lines).join('\n')

const wanted = process.argv.slice(2)
const unknown = wanted.filter((w) => !GENERATORS.some((g) => g.name === w))
if (unknown.length) {
  console.error(`unknown generator: ${unknown.join(', ')}\nknown: ${GENERATORS.map((g) => g.name).join(', ')}`)
  process.exit(2)
}

if (win) console.log('note: on Windows, settings gen:profiles and pilot kb:build give different output than on Linux; trust a Linux or WSL run.\n')
const failures = []
const started = Date.now()
for (const gen of GENERATORS.filter((g) => !wanted.length || wanted.includes(g.name))) {
  const t0 = Date.now()
  const command = gen.run.join(' ')
  // pnpm is a .cmd shim on Windows, which spawn only finds through a shell
  const result = spawnSync(gen.run[0], gen.run.slice(1), { cwd: root, encoding: 'utf8', shell: win, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 })
  let problem = ''
  if (result.error || result.status !== 0) {
    problem = `the generator failed (${result.error ? result.error.message : `exit ${result.status}`})\n${tail(`${result.stdout ?? ''}${result.stderr ?? ''}`, 15)}`
  }
  // Modified, deleted and new files all show up in a status listing; a plain diff would miss new ones.
  const status = git(['status', '--porcelain=v1', '-uall', '--', ...gen.outputs]).stdout.split('\n').filter(Boolean)
  if (status.length) {
    const stat = git(['diff', '--stat', '--', ...gen.outputs]).stdout.trimEnd()
    const untracked = status.filter((l) => l.startsWith('??')).map((l) => l.slice(3))
    problem += `${problem ? '\n' : ''}generated output differs from what is committed:\n${status.map((l) => `  ${l}`).join('\n')}${stat ? `\n${stat}` : ''}${untracked.length ? `\n  (${untracked.length} new file${untracked.length === 1 ? '' : 's'} not tracked yet)` : ''}`
  }
  const seconds = ((Date.now() - t0) / 1000).toFixed(1)
  if (problem) {
    failures.push(gen)
    console.log(`FAIL ${gen.name} (${seconds}s)\n  fix: ${command}\n${problem.split('\n').map((l) => `  ${l}`).join('\n')}\n`)
  } else {
    console.log(`ok   ${gen.name} (${seconds}s)`)
  }
}

const total = ((Date.now() - started) / 1000).toFixed(1)
if (failures.length) {
  console.log(`\n${failures.length} generated ${failures.length === 1 ? 'file set is' : 'file sets are'} out of date (${total}s). Run these in this order, then commit the result:`)
  for (const gen of failures) console.log(`  ${gen.run.join(' ')}`)
  process.exit(1)
}
console.log(`\nall generated files are current (${total}s)`)
