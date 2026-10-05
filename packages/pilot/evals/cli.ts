// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pnpm --filter @slicerx/pilot eval --mode replay|live [--scenario id|group|gate|all]
//   [--runs n] [--model id] [--max-requests n] [--log] [--change "what changed"]
//   [--provider openai|openai-compatible] [--base-url http://127.0.0.1:11434/v1]
// Live mode reads the key from OPENAI_API_KEY or the macOS Keychain at request
// time and stops starting new runs once --max-requests provider calls were made.
// With --provider openai-compatible it talks to a local server (Ollama, LM Studio)
// with no key and no reasoning setting, and reports first token time, output
// tokens per second and malformed tool calls per run.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG } from '../src/config'
import { createNodeTransport } from '../src/node/index'
import { createTransportClient } from '../src/provider/client'
import { runScenario } from './runner'
import { loadKbSuite } from './kb-suite'
import { GATE, SCENARIOS } from './scenarios'
import type { RunRecord } from './types'

const here = dirname(fileURLToPath(import.meta.url))

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : fallback
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const mode = (arg('mode', 'replay') === 'live' ? 'live' : 'replay') as 'replay' | 'live'
const which = arg('scenario', mode === 'live' ? 'gate' : 'all') ?? 'all'
const runs = Math.max(1, Number(arg('runs', '1')))
const model = arg('model', DEFAULT_CONFIG.model) ?? DEFAULT_CONFIG.model
const maxRequests = Number(arg('max-requests', '60'))
const reasoning = arg('reasoning', DEFAULT_CONFIG.reasoning ?? 'medium') as 'low' | 'medium' | 'high'
const provider = arg('provider', 'openai') ?? 'openai'
const baseUrl = arg('base-url')
const local = provider === 'openai-compatible'
if (provider !== 'openai' && !local) {
  console.error(`Unknown --provider "${provider}". Use openai or openai-compatible.`)
  process.exit(2)
}

const wantsSuite = which.split(',').some((w) => w === 'kb-suite' || w.startsWith('ev'))
const suite = wantsSuite ? loadKbSuite() : []
const selected = [
  ...SCENARIOS.filter((s) => (which === 'all' ? true : which === 'gate' ? GATE.includes(s.id) : which.split(',').some((w) => s.id === w || s.group === w))),
  ...suite.filter((s) => which.split(',').some((w) => w === 'kb-suite' || w === s.id || (w.endsWith('*') && s.id.startsWith(w.slice(0, -1))))),
]
if (wantsSuite && mode === 'replay') {
  console.error('The knowledge/evals suite has no replay scripts; run it with --mode live.')
  process.exit(2)
}
if (selected.length === 0) {
  console.error(`No scenario matches "${which}". Ids: ${SCENARIOS.map((s) => s.id).join(', ')}`)
  process.exit(2)
}

let requests = 0
const transport = createNodeTransport({ onRequest: () => void requests++ })
if (mode === 'live' && !local && !(await transport.available('openai'))) {
  console.error('Live mode needs OPENAI_API_KEY or the Keychain item slicerx-openai-api-key.')
  process.exit(2)
}

/** Per run speed and tool call validity, measured around the provider stream. */
interface RunPerf {
  requests: number
  firstTokenMs: number[]
  outputTokens: number
  streamMs: number
  /** Time after the first text token and the tokens in it, so the rate excludes prompt
   * processing and model load. Only requests that streamed text for 250 ms or more count,
   * since a tool call arrives as one event at the end of its stream. */
  decodeMs: number
  decodeTokens: number
  malformed: number
}
const perfs: RunPerf[] = []
const MALFORMED = /^(Unknown tool|Arguments were not valid JSON|Invalid arguments)/

