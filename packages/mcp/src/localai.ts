// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Set up local AI for MCP clients: the same recommendation, Ollama pull and tool call check the
// app runs (@slicerx/pilot/local-ai), with this machine's hardware read in Node. Requests go only
// to Ollama and LM Studio on 127.0.0.1. The setup tool downloads gigabytes, so it always asks the
// user, whatever the policy says for its class.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { availableParallelism, homedir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import {
  allowedModels,
  appleGpuBudgetMb,
  checkModel,
  contextTag,
  detectRunners,
  ensureContext,
  fetchNet,
  formatGb,
  installedName,
  licenseOf,
  LOCAL_MODELS,
  OLLAMA_DOWNLOAD,
  parseNvidiaSmi,
  pullModel,
  recommend,
  type Hardware,
  type LocalModel,
  type LocalNet,
} from '@slicerx/pilot/local-ai'
import { z } from 'zod'

export interface LocalAiOptions {
  /** Leave the tools out, as an edition with features.localAi off does. */
  off?: boolean
  /** Local model ids an edition allows (ai.allowedLocalModels). */
  allowed?: string[]
  /** Where the model set up last is recorded. Default ~/.config/slicerx/local-ai.json. */
  stateFile?: string
  /** For tests: the hardware read and the local requests. */
  hardware?: () => Promise<Hardware>
  net?: LocalNet
}

/** What slicerx_local_ai_setup recorded after a passing check. */
export interface LocalAiState {
  model: string
  name: string
  runner: 'ollama' | 'lmstudio'
  baseUrl: string
  tokensPerSecond: number | null
  checkedAt: string
}

const run = (cmd: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim()))
  })

/** Windows display adapters from the registry: their real memory (WMI caps it at 4 GB). */
export function parseWindowsAdapters(json: string): Hardware['gpu'] {
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return null
  }
  let best: Hardware['gpu'] = null
  for (const r of Array.isArray(rows) ? rows : [rows]) {
    const o = r as Record<string, unknown> | null
    const name = typeof o?.['DriverDesc'] === 'string' ? o['DriverDesc'] : ''
    const bytes = Number(o?.['HardwareInformation.qwMemorySize'] ?? 0)
    if (!name || !Number.isFinite(bytes) || bytes <= 0) continue
    const mb = Math.round(bytes / (1024 * 1024))
    if (!best || mb > (best.vramMb ?? 0)) best = { name, vramMb: mb, unified: false }
  }
  return best
}

/** This machine, read the way the desktop shell reads it. */
export async function nodeHardware(): Promise<Hardware> {
  const ramMb = Math.round(totalmem() / (1024 * 1024))
  const cores = availableParallelism()
  let gpu: Hardware['gpu'] = null
  if (process.platform === 'darwin') {
    if ((await run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'])) === '1') {
      const wired = Number(await run('/usr/sbin/sysctl', ['-n', 'iogpu.wired_limit_mb'])) || 0
      gpu = { name: (await run('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'])) ?? 'Apple Silicon', vramMb: appleGpuBudgetMb(ramMb, wired), unified: true }
    }
  } else {
    const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
    gpu = smi ? parseNvidiaSmi(smi) : null
    if (!gpu && process.platform === 'win32') {
      const ps = await run('powershell', [
        '-NoProfile',
        '-Command',
        "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | Select-Object DriverDesc,'HardwareInformation.qwMemorySize' | ConvertTo-Json",
      ])
      gpu = ps ? parseWindowsAdapters(ps) : null
    }
    if (!gpu && process.platform === 'linux' && existsSync('/sys/class/drm')) {
      const sizes = readdirSync('/sys/class/drm').flatMap((d) => {
        try {
          return [Number(readFileSync(join('/sys/class/drm', d, 'device/mem_info_vram_total'), 'utf8').trim())]
        } catch {
          return []
        }
      })
      const bytes = Math.max(0, ...sizes)
      if (bytes > 0) gpu = { name: 'AMD graphics card', vramMb: Math.round(bytes / (1024 * 1024)), unified: false }
    }
  }
  return { gpu: gpu && (gpu.unified || (gpu.vramMb ?? 0) >= 1024) ? gpu : null, ramMb, cores, source: 'desktop' }
}

