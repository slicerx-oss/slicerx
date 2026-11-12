// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pnpm --filter @slicerx/mcp eval:creative [--prompt id,id] [--log] [--change "what changed"] [--no-default-answer]
//   live: --mode live --model id --usd-in n --usd-out n [--cap-usd 1.50] [--record]
//         [--long-above tokens --usd-in-long n --usd-out-long n] [--usd-per-search 0.01]
//         [--provider openai|anthropic|openai-compatible] [--base-url http://127.0.0.1:11434/v1]
// The default replays the recorded replies in evals/creative/recordings, offline and with no key, and lists the
// prompts that have no recording yet. A live run asks a model and needs the model's price per million input and
// output tokens, so it can stop: no new request starts once the spend reaches the cap less the stop margin
// (CAP_USD 1.50 by default, stopping at 1.40), or when its reserve (its input tokens, estimated from its size, and its
// whole output limit; live.ts worstUsd) would take the spend past the cap.
// A reply cut off before its usage arrived is charged its reserve. --record saves each live reply as that prompt's
// recording, except a run the cap stopped.
// A full live run of every prompt takes about 30 minutes. On a shared build machine, run it under the heavy lock with a
// hold limit of 2400 seconds, so a shorter limit on the machine does not stop it partway:
//   SX_HEAVY_MAX_HOLD=2400 scripts/ci/heavy.sh pnpm --filter @slicerx/mcp eval:creative --mode live ...
// mimir runs with the desktop tab's options (run.ts CREATIVE_TAB, @slicerx/pilot tab-options.ts) and the tab's tools
// (src/toolset.ts tabToolset): the design toolset on the eval's own design host, so a part is built feature by feature
// as CAD history, with the tab's questions, sheets and plan cards. A reply that builds nothing is scored as asked (a
// question to the person), declined (says it can't model or build it), stopped (its plan was approved or its question
// answered, and it ended without building) or none. When it asks, in its reply or on a question card, the eval answers
// once with run.ts DEFAULT_ANSWER and lets it go on; --no-default-answer turns that off. A replay answers only for a
// recording captured with the answer, and marks a recorded question without one stale. A recording from before the
// tab's tools (it called text_to_part or no tool) replays as stale too, until a live run captures it again, and so does
// one whose reply starts the same part again with a second design.new, which mimir now refuses, unless it was captured
// since that refusal (a live capture stamps samePart, so a refusal the model saw replays as recorded). A replay that gets
// mimir's note that its approved plan is unfinished (plan_left) is stale and left out of the score unless its live
// capture got the note too (stamped planGoesOn). The log rows go to @slicerx/pilot's evals LOG.md and results.jsonl, beside the other mimir evals.
// A replay exits 1 when a scored recording no longer replays as captured: it diverges from what the model read, leaves
// recorded replies unused or ends early. A recording keeps the model's own miss, so a part that fails a check is
// reported and counted in the pass rate, never an exit 1. design.check reads the thinnest wall within counted work
// (body-facts.ts WALL_BUDGET), so a loaded machine reads the wall a quiet one does, live or replayed.
// --provider anthropic is the API mimir's default model runs on; its key comes from ANTHROPIC_API_KEY (or
// SLICERX_ANTHROPIC_API_KEY), and its cache writes and reads are priced the way mimir cloud bills them (live.ts).
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTransportClient, TAB_MIN_STEPS, TAB_MIN_TOOL_CALLS, type LlmClient } from '@slicerx/pilot'
import { createNodeTransport, EVALS_DIR, evalGeom } from '@slicerx/pilot/evals/node'
import { budgetedClient, createBudget, DEFAULT_CAP_USD, DEFAULT_USD_PER_SEARCH, runLive, STOP_MARGIN_USD, type Price } from './live'
import { CREATIVE_PROMPTS, type CreativePrompt } from './prompts'
import { loadRecording, saveRecording } from './recordings'
import { CREATIVE_TAB, DEFAULT_ANSWER, replayScored, runPrompt, scoreParts, type CreativeScore, type NoBuild, type PromptRun } from './run'

