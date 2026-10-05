// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Set up local AI, shared by the app and the MCP server: recommend one model from the table in
// llm/local-models.json for the hardware, find a running Ollama or LM Studio, pull a model through
// Ollama's own API, give it the context mimir needs, then check one tool call, the loaded context
// and the speed. Every request goes to 127.0.0.1 on
// Ollama's or LM Studio's port; the only other address is Ollama's download page, which a person
// opens in the browser.
import table from '../llm/local-models.json' with { type: 'json' }
import { MIMIR_CONTEXT } from './context'
import { ASSISTANT_NAME } from './name'
import type { createOpenAiCompatibleAdapter } from './provider/openai-compatible'

export const OLLAMA = 'http://127.0.0.1:11434'
export const LM_STUDIO = 'http://127.0.0.1:1234'
export const OLLAMA_DOWNLOAD = 'https://ollama.com/download'
/** The context mimir needs from a local model; see context.ts. */
export { MIMIR_CONTEXT }

/** What the helper may reach: the two local servers. */
export function localAiUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && (u.port === '11434' || u.port === '1234') && !u.username && !u.password
  } catch {
    return false
  }
}

export interface Hardware {
  /** The graphics chip a model would run on. `vramMb` is what a model may use: its own memory, or for shared memory the part the system lets the GPU take. */
  gpu: { name: string; vramMb: number | null; unified: boolean } | null
  ramMb: number | null
  cores: number | null
  /** `desktop`: read natively (the desktop shell, the MCP server). `browser`: only what navigator shows. */
  source: 'desktop' | 'browser'
}

export type ToolLevel = 'basic' | 'good' | 'strong'

export interface LocalModel {
  id: string
  name: string
  ollama: string
  lmStudio: string
  downloadGb: number
  minVramGb: number
  minRamGb: number
  /** Small enough to answer at a usable speed on the processor alone. */
  cpuOk: boolean
  license: string
  tools: ToolLevel
  /** Decode speed measured on an RTX 5080 in the local model benchmark, or null when not measured. */
  tokensPerSecond: number | null
  /** Public figures, not yet measured on our benchmark. */
  provisional: boolean
}

export interface License {
  name: string
  plain: string
}

export const LOCAL_MODELS: readonly LocalModel[] = table.models as LocalModel[]

/** The table limited to an edition's allowed ids (edition config ai.allowedLocalModels), in table order. */
export function allowedModels(allowed?: readonly string[] | null): readonly LocalModel[] {
  return allowed ? LOCAL_MODELS.filter((m) => allowed.includes(m.id)) : LOCAL_MODELS
}
const LICENSES: Record<string, License> = table.licenses

export function licenseOf(m: LocalModel): License {
  return (
    LICENSES[m.license] ?? {
      name: m.license,
      plain: 'Read the license on the model page before you use it.',
    }
  )
}

export type Recommendation = { kind: 'model'; model: LocalModel; reason: string; onGpu: boolean } | { kind: 'too-weak'; reason: string } | { kind: 'unknown'; reason: string }

const gb = (mb: number): number => Math.round(mb / 1024)

/**
 * Apple Silicon: the GPU may wire about two thirds of memory up to 36 GB and three quarters above,
 * as Metal's recommended working set reports, unless iogpu.wired_limit_mb was raised. The desktop
 * shell has the same rule (apps/desktop/src-tauri/src/localai.rs).
 */
