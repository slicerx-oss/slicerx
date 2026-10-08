#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The release gate (docs/release-gate.md): one command that starts a bridge test build of the desktop app, drives it
// through the running-app MCP server (packages/app-bridge) against the backend it was built for, runs the scenarios,
// writes an HTML report with screenshots and stops the app by its process id. The same on Windows, macOS and Linux.
// It never prints, sends to a printer or deletes anything, and never reads mail or touches a sign-in code: where a
// link must be opened it says which and waits for an operator.
//   node scripts/gate/run.mjs --app <bridge build> --platform windows --account qa-win@qa.slicerx.app --out <dir>
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { basename, join } from 'node:path'
import { appExecutable, connectBridge, repo, startApp } from './lib/app.mjs'
import { createContext } from './lib/context.mjs'
import { HELP, options, SCENARIOS } from './lib/options.mjs'
import { renderReport, runStatus } from './lib/report.mjs'
import { mask, sha256File } from './lib/util.mjs'
import { accounts } from './scenarios/accounts.mjs'
import { openSignedIn, openSignedOut } from './scenarios/open.mjs'
import { start } from './scenarios/start.mjs'
import { starters } from './scenarios/starters.mjs'
import { upload } from './scenarios/upload.mjs'
import { vault } from './scenarios/vault.mjs'

function gitHead() {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

async function main() {
  let opts
  try {
    opts = options(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${HELP}`)
    return 2
  }
  if (opts.help) {
    process.stdout.write(HELP)
    return 0
  }
  mkdirSync(opts.out, { recursive: true })
  const log = (line) => process.stdout.write(`${mask(line)}\n`)
  const exe = appExecutable(opts.app)
  const result = {
    tool: 'slicerx-release-gate',
    format: 1,
    platform: opts.platform,
    host: `${process.platform} ${release()}, node ${process.version}`,
    account: opts.account,
    commit: opts.commit ?? gitHead(),
    build: { file: basename(exe), kind: 'bridge test build' },
    startedAt: new Date().toISOString(),
    scenarios: [],
    notes: [],
  }
  const write = () => {
    result.endedAt = new Date().toISOString()
    result.status = runStatus(result)
    writeFileSync(join(opts.out, 'results.json'), `${JSON.stringify(result, null, 2)}\n`)
    writeFileSync(join(opts.out, 'report.html'), renderReport([result]))
  }
  log(`release gate: ${opts.platform}, scenarios ${opts.run.join(' ')}, report in ${opts.out}`)
  let app = null
  let bridge = null
  const stop = async () => {
    await bridge?.close()
    if (app) {
      const stopped = await app.stop()
      log(`stopped the app, pid ${app.pid}${stopped ? '' : ' (it did not exit)'}`)
      app = null
    }
  }
  process.on('SIGINT', () => {
    result.notes.push('stopped by an interrupt')
    void stop().then(() => {
      write()
      process.exit(1)
    })
  })
  try {
    result.build.sha256 = await sha256File(exe).catch(() => 'unreadable')
    app = await startApp({ app: opts.app, profile: opts.profile, log })
    bridge = await connectBridge(app.tokenFile)
    if (opts.platform === 'macos') result.notes.push('macOS uses the bridge build\'s own data folder; start from a fresh one for first run (docs/release-gate.md).')
    const { scenario } = createContext({ bridge, out: opts.out, opts, tokenFile: app.tokenFile, log })
    const health = (await bridge.call('app_health')).data
    result.build.version = health?.version ?? null
    const add = (rec) => {
      result.scenarios.push(rec)
      write()
      return rec
    }
    const ready = add(await scenario('start', 'Start: first run and the gate printer', (s) => start(s)))
    if (ready.status === 'FAIL') result.notes.push('the start failed, so the scenarios that need the printer may fail too')
    const has = (k) => opts.run.includes(k)
    if (has('a')) add(await scenario('a', SCENARIOS.a, (s) => vault(s)))
    if (has('b')) add(await scenario('b1', 'Open a design signed out', (s) => openSignedOut(s)))
    if (has('c')) add(await scenario('c', SCENARIOS.c, (s) => accounts(s, opts)))
    // The signed-in half of b and the starters run on the account's session when there is one, which keeps the
    // gate's downloads out of the public counts.
    if (has('b') && opts.account && (await bridge.call('app_user')).data?.signedIn) add(await scenario('b2', 'Open a design signed in', (s) => openSignedIn(s)))
    else if (has('b')) result.notes.push('b2 (open signed in) did not run: not signed in')
    if (has('e')) add(await scenario('e', SCENARIOS.e, (s) => starters(s, { only: opts.starters })))
    if (has('d')) add(await scenario('d', SCENARIOS.d, (s) => upload(s, opts)))
  } catch (e) {
    result.notes.push(mask(`could not run: ${e instanceof Error ? e.message : String(e)}`))
    log(`could not run: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    await stop()
    write()
  }
  const status = result.scenarios.length ? runStatus(result) : 'FAIL'
  log(`\n${result.scenarios.map((s) => `${s.status.padEnd(4)} ${s.id}. ${s.title}`).join('\n')}\n\nrelease gate ${opts.platform}: ${status}. Report: ${join(opts.out, 'report.html')}`)
  return status === 'FAIL' ? 1 : result.scenarios.length ? 0 : 2
}

process.exitCode = await main()