const PROVIDERS = ['openai', 'anthropic', 'openai-compatible']

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : fallback
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const mode = arg('mode', 'replay') === 'live' ? 'live' : 'replay'
const ids = arg('prompt')?.split(',').filter(Boolean)
const selected = ids ? CREATIVE_PROMPTS.filter((p) => ids.includes(p.id)) : CREATIVE_PROMPTS
if (!selected.length) {
  console.error(`No prompt matches "${ids?.join(',')}". Ids: ${CREATIVE_PROMPTS.map((p) => p.id).join(', ')}`)
  process.exit(2)
}

const defaultAnswer = !flag('no-default-answer')
const answerLine = defaultAnswer ? `on ("${DEFAULT_ANSWER}")` : 'off'
console.log(`mimir as the ${CREATIVE_TAB.slices ? 'desktop' : 'browser'} tab on its tools (${CREATIVE_TAB.editionName} edition, at least ${TAB_MIN_STEPS} steps and ${TAB_MIN_TOOL_CALLS} tool calls); default answer ${answerLine}`)

const geom = evalGeom()
let client: LlmClient | undefined
const model = arg('model')
const provider = arg('provider', 'openai') ?? 'openai'
const capUsd = Number(arg('cap-usd', String(DEFAULT_CAP_USD)))
const budget = createBudget(capUsd)
if (mode === 'live') {
  const local = provider === 'openai-compatible'
  const usdIn = Number(arg('usd-in', local ? '0' : ''))
  const usdOut = Number(arg('usd-out', local ? '0' : ''))
  const longAbove = arg('long-above')
  const usdPerSearch = Number(arg('usd-per-search', local ? '0' : String(DEFAULT_USD_PER_SEARCH)))
  const price: Price = { usdIn, usdOut, usdPerSearch }
  if (!Number.isFinite(usdPerSearch) || usdPerSearch < 0) {
    console.error('--usd-per-search is dollars per hosted web search, 0 or more.')
    process.exit(2)
  }
  if (!PROVIDERS.includes(provider)) {
    console.error(`Unknown --provider "${provider}". Use ${PROVIDERS.join(', ')}.`)
    process.exit(2)
  }
  if (longAbove !== undefined) {
    const long = { above: Number(longAbove), usdIn: Number(arg('usd-in-long', '')), usdOut: Number(arg('usd-out-long', '')) }
    if (![long.above, long.usdIn, long.usdOut].every((n) => Number.isFinite(n) && n > 0)) {
      console.error('--long-above needs a token count, and --usd-in-long and --usd-out-long the rates above it.')
      process.exit(2)
    }
    price.long = long
  }
  if (!model) {
    console.error('Live mode needs --model.')
    process.exit(2)
  }
  if (!Number.isFinite(usdIn) || !Number.isFinite(usdOut) || usdIn < 0 || usdOut < 0 || (!local && usdIn + usdOut === 0)) {
    console.error('Live mode needs the model price: --usd-in and --usd-out, dollars per million input and output tokens.')
    process.exit(2)
  }
  if (!Number.isFinite(capUsd) || capUsd <= STOP_MARGIN_USD) {
    console.error(`--cap-usd must be more than the ${STOP_MARGIN_USD} stop margin.`)
    process.exit(2)
  }
  if (!geom) {
    console.error('Live mode scores the parts, so it needs the geometry engine: build packages/geom/wasm (scripts/build.sh) or sx-geom first.')
    process.exit(2)
  }
  const transport = createNodeTransport()
  if (!local && !(await transport.available(provider))) {
    console.error(`No key for ${provider}${provider === 'anthropic' ? ': set ANTHROPIC_API_KEY' : ''}.`)
    process.exit(2)
  }
  const baseUrl = arg('base-url')
  const base = createTransportClient(transport, provider, baseUrl === undefined ? {} : { baseUrl })
  client = budgetedClient(base, model, price, budget)
}