const records: RunRecord[] = []
let stoppedForBudget = false
for (const s of selected) {
  for (let r = 1; r <= runs; r++) {
    if (mode === 'live' && !s.switchTo && requests >= maxRequests) {
      stoppedForBudget = true
      break
    }
    const perf: RunPerf = { requests: 0, firstTokenMs: [], outputTokens: 0, streamMs: 0, decodeMs: 0, decodeTokens: 0, malformed: 0 }
    const liveClient = () => {
      const base = createTransportClient(transport, provider, baseUrl === undefined ? {} : { baseUrl })
      return {
        provider,
        async *stream(req: Parameters<typeof base.stream>[0], signal?: AbortSignal) {
          const t0 = performance.now()
          let first = false
          let tText = 0
          let out = 0
          perf.requests++
          try {
            for await (const ev of base.stream(local ? { ...req, model } : { ...req, model, reasoning }, signal)) {
              if (!first && (ev.type === 'text' || ev.type === 'tool_call')) {
                first = true
                perf.firstTokenMs.push(performance.now() - t0)
              }
              if (!tText && ev.type === 'text') tText = performance.now()
              if (ev.type === 'usage') out += ev.outputTokens
              yield ev
            }
          } finally {
            const end = performance.now()
            perf.streamMs += end - t0
            perf.outputTokens += out
            if (tText && end - tText >= 250) {
              perf.decodeMs += end - tText
              perf.decodeTokens += out
            }
          }
        },
      }
    }
    const dump = arg('dump')
    const events: unknown[] = []
    const onEvent = (e: { type: string; ok?: boolean; summary?: string }) => {
      events.push(e)
      if (e.type === 'tool_result' && e.ok === false && MALFORMED.test(e.summary ?? '')) perf.malformed++
    }
    const rec = await runScenario(s, { mode, model: mode === 'live' ? model : 'scripted', run: r, liveClient, onEvent })
    perfs.push(perf)
    if (dump) {
      mkdirSync(dump, { recursive: true })
      writeFileSync(join(dump, `${s.id}-${mode}-${r}.json`), JSON.stringify(events, null, 1))
    }
    records.push(rec)
    const sc = rec.score
    console.log(
      `${sc.pass ? 'PASS' : 'FAIL'} ${s.id.padEnd(24)} ${String(sc.total).padStart(5)}  tools ${sc.tools} args ${sc.args} settings ${sc.settings} cites ${sc.citations} eff ${sc.efficiency}  calls ${rec.toolCalls} ${Math.round(rec.ms)} ms${sc.unapprovedSideEffects ? `  UNAPPROVED ${sc.unapprovedSideEffects}` : ''}`,
    )
    if (mode === 'live' && perf.requests) {
      const ttft = perf.firstTokenMs.length ? perf.firstTokenMs.reduce((a, b) => a + b, 0) / perf.firstTokenMs.length : 0
      const tps = perf.streamMs ? perf.outputTokens / (perf.streamMs / 1000) : 0
      const dps = perf.decodeMs ? perf.decodeTokens / (perf.decodeMs / 1000) : 0
      console.log(`     perf: requests ${perf.requests}  first token ${Math.round(ttft)} ms  out tokens ${perf.outputTokens}  ${tps.toFixed(1)} tok/s end to end, ${dps.toFixed(1)} decode  malformed calls ${perf.malformed}`)
    }
    if (sc.notes.length) console.log(`     ${sc.notes.join('; ')}`)
    if (flag('verbose')) console.log(`     calls: ${rec.calls.join(', ')}\n     reply: ${rec.reply.replaceAll('\n', ' ').slice(0, 300)}`)
    const facts = 'facts' in s && Array.isArray(s.facts) ? (s.facts as string[]) : []
    if (flag('verbose') && facts.length) console.log(`     facts to check by hand: ${facts.join(' / ')}`)
  }
  if (stoppedForBudget) break
}

