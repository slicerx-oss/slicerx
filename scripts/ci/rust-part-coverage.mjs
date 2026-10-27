// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { commands, loadWeights } from './windows-rust-tests.mjs'

// Proves that the Rust test parts of ci.yml cover every test file once. The files come from the disk (each package's
// tests directory), the targets from cargo metadata, and the parts from the same code the jobs run
// (windows-rust-tests.mjs). It also reads ci.yml, to see that each job's matrix has as many parts as the --of it passes.
//
//   node scripts/ci/rust-part-coverage.mjs [--metadata <file>]
//
// Exit 0 when every sx-core test file is in exactly one part of every split, every other package's test files are run by
// the one workspace command, and the workflow agrees with the split. Exit 1 with a list of what is wrong otherwise.

// The splits ci.yml runs. job is the workflow job of the parts; extra lists the sx-core test targets that have a part
// of their own beside the split (the hosted Linux split keeps firmware and requests apart).
export const SPLITS = [
  { name: 'macOS', job: 'rust-macos-parts', of: 2 },
  { name: 'Windows', job: 'rust-windows-parts', of: 3 },
  { name: 'hosted Linux core', job: 'rust-tests-part', of: 2, coreOnly: true, extra: ['firmware', 'requests'] },
]

// The targets cargo finds in a package's tests directory: tests/name.rs and tests/name/main.rs.
export function diskTargets(packageDir) {
  const dir = join(packageDir, 'tests')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => {
      const path = join(dir, entry)
      return statSync(path).isDirectory() ? existsSync(join(path, 'main.rs')) : entry.endsWith('.rs')
    })
    .map((entry) => entry.replace(/\.rs$/, ''))
    .sort()
}

const testNames = (pkg) => pkg.targets.filter((t) => t.kind.includes('test')).map((t) => t.name).sort()
const selected = (plan) => plan.flatMap((args) => args.flatMap((arg, i) => (arg === '--test' ? [args[i + 1]] : [])))

// The text of one job of the workflow: from its "  id:" line to the next job.
function jobText(workflow, id) {
  const start = workflow.search(new RegExp(`^  ${id}:\\s*$`, 'm'))
  if (start < 0) return null
  const rest = workflow.slice(start + 1)
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m)
  return next < 0 ? rest : rest.slice(0, next)
}

