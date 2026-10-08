// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The gate's command line: which scenarios run, for which platform and account, and how long each wait may take.
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { repo } from './app.mjs'
import { STARTERS } from './starters.mjs'
import { QA_ACCOUNT } from './util.mjs'

export const SCENARIOS = {
  a: 'Vault: covers, creator logos, no refusals, Feed and Saved',
  b: 'Open a design signed out, then signed in',
  c: 'Accounts: sign-in link, sign out, old link, Send again',
  d: 'Creator page, upload, scan, review, Feed, sealed',
  e: 'Every starter on the A1, 0.4 mm, PLA',
}

export const HELP = `node scripts/gate/run.mjs --app <bridge build> [options]

  --app <path>          The bridge test build (default target/agent-bridge/release/slicerx[.exe]; a .app works)
  --platform <name>     windows, macos or linux (default: this machine's)
  --account <address>   The @qa.slicerx.app account for c and d (and the signed-in half of b)
  --out <dir>           Where the report, screenshots and results.json go (default: a new temp folder)
  --only <list>         Scenarios to run, for example a,b,e (default: all, a b c d e)
  --skip <list>         Scenarios to leave out
  --starters <list>     Starter slugs for e (default: every starter)
  --wait-signin <min>   How long to wait for the operator at each sign-in link (default 10)
  --wait-scan <min>     How long to wait for the malware scan (default 15)
  --wait-review <min>   How long to wait for review approval (default 60)
  --profile <dir>       Reuse this web profile folder instead of a fresh one (Windows, Linux)
  --commit <hash>       The commit the build was made from (default: git HEAD of this checkout)

Scenarios:
${Object.entries(SCENARIOS).map(([k, v]) => `  ${k}  ${v}`).join('\n')}

Exits 0 when every scenario that ran passed, 1 on any FAIL, 2 when it could not start.
`

const PLATFORMS = { win32: 'windows', darwin: 'macos', linux: 'linux' }

/** The run's options from the command line, checked; throws with a message for a person. */
export function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: 'string' },
      platform: { type: 'string' },
      account: { type: 'string' },
      out: { type: 'string' },
      only: { type: 'string' },
      skip: { type: 'string' },
      starters: { type: 'string' },
      'wait-signin': { type: 'string' },
      'wait-scan': { type: 'string' },
      'wait-review': { type: 'string' },
      profile: { type: 'string' },
      commit: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  })
  if (values.help) return { help: true }
  const list = (v) => (v ? v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : [])
  const only = list(values.only)
  const skip = list(values.skip)
  for (const k of [...only, ...skip]) if (!(k in SCENARIOS)) throw new Error(`no scenario ${k}; the scenarios are ${Object.keys(SCENARIOS).join(', ')}`)
  const run = Object.keys(SCENARIOS).filter((k) => (only.length ? only.includes(k) : true) && !skip.includes(k))
  if (!run.length) throw new Error('no scenario left to run')
  const platform = values.platform ?? PLATFORMS[process.platform] ?? process.platform
  if (!Object.values(PLATFORMS).includes(platform)) throw new Error(`--platform is windows, macos or linux, not ${platform}`)
  const account = values.account?.trim().toLowerCase()
  if (account && !QA_ACCOUNT.test(account)) throw new Error(`${account} is not a release-gate account; the gate signs in only with @qa.slicerx.app addresses`)
  if (!account && (run.includes('c') || run.includes('d'))) throw new Error('scenarios c and d need --account <name>@qa.slicerx.app (or --skip c,d)')
  const minutes = (v, def, name) => {
    if (v === undefined) return def
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0 || n > 240) throw new Error(`${name} is minutes between 0 and 240`)
    return n
  }
  const startersList = list(values.starters)
  for (const st of startersList) if (!STARTERS.includes(st)) throw new Error(`no starter ${st}; the starters are ${STARTERS.join(', ')}`)
  const win = process.platform === 'win32'
  return {
    app: resolve(values.app ?? join(repo, 'target', 'agent-bridge', 'release', win ? 'slicerx.exe' : 'slicerx')),
    platform,
    account: account ?? null,
    out: resolve(values.out ?? join(tmpdir(), `sx-gate-${platform}-${new Date().toISOString().replace(/[:.]/g, '-')}`)),
    run,
    starters: startersList.length ? startersList : null,
    waitSignin: minutes(values['wait-signin'], 10, '--wait-signin'),
    waitScan: minutes(values['wait-scan'], 15, '--wait-scan'),
    waitReview: minutes(values['wait-review'], 60, '--wait-review'),
    profile: values.profile ?? null,
    commit: values.commit ?? null,
  }
}