export function appleGpuBudgetMb(ramMb: number, wiredLimitMb = 0): number {
  if (wiredLimitMb > 0) return Math.min(wiredLimitMb, ramMb)
  return Math.floor(ramMb <= 36 * 1024 ? (ramMb * 2) / 3 : (ramMb * 3) / 4)
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: the card with the most memory. */
export function parseNvidiaSmi(out: string): Hardware['gpu'] {
  let best: Hardware['gpu'] = null
  for (const line of out.split('\n')) {
    const i = line.lastIndexOf(',')
    const mb = Number(line.slice(i + 1).trim())
    if (i < 0 || !Number.isFinite(mb) || !line.slice(i + 1).trim()) continue
    if (!best || mb > (best.vramMb ?? 0)) best = { name: line.slice(0, i).trim(), vramMb: mb, unified: false }
  }
  return best
}

/** "NVIDIA GeForce RTX 4070" reads as "RTX 4070". */
export function shortGpuName(name: string): string {
  return (
    name
      .replace(/^NVIDIA\s+/i, '')
      .replace(/^GeForce\s+/i, '')
      .replace(/^AMD\s+/i, '')
      .trim() || name
  )
}

function fitsGpu(m: LocalModel, hw: Hardware): boolean {
  return hw.gpu?.vramMb != null && m.minVramGb <= gb(hw.gpu.vramMb)
}

function fitsCpu(m: LocalModel, hw: Hardware): boolean {
  return m.cpuOk && hw.ramMb != null && m.minRamGb <= gb(hw.ramMb)
}

function fits(m: LocalModel, hw: Hardware): boolean {
  return fitsGpu(m, hw) || fitsCpu(m, hw)
}

/** One model for this computer, with the reason in plain words. The table runs weakest first, so the last that fits wins. */
export function recommend(hw: Hardware, models: readonly LocalModel[] = LOCAL_MODELS): Recommendation {
  if (hw.source === 'browser')
    return {
      kind: 'unknown',
      reason: 'The browser cannot read the graphics memory. The desktop app picks a model for this computer.',
    }
  const gpu = models.filter((m) => fitsGpu(m, hw)).at(-1)
  if (gpu && hw.gpu?.vramMb != null) {
    const name = shortGpuName(hw.gpu.name)
    const mem = gb(hw.gpu.vramMb)
    const reason = hw.gpu.unified ? `Your ${name} can give about ${mem} GB of its shared memory to a model, so ${gpu.name} fits well.` : `Your ${name} has ${mem} GB, so ${gpu.name} fits well.`
    return { kind: 'model', model: gpu, reason, onGpu: true }
  }
  const cpu = models.filter((m) => fitsCpu(m, hw)).at(-1)
  if (cpu && hw.ramMb != null) {
    const why = hw.gpu?.vramMb ? `Your ${shortGpuName(hw.gpu.name)} has only ${gb(hw.gpu.vramMb)} GB` : 'No graphics card with its own memory was found'
    return {
      kind: 'model',
      model: cpu,
      reason: `${why}, so ${cpu.name} runs on the processor with ${gb(hw.ramMb)} GB of memory. Answers are slower.`,
      onGpu: false,
    }
  }
  if (hw.ramMb == null)
    return {
      kind: 'unknown',
      reason: 'The memory of this computer could not be read.',
    }
  return {
    kind: 'too-weak',
    reason: `This computer has ${gb(hw.ramMb)} GB of memory and no graphics card a useful model fits on. Use a cloud model or sign in with ChatGPT instead.`,
  }
}

/** The next stronger model this computer can still run, or null when only a cloud model is left. */
export function nextModelUp(current: LocalModel, hw: Hardware, models: readonly LocalModel[] = LOCAL_MODELS): LocalModel | null {
  const i = models.findIndex((m) => m.id === current.id)
  return models.slice(i + 1).find((m) => fits(m, hw)) ?? null
}

/** Requests to a local server. The desktop sends them from the shell; the browser with fetch. */
export interface LocalNet {
  /** The body of a GET, or null when nothing answers. */
  get(url: string): Promise<string | null>
  /** POSTs JSON and streams the response body. */
  post(url: string, body: string, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

function refuse(url: string): never {
  throw new Error(`Only Ollama and LM Studio on this computer can be reached, not ${new URL(url).host}.`)
}

export function fetchNet(fetcher: typeof fetch = (...a) => fetch(...a)): LocalNet {
  return {
    async get(url) {
      if (!localAiUrlAllowed(url)) refuse(url)
      try {
        const res = await fetcher(url, { signal: AbortSignal.timeout(3000) })
        return res.ok ? await res.text() : null
      } catch {
        return null
      }
    },
    async *post(url, body, signal) {
      if (!localAiUrlAllowed(url)) refuse(url)
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        ...(signal ? { signal } : {}),
      })
      if (!res.ok) throw new Error(`The local server answered ${res.status}.`)
      if (!res.body) return
      const reader = res.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        if (value) yield value
      }
    },
  }
}