const fmt = (name: string, c: { pass: boolean; detail: string } | undefined): string => (c ? `${name} ${c.pass ? 'ok' : 'FAIL'} (${c.detail})` : '')
const scores: { id: string; score: CreativeScore; calls: number; noBuild?: NoBuild; answered: boolean }[] = []
const waiting: string[] = []
const skipped: string[] = []
const stale: string[] = []
const broken: string[] = []
const report = (p: CreativePrompt, run: PromptRun): void => {
  // a run the budget stopped ends partway, which is not what the model would do: it is never saved
  if (mode === 'live' && flag('record') && run.steps.length && !run.error && !budget.stopped) {
    saveRecording(p.id, { status: 'recorded', model: model ?? '', provider, capturedAt: new Date().toISOString(), steps: run.steps, ...(defaultAnswer ? { defaultAnswer: true } : {}), tabTools: true, samePart: true, ...(run.planGoesOn ? { planGoesOn: true } : {}) })
  }
  // a replay that got the plan_left note its recording never answered stands for no reply of the model's: stale, not scored
  if (mode === 'replay' && !replayScored(run)) {
    stale.push(p.id)
    console.log(`STALE    ${p.id.padEnd(28)} not scored: ${run.stale}`)
    return
  }
  const sc = scoreParts(p, run.parsed, run.parts, run.gaps)
  scores.push({ id: p.id, score: sc, calls: run.calls.length, answered: run.answered, ...(run.noBuild ? { noBuild: run.noBuild } : {}) })
  const checks = run.noBuild ? `no build: ${run.noBuild}${run.answered ? ' after the default answer' : ''}` : [fmt('parses', sc.parses), fmt('watertight', sc.watertight), fmt('bodies', sc.bodies), fmt('wall', sc.minWall), fmt('bed', sc.bedFit), fmt('clearance', sc.clearance)].filter(Boolean).join('  ')
  console.log(`${(sc.pass ? 'PASS' : run.noBuild ? run.noBuild.toUpperCase() : 'FAIL').padEnd(8)} ${p.id.padEnd(28)} ${checks}${run.answered && !run.noBuild ? '  (built after the default answer)' : ''}`)
  if (run.stale) {
    stale.push(p.id)
    console.log(`     STALE recording: ${run.stale}`)
  }
  if (run.error) {
    broken.push(p.id)
    console.log(`     error: ${run.error}`)
  }
}
if (client) {
  for await (const { prompt, run } of runLive(selected, { geom, client, budget, defaultAnswer })) report(prompt, run)
} else {
  for (const p of selected) {
    const rec = loadRecording(p.id)
    if (rec.status === 'to-capture') {
      waiting.push(p.id)
      console.log(`NO RECORDING ${p.id.padEnd(20)} waiting for a live capture run`)
      continue
    }
    if (!geom) {
      skipped.push(p.id)
      console.log(`SKIP ${p.id.padEnd(28)} recorded (${rec.model}), but there is no geometry engine to build it`)
      continue
    }
    report(p, await runPrompt(p, { geom, steps: rec.steps, defaultAnswer, answerRecorded: rec.defaultAnswer === true, tabTools: rec.tabTools === true, samePart: rec.samePart === true, planGoesOn: rec.planGoesOn === true }))
  }
}

