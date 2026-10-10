#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The integrator kit eval. A coding agent starts in an empty app folder with only the kit (the packed
// packages and docs/integrators) and a scripted developer who answers its questions. The score says
// whether it connected the MCP server, interviewed before building, integrated the parts asked for,
// themed them with the brand, showed the agreement, kept to the rules, and left an app that builds.
//   node scripts/devkit-eval/run.mjs [--agent claude] [--persona tracker] [--model sonnet] [--budget 4] [--out dir] [--dry-run]
// --dry-run starts no agent and bills nothing: it sets up the app folder, renders the persona's turns and
// checks the wiring (assets, the host app's launch hookup, the scoring helpers against canned replies).
// A Path A persona (whitelabel) also gets a clone of this repository next to the app, with SlicerX as its
// `upstream` remote, and is scored on the edition it makes there (--clone uses an existing clone instead).
// Results go to <tmp>/slicerx-devkit-eval/<run>/ (or --out): score.json, transcript.jsonl and the app.
// The agent cannot push, publish or deploy: its tools are limited to files, npm, node and the MCP CLI.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { AGENTS } from './agents.mjs'
import { PERSONAS } from './personas.mjs'
import { askedAOrB, hostHooked, prepareTools, recommendedA, runsSx, score } from './score.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const { values } = parseArgs({
  options: {
    agent: { type: 'string', default: 'claude' },
    persona: { type: 'string', default: 'tracker' },
    model: { type: 'string', default: 'sonnet' },
    budget: { type: 'string', default: '4' },
    out: { type: 'string' },
    kit: { type: 'string' },
    'sx-bin': { type: 'string' },
    clone: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
})
const agent = AGENTS[values.agent]
const persona = PERSONAS[values.persona]
if (!agent || !persona) throw new Error(`agents: ${Object.keys(AGENTS).join(', ')}; personas: ${Object.keys(PERSONAS).join(', ')}`)
const edition = persona.path === 'A'
const sxBin = resolve(values['sx-bin'] ?? process.env['SLICERX_SX_BIN'] ?? join(repo, 'target', 'release', 'sx'))
if (!edition && !values['dry-run'] && !existsSync(sxBin)) throw new Error(`no sx engine at ${sxBin}; build it with cargo build -p sx-cli --release or pass --sx-bin`)

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
// Outside the repository, so the agent sees only the kit and no git checkout.
const out = resolve(values.out ?? join(tmpdir(), 'slicerx-devkit-eval', `${stamp}-${values.agent}-${values.persona}`))
const app = join(out, 'app')
mkdirSync(app, { recursive: true })