export interface Runner {
  kind: 'ollama' | 'lmstudio'
  label: string
  /** The chat completions base mimir connects to. */
  base: string
  /** Models the runner has: Ollama tags, or LM Studio model ids. */
  models: string[]
}

function parse(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const v = JSON.parse(text) as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const names = (list: unknown, key: string): string[] => (Array.isArray(list) ? list.map((x) => (x as Record<string, unknown>)?.[key]).filter((x): x is string => typeof x === 'string') : [])

/** Ollama and LM Studio when they run, Ollama first. Nothing else is probed. */
export async function detectRunners(net: LocalNet): Promise<Runner[]> {
  const [o, l] = await Promise.all([net.get(`${OLLAMA}/api/tags`).catch(() => null), net.get(`${LM_STUDIO}/v1/models`).catch(() => null)])
  const out: Runner[] = []
  const ollama = parse(o)
  if (ollama && Array.isArray(ollama['models']))
    out.push({
      kind: 'ollama',
      label: 'Ollama',
      base: `${OLLAMA}/v1`,
      models: names(ollama['models'], 'name'),
    })
  const lm = parse(l)
  if (lm && Array.isArray(lm['data']))
    out.push({
      kind: 'lmstudio',
      label: 'LM Studio',
      base: `${LM_STUDIO}/v1`,
      models: names(lm['data'], 'id').filter((id) => !/embed/i.test(id)),
    })
  return out
}

/** The runner's own name for `model`, or null when it does not have it. */
export function installedName(runner: Runner, model: LocalModel): string | null {
  if (runner.kind === 'ollama') return runner.models.find((n) => n === model.ollama) ?? null
  const want = model.lmStudio.toLowerCase()
  return runner.models.find((id) => id.toLowerCase().includes(want)) ?? null
}

export interface PullProgress {
  status: string
  completedBytes: number
  totalBytes: number
}

async function* lines(body: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) yield line
    }
  }
  if (buf.trim()) yield buf.trim()
}

/** Pulls `tag` through Ollama's /api/pull and reports progress summed over its layers. Rejects with an AbortError on cancel. */
export async function pullModel(net: LocalNet, tag: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
  const layers = new Map<string, { total: number; done: number }>()
  let last = ''
  for await (const line of lines(net.post(`${OLLAMA}/api/pull`, JSON.stringify({ model: tag, stream: true }), signal))) {
    if (signal?.aborted) break
    const ev = parse(line)
    if (!ev) continue
    if (typeof ev['error'] === 'string') throw new Error(`Ollama could not download ${tag}: ${ev['error']}`)
    last = typeof ev['status'] === 'string' ? ev['status'] : last
    const digest = typeof ev['digest'] === 'string' ? ev['digest'] : ''
    if (digest && typeof ev['total'] === 'number')
      layers.set(digest, {
        total: ev['total'],
        done: typeof ev['completed'] === 'number' ? ev['completed'] : 0,
      })
    let total = 0
    let done = 0
    for (const l of layers.values()) {
      total += l.total
      done += l.done
    }
    onProgress({ status: last, completedBytes: done, totalBytes: total })
  }
  if (signal?.aborted) throw new DOMException('Download canceled', 'AbortError')
  if (last !== 'success') throw new Error('The download stopped before it finished. Try again; Ollama keeps what arrived.')
}

/**
 * The Ollama tag that loads `tag` with `ctx` tokens of context: `qwen2.5:14b-instruct` becomes
 * `qwen2.5:14b-instruct-ctx16k`, and a tag that already ends that way stays as it is.
 */
export function contextTag(tag: string, ctx: number = MIMIR_CONTEXT): string {
  const suffix = `-ctx${Math.round(ctx / 1024)}k`
  if (tag.endsWith(suffix)) return tag
  return tag.lastIndexOf(':') > tag.lastIndexOf('/') ? `${tag}${suffix}` : `${tag}:latest${suffix}`
}