const passed = scores.filter((s) => s.score.pass).length
const noBuild = (r: NoBuild): string[] => scores.filter((s) => s.noBuild === r).map((s) => s.id)
const nothing = scores.filter((s) => s.noBuild).length
const answeredIds = scores.filter((s) => s.answered).map((s) => s.id)
const noBuildLine = nothing ? `${nothing} built nothing (${noBuild('asked').length} asked, ${noBuild('declined').length} declined, ${noBuild('stopped').length} stopped, ${noBuild('none').length} none)` : ''
console.log(
  `\n${mode}: ${scores.length} scored, ${passed} passed${skipped.length ? `, ${skipped.length} skipped with no geometry engine` : ''}${mode === 'live' ? `, spent $${budget.spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}${budget.cutOff ? ` ($${budget.estimatedUsd.toFixed(2)} of it the most ${budget.cutOff} cut-off repl${budget.cutOff === 1 ? 'y' : 'ies'} could cost)` : ''}` : ''}${budget.stopped ? ' (stopped at the cost cap)' : ''}`,
)
if (noBuildLine) console.log(noBuildLine)
console.log(`default answer ${defaultAnswer ? `on, given in ${answeredIds.length} run${answeredIds.length === 1 ? '' : 's'}${answeredIds.length ? `: ${answeredIds.join(', ')}` : ''}` : 'off'}`)
if (stale.length) console.log(`${stale.length} stale recording${stale.length === 1 ? '' : 's'}, to capture again live: ${stale.join(', ')}`)
if (mode === 'replay' && broken.length) console.log(`${broken.length} recording${broken.length === 1 ? '' : 's'} no longer replay${broken.length === 1 ? 's' : ''} as captured: ${broken.join(', ')}`)
if (waiting.length) console.log(`${waiting.length} prompt${waiting.length === 1 ? ' has' : 's have'} no recording yet: ${waiting.join(', ')}`)

if (flag('log') && scores.length) {
  const ts = new Date().toISOString()
  const modelName = mode === 'live' ? (model ?? '') : 'recorded'
  const line = {
    ts,
    loop: 'creative-eval',
    mode,
    model: modelName,
    scenarios: ids?.join(',') ?? 'creative',
    runs: 1,
    change: arg('change', ''),
    metric: 'pass_rate',
    value: Math.round((passed / scores.length) * 1000) / 10,
    pass_rate: Math.round((passed / scores.length) * 1000) / 1000,
    tool_calls_per_task: Math.round((scores.reduce((a, s) => a + s.calls, 0) / scores.length) * 10) / 10,
    unapproved_side_effects: 0,
    ...(mode === 'live' ? { usd: Math.round(budget.spentUsd * 100) / 100 } : {}),
    per_scenario: Object.fromEntries(scores.map((s) => [s.id, [s.score.pass ? 100 : 0]])),
    default_answer: defaultAnswer,
    answered: answeredIds,
    no_build: Object.fromEntries(scores.flatMap((s) => (s.noBuild ? [[s.id, s.noBuild]] : []))),
    ...(stale.length ? { stale } : {}),
  }
  appendFileSync(join(EVALS_DIR, 'results.jsonl'), `${JSON.stringify(line)}\n`)
  const logMd = join(EVALS_DIR, 'LOG.md')
  // The same table the scenario runs log to (evals/LOG.md); Mean holds the pass rate here, as a percent.
  if (existsSync(logMd) && readFileSync(logMd, 'utf8').trim()) {
    const notes = [line.change || 'creative prompts', `default answer ${defaultAnswer ? `on (${answeredIds.length} answered)` : 'off'}`, noBuildLine ? `${noBuildLine}: ${(['asked', 'declined', 'stopped', 'none'] as const).flatMap((r) => noBuild(r).map((id) => `${id} ${r}`)).join(', ')}` : '', stale.length ? `stale: ${stale.join(', ')}` : '']
    appendFileSync(logMd, `| ${ts.slice(0, 16).replace('T', ' ')} | ${mode} | ${modelName} | ${line.scenarios} | 1 | ${line.value} | ${Math.round(line.pass_rate * 100)}% | ${line.tool_calls_per_task} | 0 | ${notes.filter(Boolean).join('; ')} |\n`)
  }
}

process.exit(mode === 'replay' && broken.length ? 1 : 0)