export function check({ root, metadata, weights, workflow }) {
  const problems = []
  const lines = []
  const members = metadata.packages.filter((p) => metadata.workspace_members.includes(p.id))

  // 1. The files on disk are the targets cargo knows (a file cargo skips would never run in any part).
  for (const pkg of members) {
    const dir = dirname(pkg.manifest_path)
    const disk = diskTargets(dir)
    const targets = testNames(pkg)
    const where = relative(root, dir).replaceAll('\\', '/') || '.'
    for (const name of disk) if (!targets.includes(name)) problems.push(`${where}/tests/${name}: on disk, but cargo has no test target of that name`)
    for (const name of targets) if (!disk.includes(name)) problems.push(`${where}: test target ${name} has no file in tests/`)
  }

  const core = members.find((p) => p.name === 'sx-core')
  if (!core) throw new Error('Missing sx-core workspace package')
  const coreFiles = diskTargets(dirname(core.manifest_path))
  const others = members.filter((p) => p.name !== 'sx-core' && p.name !== 'slicerx-desktop')

  // 2. Every sx-core file is in exactly one part of each split, and the workspace command is in one part.
  for (const split of SPLITS) {
    const plans = Array.from({ length: split.of }, (_, i) => commands(metadata, i + 1, { of: split.of, weights, coreOnly: Boolean(split.coreOnly) }))
    const count = new Map(coreFiles.map((name) => [name, 0]))
    for (const name of [...plans.flatMap(selected), ...(split.extra ?? [])]) count.set(name, (count.get(name) ?? 0) + 1)
    for (const [name, n] of count) {
      if (n === 0) problems.push(`${split.name}: sx-core test ${name} is in no part`)
      else if (n > 1) problems.push(`${split.name}: sx-core test ${name} is in ${n} parts`)
      else if (!coreFiles.includes(name)) problems.push(`${split.name}: ${name} is in a part but not in packages/core/tests`)
    }
    const perPart = plans.map((plan) => selected(plan).length)
    if (!split.coreOnly) {
      const workspace = plans.map((plan) => plan.filter((args) => args.includes('--workspace')).length)
      const unit = plans.map((plan) => plan.filter((args) => args.includes('--lib')).length)
      const doc = plans.map((plan) => plan.filter((args) => args.includes('--doc')).length)
      for (const [label, n] of [['workspace command', workspace], ['sx-core unit tests', unit], ['sx-core doctests', doc]]) {
        if (n[0] !== 1 || n.slice(1).some((x) => x !== 0)) problems.push(`${split.name}: the ${label} must run once, in part 1 (runs per part: ${n.join(', ')})`)
      }
      const filters = plans.flat().filter((args) => args.includes('--workspace') && args.includes('--test'))
      if (filters.length) problems.push(`${split.name}: the workspace command has a --test filter, so other crates' tests would be left out`)
    }
    lines.push(`${split.name}, ${split.of} parts: sx-core ${coreFiles.length} files, ${perPart.join(' + ')}${split.extra ? ` + ${split.extra.join(', ')} in parts of their own` : ''}${split.coreOnly ? '' : ', everything else in part 1'}`)
  }

  // 3. The other packages' test files run in the workspace command (part 1 of macOS and Windows, the crates part on Linux).
  for (const pkg of others) {
    const dir = dirname(pkg.manifest_path)
    const files = diskTargets(dir)
    if (files.length) lines.push(`${pkg.name}: ${files.length} test files (${relative(root, dir).replaceAll('\\', '/')}/tests), run by the workspace command`)
  }

  // 4. The workflow has as many parts as the split uses, and the Linux parts the commands the split relies on.
  if (workflow !== undefined) {
    for (const split of SPLITS) {
      const text = jobText(workflow, split.job)
      if (text === null) {
        problems.push(`ci.yml has no job ${split.job}`)
        continue
      }
      if (split.coreOnly) {
        if (!/--of 2 --core-only/.test(text)) problems.push(`ci.yml ${split.job}: the hosted core step must pass --of ${split.of} --core-only`)
        if (!/core-a/.test(text) || !/core-b/.test(text)) problems.push(`ci.yml ${split.job}: the matrix needs core-a and core-b`)
        for (const name of split.extra) if (!new RegExp(`matrix\\.part == '${name}'`).test(text)) problems.push(`ci.yml ${split.job}: no step for the ${name} part`)
        if (!/--workspace --exclude slicerx-desktop --exclude sx-core --test '\*'/.test(text)) problems.push(`ci.yml ${split.job}: the crates part must run every other crate's tests with --test '*'`)
        continue
      }
      const matrix = text.match(/^\s*part:\s*\[([^\]]*)\]/m)
      const parts = matrix ? matrix[1].split(',').map((x) => x.trim()).filter(Boolean) : []
      if (parts.length !== split.of || parts.some((x, i) => x !== String(i + 1))) problems.push(`ci.yml ${split.job}: the matrix has parts [${parts.join(', ')}], the split has ${split.of} (1 to ${split.of})`)
      const ofs = [...text.matchAll(/windows-rust-tests\.mjs \$\{\{ matrix\.part \}\} --of (\d+)/g)].map((m) => Number(m[1]))
      if (ofs.length !== 1 || ofs[0] !== split.of) problems.push(`ci.yml ${split.job}: the test step must pass --of ${split.of} once (found ${ofs.join(', ') || 'none'})`)
      if (!/save-if: \$\{\{ matrix\.part == 1 \}\}/.test(text)) problems.push(`ci.yml ${split.job}: only part 1 may save the cache (save-if: \${{ matrix.part == 1 }})`)
    }
  }
  return { problems, lines }
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const i = process.argv.indexOf('--metadata')
  let metadata
  if (i >= 0) metadata = JSON.parse(readFileSync(process.argv[i + 1], 'utf8'))
  else {
    const result = spawnSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    if (result.error) throw result.error
    if (result.status !== 0) {
      process.stderr.write(result.stderr)
      process.exit(result.status ?? 1)
    }
    metadata = JSON.parse(result.stdout)
  }
  const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  const { problems, lines } = check({ root, metadata, weights: loadWeights(), workflow })
  for (const line of lines) console.log(line)
  if (problems.length) {
    console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log('every test file is in exactly one part')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