/** An edition's switches from the resolved config SLICERX_CONFIG names: features.localAi and ai.allowedLocalModels. */
export function localAiFromEnv(env: NodeJS.ProcessEnv): LocalAiOptions {
  const path = env['SLICERX_CONFIG']
  if (!path || !existsSync(path)) return {}
  const c = JSON.parse(readFileSync(path, 'utf8')) as { features?: { localAi?: unknown; pilot?: unknown }; ai?: { allowedLocalModels?: unknown } }
  const allowed = Array.isArray(c.ai?.allowedLocalModels) ? c.ai.allowedLocalModels.filter((x): x is string => typeof x === 'string') : undefined
  return { ...(c.features?.localAi === false || c.features?.pilot === false ? { off: true } : {}), ...(allowed ? { allowed } : {}) }
}

function readState(file: string): LocalAiState | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LocalAiState
  } catch {
    return null
  }
}

function modelInfo(m: LocalModel) {
  const license = licenseOf(m)
  return { id: m.id, name: m.name, ollama_tag: m.ollama, download_gb: m.downloadGb, min_vram_gb: m.minVramGb, min_ram_gb: m.minRamGb, tool_use: m.tools, license: license.name, license_plain: license.plain, provisional: m.provisional }
}

export function localAiTools(opts: LocalAiOptions = {}): PilotTool<never>[] {
  if (opts.off) return []
  const models = allowedModels(opts.allowed)
  const net = opts.net ?? fetchNet()
  const hardware = opts.hardware ?? nodeHardware
  const stateFile = opts.stateFile ?? join(homedir(), '.config', 'slicerx', 'local-ai.json')
  const pick = (id: string | undefined, hw: Hardware) => {
    if (id) return models.find((m) => m.id === id || m.ollama === id) ?? null
    const r = recommend(hw, models)
    return r.kind === 'model' ? r.model : null
  }

  const check = defineTool({
    name: 'local_ai.check',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      "Check whether this computer can run mimir's model locally: the graphics card and its memory, system memory and cores, one recommended model with the reason in plain words, its download size and license, and whether Ollama or LM Studio is running. Reads only this machine and 127.0.0.1; downloads nothing.",
    input: z.object({}),
    async run() {
      const [hw, runners] = await Promise.all([hardware(), detectRunners(net)])
      const rec = recommend(hw, models)
      return {
        summary: rec.kind === 'model' ? `${rec.model.name}: ${rec.reason}` : rec.reason,
        output: {
          hardware: { gpu: hw.gpu ? { name: hw.gpu.name, memory_gb: hw.gpu.vramMb ? Math.round(hw.gpu.vramMb / 1024) : null, shared_memory: hw.gpu.unified } : null, memory_gb: hw.ramMb ? Math.round(hw.ramMb / 1024) : null, cores: hw.cores },
          recommendation: rec.kind === 'model' ? { ...modelInfo(rec.model), reason: rec.reason, runs_on: rec.onGpu ? 'graphics card' : 'processor' } : null,
          ...(rec.kind !== 'model' ? { too_weak: rec.reason } : {}),
          runners: runners.map((r) => ({ app: r.label, base_url: r.base, models: r.models })),
          ...(runners.length ? {} : { get_ollama: OLLAMA_DOWNLOAD }),
        },
      }
    },
  })

  const status = defineTool({
    name: 'local_ai.status',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Show the local models installed in Ollama and LM Studio, with license and tool use for the ones SlicerX knows, and the model slicerx_local_ai_setup last set up and checked. Reads only 127.0.0.1 and the local state file.',
    input: z.object({}),
    async run() {
      const runners = await detectRunners(net)
      const state = readState(stateFile)
      const installed = runners.flatMap((r) =>
        r.models.map((name) => {
          const known = LOCAL_MODELS.find((m) => installedName(r, m) === name || (r.kind === 'ollama' && contextTag(m.ollama) === name))
          return { app: r.label, model: name, ...(known ? { known: modelInfo(known) } : {}) }
        }),
      )
      const running = state ? runners.some((r) => r.base === state.baseUrl && r.models.includes(state.model)) : false
      return {
        summary: state ? `${state.name} set up${running ? '' : ', but its model app is not running'}. ${installed.length} local ${installed.length === 1 ? 'model' : 'models'} installed.` : `No local model set up yet. ${installed.length} local ${installed.length === 1 ? 'model' : 'models'} installed.`,
        output: {
          in_use: state ? { ...state, available: running } : null,
          installed,
          runners: runners.map((r) => ({ app: r.label, base_url: r.base })),
          note: 'The SlicerX app switches mimir in Settings > mimir or after its own setup; this server records the model it set up for MCP clients.',
        },
      }
    },
  })

  const setup = defineTool({
    name: 'local_ai.setup',
    version: '1.0.0',
    source: 'command',
    // Downloads to this computer and changes which model is used: always asks (mustAsk below).
    permission: 'profile',
    description:
      'Download a local model through Ollama (the recommended one, or model by id or Ollama tag), then check one tool call and the speed. Sends progress notifications while it downloads. Always needs the user to approve, because it uses disk space and the network; the approval shows the size and license. Ollama must be running; if not, give the user the Ollama download page from slicerx_local_ai_check.',
    input: z.object({ model: z.string().min(1).optional().describe('Model id or Ollama tag, such as "qwen-2.5-14b" or "qwen2.5:14b". Default: the recommendation for this computer.') }),
    async mustAsk(i) {
      const m = pick(i.model, await hardware())
      return [m ? `Downloads ${formatGb(m.downloadGb)} to this computer` : 'Downloads a model to this computer']
    },
    async approval(i) {
      const m = pick(i.model, await hardware())
      if (!m) throw Object.assign(new Error(i.model ? `No local model "${i.model}" is offered here.` : 'This computer is too small for a useful local model. Use a cloud model instead.'), { code: 'invalid_input' })
      const license = licenseOf(m)
      return {
        title: `Download ${m.name} (${formatGb(m.downloadGb)}) with Ollama?`,
        lines: [`License: ${license.name}. ${license.plain}`, 'It is saved on this computer and works offline. Nothing else is installed.'],
        actions: [],
      }
    },
    async run(i, ctx) {
      if (!ctx.token) return { ok: false, summary: 'Not approved' }
      const hw = await hardware()
      const m = pick(i.model, hw)
      if (!m) return { ok: false, summary: 'No model to set up on this computer' }
      const ollama = (await detectRunners(net)).find((r) => r.kind === 'ollama')
      if (!ollama) return { ok: false, summary: `Ollama is not running. The user can get it at ${OLLAMA_DOWNLOAD}, start it, and try again.` }
      if (!installedName(ollama, m)) {
        ctx.progress(`Downloading ${m.name}`, 0)
        await pullModel(net, m.ollama, (p) => ctx.progress(p.totalBytes ? `${formatGb(p.completedBytes, 'bytes')} of ${formatGb(p.totalBytes, 'bytes')}` : p.status, p.totalBytes ? (p.completedBytes / p.totalBytes) * 0.9 : 0), ctx.signal)
      }
      ctx.progress('Setting the model up for mimir', 0.91)
      const tag = await ensureContext(net, m.ollama, ctx.signal)
      ctx.progress('Checking a tool call and the speed', 0.92)
      const result = await checkModel(net, ollama.base, tag, { signal: ctx.signal })
      ctx.progress(result.ok ? 'Done' : 'The check failed', 1)
      if (!result.ok) return { ok: false, summary: `${m.name} downloaded but did not pass the check: ${result.message}`, output: { model: modelInfo(m), check: result } }
      const state: LocalAiState = { model: tag, name: m.name, runner: 'ollama', baseUrl: ollama.base, tokensPerSecond: result.tokensPerSecond, checkedAt: new Date().toISOString() }
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
      return { summary: `${m.name} is ready. ${result.message}`, output: { model: modelInfo(m), check: result, base_url: ollama.base } }
    },
  })

  return [check, status, setup] as PilotTool<never>[]
}