/**
 * Gives `tag` the context mimir needs in Ollama: creates the contextTag variant, which shares the
 * downloaded weights and only sets num_ctx, so it costs no download and no disk. Mimir keeps
 * talking to /v1/chat/completions, which cannot set the context per request. Returns the tag to use.
 */
export async function ensureContext(net: LocalNet, tag: string, signal?: AbortSignal, ctx: number = MIMIR_CONTEXT): Promise<string> {
  const variant = contextTag(tag, ctx)
  if (variant === tag) return tag
  let last = ''
  const body = JSON.stringify({ model: variant, from: tag, parameters: { num_ctx: ctx }, stream: true })
  for await (const line of lines(net.post(`${OLLAMA}/api/create`, body, signal))) {
    const ev = parse(line)
    if (!ev) continue
    if (typeof ev['error'] === 'string') throw new Error(`Ollama could not give ${tag} room for ${ctx} tokens: ${ev['error']}`)
    if (typeof ev['status'] === 'string') last = ev['status']
  }
  if (signal?.aborted) throw new DOMException('Setup canceled', 'AbortError')
  if (last !== 'success') throw new Error(`Ollama stopped before ${tag} was set up. Try again.`)
  return variant
}

/**
 * The context `model` is loaded with right now, from Ollama's /api/ps or LM Studio's
 * /api/v0/models, or null when the runner does not say or the model is not loaded.
 */
export async function loadedContext(net: LocalNet, base: string, model: string): Promise<number | null> {
  let origin: string
  try {
    origin = new URL(base).origin
  } catch {
    return null
  }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  if (origin === OLLAMA) {
    const ps = parse(await net.get(`${OLLAMA}/api/ps`).catch(() => null))
    const list = Array.isArray(ps?.['models']) ? (ps?.['models'] as Record<string, unknown>[]) : []
    const want = model.includes(':') ? [model] : [model, `${model}:latest`]
    const hit = list.find((m) => want.includes(m?.['name'] as string) || want.includes(m?.['model'] as string))
    return num(hit?.['context_length'])
  }
  if (origin === LM_STUDIO) {
    const v = parse(await net.get(`${LM_STUDIO}/api/v0/models`).catch(() => null))
    const list = Array.isArray(v?.['data']) ? (v?.['data'] as Record<string, unknown>[]) : []
    return num(list.find((m) => m?.['id'] === model)?.['loaded_context_length'])
  }
  return null
}

export interface CheckResult {
  ok: boolean
  toolCall: boolean
  tokensPerSecond: number | null
  /** The context the model was loaded with, when the runner reports it. */
  contextTokens: number | null
  message: string
}

const TOOL = 'kb.filament'

// the adapter and the kb tool (with its zod schemas) load when a check runs, so an app that shows the
// model table starts without them
const kbTool = async () => (await import('./tools/kb')).kbTools().find((t) => t.name === TOOL)

async function collect(net: LocalNet, base: string, req: Parameters<ReturnType<typeof createOpenAiCompatibleAdapter>['build']>[0], signal: AbortSignal | undefined, onText?: () => void) {
  const adapter = (await import('./provider/openai-compatible')).createOpenAiCompatibleAdapter()
  const http = adapter.build(req, { baseUrl: base })
  const calls: { name: string; arguments: string }[] = []
  let text = ''
  let tokens = 0
  let error = ''
  for await (const ev of adapter.parse(net.post(http.url, http.body, signal))) {
    if (ev.type === 'text') {
      if (!text) onText?.()
      text += ev.delta
    } else if (ev.type === 'tool_call') calls.push(ev.call)
    else if (ev.type === 'usage') tokens = ev.outputTokens
    else if (ev.type === 'error') error = ev.message
  }
  return { calls, text, tokens, error }
}