const passed = records.filter((r) => r.score.pass).length
const mean = records.length ? records.reduce((a, r) => a + r.score.total, 0) / records.length : 0
const unapproved = records.reduce((a, r) => a + r.score.unapprovedSideEffects, 0)
const allFirst = perfs.flatMap((p) => p.firstTokenMs)
const sum = (f: (p: RunPerf) => number) => perfs.reduce((a, p) => a + f(p), 0)
const perfSummary = {
  provider,
  first_token_ms: allFirst.length ? Math.round(allFirst.reduce((a, b) => a + b, 0) / allFirst.length) : 0,
  tokens_per_s: sum((p) => p.streamMs) ? Math.round((sum((p) => p.outputTokens) / (sum((p) => p.streamMs) / 1000)) * 10) / 10 : 0,
  decode_tokens_per_s: sum((p) => p.decodeMs) ? Math.round((sum((p) => p.decodeTokens) / (sum((p) => p.decodeMs) / 1000)) * 10) / 10 : 0,
  output_tokens: sum((p) => p.outputTokens),
  malformed_calls: sum((p) => p.malformed),
  total_ms: Math.round(records.reduce((a, r) => a + r.ms, 0)),
}
const gateRecs = records.filter((r) => GATE.includes(r.scenario))
const gatePass = new Set(GATE.filter((id) => gateRecs.some((r) => r.scenario === id) && gateRecs.filter((r) => r.scenario === id).every((r) => r.score.pass)))
console.log(`\n${mode}: ${passed}/${records.length} runs passed, mean score ${mean.toFixed(1)}, gate ${gatePass.size}/${new Set(gateRecs.map((r) => r.scenario)).size}, unapproved side effects ${unapproved}${mode === 'live' ? `, provider requests ${requests}` : ''}${stoppedForBudget ? ' (stopped at the request budget)' : ''}`)
if (mode === 'live') console.log(`perf: first token ${perfSummary.first_token_ms} ms mean, ${perfSummary.tokens_per_s} tok/s end to end, ${perfSummary.decode_tokens_per_s} decode, ${perfSummary.output_tokens} output tokens, malformed calls ${perfSummary.malformed_calls}, total ${(perfSummary.total_ms / 1000).toFixed(1)} s`)

if (flag('log')) {
  const results = join(here, 'results.jsonl')
  const logMd = join(here, 'LOG.md')
  const ts = new Date().toISOString()
  const line = {
    ts,
    loop: 'pilot-eval',
    mode,
    model: mode === 'live' ? model : 'scripted',
    scenarios: which,
    runs,
    change: arg('change', ''),
    metric: 'mean_score',
    value: Math.round(mean * 10) / 10,
    pass_rate: records.length ? Math.round((passed / records.length) * 1000) / 1000 : 0,
    tool_calls_per_task: records.length ? Math.round((records.reduce((a, r) => a + r.toolCalls, 0) / records.length) * 10) / 10 : 0,
    unapproved_side_effects: unapproved,
    requests,
    ...(mode === 'live' ? perfSummary : {}),
    per_scenario: Object.fromEntries([...new Set(records.map((r) => r.scenario))].map((id) => [id, records.filter((r) => r.scenario === id).map((r) => r.score.total)])),
  }
  appendFileSync(results, `${JSON.stringify(line)}\n`)
  if (!existsSync(logMd) || !readFileSync(logMd, 'utf8').trim()) {
    writeFileSync(logMd, '# mimir eval log\n\nOne row per eval run. `results.jsonl` has the per scenario scores.\n\n| Time (UTC) | Mode | Model | Scenarios | Runs | Mean | Pass rate | Calls per task | Unapproved | Change |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n')
  }
  appendFileSync(logMd, `| ${ts.slice(0, 16).replace('T', ' ')} | ${mode} | ${line.model} | ${which} | ${runs} | ${line.value} | ${Math.round(line.pass_rate * 100)}% | ${line.tool_calls_per_task} | ${unapproved} | ${line.change || 'baseline'} |\n`)
}

process.exit(unapproved > 0 || (mode === 'replay' && passed < records.length) ? 1 : 0)
