// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function commands(metadata, part) {
  if (!['main', 'slow'].includes(part)) throw new Error('Expected main or slow')
  const core = metadata.packages.find((p) => p.name === 'sx-core' && metadata.workspace_members.includes(p.id))
  if (!core) throw new Error('Missing sx-core workspace package')
  const tests = core.targets.filter((t) => t.kind.includes('test')).map((t) => t.name).sort()
  const slow = ['firmware', 'requests']
  for (const name of slow) if (!tests.includes(name)) throw new Error(`Missing integration target: ${name}`)
  const selected = part === 'slow' ? slow : tests.filter((name) => !slow.includes(name))
  const integrations = ['test', '--locked', '-p', 'sx-core', ...selected.flatMap((name) => ['--test', name])]
  if (part === 'slow') return [integrations]
  return [
    ['test', '--locked', '--workspace', '--exclude', 'slicerx-desktop', '--exclude', 'sx-core'],
    ['test', '--locked', '-p', 'sx-core', '--lib', '--bins', '--examples'],
    ...(selected.length ? [integrations] : []),
    ['test', '--locked', '-p', 'sx-core', '--doc'],
  ]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const metadata = spawnSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], { encoding: 'utf8' })
  if (metadata.error) throw metadata.error
  if (metadata.status !== 0) {
    process.stderr.write(metadata.stderr)
    process.exit(metadata.status ?? 1)
  }
  const plan = commands(JSON.parse(metadata.stdout), process.argv[2])
  if (process.argv.includes('--plan')) console.log(JSON.stringify(plan, null, 2))
  else for (const args of plan) {
    console.log(`cargo ${args.join(' ')}`)
    const result = spawnSync('cargo', args, { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