// The kit: the three packed packages and the integrator docs, nothing else from the repository.
const kit = join(app, 'slicerx-kit')
mkdirSync(kit, { recursive: true })
if (values['dry-run']) {} // no pack in a dry run
else if (values.kit) cpSync(values.kit, kit, { recursive: true })
else execFileSync(process.execPath, [join(repo, 'scripts', 'pack-integrator-kit.mjs'), kit], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'] })
for (const f of readdirSync(join(repo, 'docs', 'integrators'))) cpSync(join(repo, 'docs', 'integrators', f), join(kit, f), { recursive: true })

// Path A: the developer's brand files in the app folder, and a clone of SlicerX beside it.
const missing = []
for (const [to, from] of Object.entries(persona.assets ?? {})) {
  // a dry run goes on without a source that needs `pnpm install` and says so
  if (values['dry-run'] && !existsSync(join(repo, from))) {
    missing.push(from)
    continue
  }
  mkdirSync(dirname(join(app, to)), { recursive: true })
  cpSync(join(repo, from), join(app, to), { recursive: true })
}
if (values['dry-run']) {
  dryRun()
  process.exit(process.exitCode ?? 0)
}
let clone = null
if (edition) {
  clone = resolve(values.clone ?? join(out, 'slicerx'))
  if (!values.clone) {
    execFileSync('git', ['clone', '-q', '--local', repo, clone], { stdio: 'inherit' })
    execFileSync('git', ['-C', clone, 'remote', 'rename', 'origin', 'upstream'], { stdio: 'inherit' })
  }
}

/** Validates the wiring of a run without an agent: files exist, turns render, the host launch works, the checks tell good replies from bad. */
function dryRun() {
  const problems = []
  const need = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
    if (!ok) problems.push(what)
  }
  for (const m of missing) console.log(`warn asset source missing, run pnpm install: ${m}`)
  need(Object.entries(persona.assets ?? {}).every(([to, from]) => existsSync(join(app, to)) || missing.includes(from)), `assets copied (${Object.keys(persona.assets ?? {}).join(', ') || 'none'})`)
  const turnTexts = persona.turns({ sxBin, kit: 'slicerx-kit', clone: join(out, 'slicerx') })
  need(turnTexts.every((m) => typeof m === 'string' && m.length > 0 && !m.includes('undefined')), `${turnTexts.length} turns render`)
  if (persona.host) {
    const host = join(app, persona.host)
    need(existsSync(join(host, 'main.mjs')) && existsSync(join(host, 'models')), 'host app folder is in the app')
    need(!hostHooked(host, persona.expect), 'host app starts without a launch hookup')
    // a fake slicer that records its argument: the stand-in's launch must hand it the model path
    const fake = join(out, 'fake-slicer.sh')
    const seen = join(out, 'fake-slicer.args')
    writeFileSync(fake, `#!/bin/sh\necho "$@" > "${seen}"\n`)
    chmodSync(fake, 0o755)
    const model = join(host, 'models', 'calibration-cube.stl')
    const r = spawnSync(process.execPath, [join(host, 'open-in-edition.mjs'), '--exe', fake, model], { encoding: 'utf8' })
    for (let i = 0; i < 20 && !existsSync(seen); i++) spawnSync('sleep', ['0.1'])
    need(r.status === 0 && existsSync(seen) && readFileSync(seen, 'utf8').trim() === model, 'host launches a program with the model path as its argument')
    writeFileSync(join(host, 'layermate.config.json'), JSON.stringify({ editionCommand: ['/Applications/LayerSlice.app/Contents/MacOS/layerslice'] }))
    need(hostHooked(host, persona.expect), 'a configured editionCommand counts as hooked')
    const both = 'Two ways to do this. Path A is your own edition, a separate app that LayerMate launches. Path B embeds the viewport inside your window. Which one?'
    need(askedAOrB(both) && !askedAOrB('What is your brand color?'), 'Path A or B question is recognized')
    need(recommendedA('I recommend Path A, your own edition, because LayerMate is a desktop app.') && !recommendedA('I recommend Path B: embed the viewport.'), 'recommending A is told from recommending B')
  }
  if (persona.path === 'B-engine') {
    need(existsSync(sxBin), `sx engine at ${sxBin}`)
    const good = "const sx = spawn(sxPath, ['slice', '--request', '-', '--out-dir', dir])"
    need(runsSx(good) && !runsSx("spawn(sxPath, ['slice', 'model.stl'])"), 'a request slice through sx is recognized')
    need(prepareTools('<Viewport plate={plate} tools onTransform={keep} />') && prepareTools('<sx-viewport tools></sx-viewport>') && !prepareTools('<Viewport plate={plate} />'), 'the Prepare tools are recognized')
  }
  console.log(problems.length ? `\n${problems.length} problem(s)` : '\ndry run ok')
  console.log(out)
  if (problems.length) process.exitCode = 1
}

const transcript = join(out, 'transcript.jsonl')
const turns = []
let session = null
for (const [i, message] of persona.turns({ sxBin, kit: 'slicerx-kit', clone }).entries()) {
  const t0 = Date.now()
  // The sx engine's folder is readable, as it would be on the developer's machine; for Path A the clone is the workspace.
  const readDirs = edition ? [clone] : [dirname(sxBin)]
  const r = agent.turn({ cwd: app, message, session, model: values.model, budget: Number(values.budget), transcript, readDirs, edition })
  session = r.session ?? session
  turns.push({ turn: i + 1, ms: Date.now() - t0, cost_usd: r.cost, said: r.text ?? '', files: [...listApp(app), ...editionFiles(clone)] })
  console.log(`turn ${i + 1}: ${Math.round((Date.now() - t0) / 1000)} s, ${r.cost ?? '?'} USD`)
  if (r.error) {
    console.log(`agent error: ${r.error}`)
    break
  }
}

/** The editions the agent made in the clone (SlicerX's own left out), as slicerx/editions/<id>/... */
function editionFiles(dir) {
  if (!dir || !existsSync(join(dir, 'editions'))) return []
  return readdirSync(join(dir, 'editions'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'slicerx')
    .flatMap((e) => listApp(join(dir, 'editions', e.name)).map((f) => `slicerx/editions/${e.name}/${f}`))
}

function listApp(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'slicerx-kit', '.git', 'dist'].includes(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) listApp(p, base, acc)
    else acc.push(p.slice(base.length + 1))
  }
  return acc
}

const result = score({ app, clone, turns, transcript, persona, spawnSync })
writeFileSync(join(out, 'score.json'), `${JSON.stringify({ agent: values.agent, persona: values.persona, model: values.model, ...(clone ? { clone } : {}), ...result, turns }, null, 2)}\n`)
console.log(`\n${result.points} of ${result.max}`)
for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'MISS'} ${c.name}${c.note ? `: ${c.note}` : ''}`)
console.log(`\n${out}`)