/** True when the model made exactly the expected kb.filament call, with arguments that parse strictly. */
export async function strictToolCall(calls: { name: string; arguments: string }[]): Promise<boolean> {
  const tool = await kbTool()
  if (!tool || calls.length !== 1 || calls[0]?.name !== TOOL) return false
  let args: unknown
  try {
    args = JSON.parse(calls[0].arguments)
  } catch {
    return false
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false
  if (Object.keys(args).join() !== 'material') return false
  const parsed = (
    tool.input as unknown as {
      safeParse(v: unknown): { success: boolean; data?: { material: string } }
    }
  ).safeParse(args)
  return parsed.success && /petg/i.test(parsed.data?.material ?? '')
}

/**
 * One tool call mimir defines (kb.filament, strictly parsed), the context the model loaded with,
 * and a short answer timed from its first word, so model loading does not count against the speed.
 */
export async function checkModel(net: LocalNet, base: string, model: string, opts: { signal?: AbortSignal; now?: () => number } = {}): Promise<CheckResult> {
  const now = opts.now ?? (() => performance.now())
  const tool = await kbTool()
  if (!tool)
    return {
      ok: false,
      toolCall: false,
      tokensPerSecond: null,
      contextTokens: null,
      message: 'The tool check is missing from this build.',
    }
  const spec = (await import('./tool')).toolSpec(tool)
  let toolCall = false
  try {
    const r = await collect(
      net,
      base,
      {
        model,
        messages: [
          {
            role: 'system',
            content: 'You answer 3D printing questions. Use the tools you are given to look facts up.',
          },
          {
            role: 'user',
            content: 'Look up the filament PETG in the knowledge base.',
          },
        ],
        tools: [
          {
            name: spec.name,
            description: spec.description,
            parameters: spec.inputSchema,
          },
        ],
        toolChoice: 'auto',
        maxOutputTokens: 200,
      },
      opts.signal,
    )
    if (r.error)
      return {
        ok: false,
        toolCall: false,
        tokensPerSecond: null,
        contextTokens: null,
        message: `The model answered with an error: ${r.error}`,
      }
    toolCall = await strictToolCall(r.calls)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    return {
      ok: false,
      toolCall: false,
      tokensPerSecond: null,
      contextTokens: null,
      message: `The model did not answer: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (!toolCall)
    return {
      ok: false,
      toolCall: false,
      tokensPerSecond: null,
      contextTokens: null,
      message: 'The model did not make the tool call correctly, so it cannot look things up or suggest changes.',
    }
  const contextTokens = await loadedContext(net, base, model)
  if (contextTokens != null && contextTokens < MIMIR_CONTEXT) {
    const fix = new URL(base).origin === LM_STUDIO ? `In LM Studio, load it again with a context length of ${MIMIR_CONTEXT} or more.` : 'Set it up again here so it loads with enough room.'
    return {
      ok: false,
      toolCall: true,
      tokensPerSecond: null,
      contextTokens,
      message: `The model is loaded with room for ${contextTokens} tokens, and ${ASSISTANT_NAME} needs ${MIMIR_CONTEXT}, so it would not see its tools. ${fix}`,
    }
  }
  let first = 0
  const r = await collect(
    net,
    base,
    {
      model,
      messages: [
        {
          role: 'user',
          content: 'In two sentences, why does PETG need a hotter nozzle than PLA?',
        },
      ],
      tools: [],
      maxOutputTokens: 96,
    },
    opts.signal,
    () => (first = now()),
  ).catch(() => null)
  const seconds = first ? (now() - first) / 1000 : 0
  const tokens = r ? r.tokens || Math.ceil(r.text.length / 4) : 0
  const tps = seconds > 0 && tokens > 1 ? Math.round(tokens / seconds) : null
  return {
    ok: true,
    toolCall: true,
    tokensPerSecond: tps,
    contextTokens,
    message: tps ? `Tool call passed. About ${tps} tokens per second.` : 'Tool call passed.',
  }
}

export function formatGb(bytesOrGb: number, unit: 'bytes' | 'gb' = 'gb'): string {
  const v = unit === 'bytes' ? bytesOrGb / 1e9 : bytesOrGb
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} GB`
}
