// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// <LocalAiSetup> and useLocalAi: SlicerX's Set up local AI for another app. It recommends one model
// for the computer, finds a running Ollama or LM Studio, downloads the model through Ollama after a
// confirm that shows its size and license, and checks a tool call and the speed. Requests go only
// to 127.0.0.1 on Ollama's and LM Studio's ports. The host app decides what to do with the ready
// model (onReady).
import {
  allowedModels,
  checkModel,
  detectRunners,
  ensureContext,
  fetchNet,
  formatGb,
  installedName,
  licenseOf,
  nextModelUp,
  OLLAMA_DOWNLOAD,
  pullModel,
  recommend,
  shortGpuName,
  type CheckResult,
  type Hardware,
  type License,
  type LocalModel,
  type LocalNet,
  type PullProgress,
  type Recommendation,
  type Runner,
} from '@slicerx/pilot/local-ai'
import type { Theme } from '@slicerx/ui/theme'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { EmbedTheme } from './theme'

export type { Hardware, LocalModel, LocalNet, Runner } from '@slicerx/pilot/local-ai'

export interface LocalAiReady {
  /** The model name the runner knows, such as "qwen2.5:14b". */
  model: string
  name: string
  /** OpenAI-compatible chat completions base, such as http://127.0.0.1:11434/v1. */
  baseUrl: string
  tokensPerSecond: number | null
}

export interface UseLocalAiOptions {
  /** The hardware read. Default: what the browser shows (cores, rough memory, no graphics memory). Electron and Tauri hosts pass a native read. */
  hardware?: () => Promise<Hardware>
  /** Requests to the local servers. Default: fetch, refused for anything but 127.0.0.1:11434 and :1234. */
  net?: LocalNet
  /** Model ids to offer (an edition's ai.allowedLocalModels). Default: all. */
  allowedModels?: string[]
  onReady?: (ready: LocalAiReady) => void
}

export type LocalAiJob =
  | { at: 'idle' }
  | { at: 'pulling'; progress: PullProgress | null }
  | { at: 'checking' }
  | { at: 'done'; ready: LocalAiReady; result: CheckResult }
  | { at: 'failed'; message: string }

export interface LocalAiState {
  hardware: Hardware | null
  recommendation: Recommendation | null
  /** The model on offer: the recommendation, or the next one up after a failed check. */
  model: LocalModel | null
  license: License | null
  /** Running model apps, Ollama first; null while looking. */
  runners: Runner[] | null
  /** The runner's name for `model` when it has it already. */
  installed: string | null
  job: LocalAiJob
  /** The next stronger model that still fits, offered after a failed check. */
  next: LocalModel | null
  detect(): Promise<void>
  /** Pulls `model` through Ollama, then checks it. Call it only after the person confirmed the size and license. */
  download(): Promise<void>
  /** Checks a model the runner already has. */
  test(model?: string): Promise<void>
  cancel(): void
  tryNext(): void
}

function browserHardware(): Hardware {
  const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { deviceMemory?: number })
  return { gpu: null, ramMb: nav?.deviceMemory ? nav.deviceMemory * 1024 : null, cores: nav?.hardwareConcurrency || null, source: 'browser' }
}

export function useLocalAi(opts: UseLocalAiOptions = {}): LocalAiState {
  const net = useMemo(() => opts.net ?? fetchNet(), [opts.net])
  const readHardware = opts.hardware
  const allowed = opts.allowedModels?.join(',')
  const models = useMemo(() => allowedModels(allowed ? allowed.split(',') : undefined), [allowed])
  const ready = useRef(opts.onReady)
  ready.current = opts.onReady
  const [hardware, setHardware] = useState<Hardware | null>(null)
  const [runners, setRunners] = useState<Runner[] | null>(null)
  const [chosen, setChosen] = useState<LocalModel | null>(null)
  const [job, setJob] = useState<LocalAiJob>({ at: 'idle' })
  const ctl = useRef<AbortController | null>(null)

  const detect = useCallback(async () => {
    setRunners(null)
    setRunners(await detectRunners(net))
  }, [net])

  useEffect(() => {
    let live = true
    ;(readHardware ?? (async () => browserHardware()))().then(
      (h) => live && setHardware(h),
      () => live && setHardware({ gpu: null, ramMb: null, cores: null, source: 'browser' }),
    )
    void detect()
    return () => {
      live = false
      ctl.current?.abort()
    }
  }, [readHardware, detect])

  const recommendation = hardware ? recommend(hardware, models) : null
  const model = chosen ?? (recommendation?.kind === 'model' ? recommendation.model : null)
  const runner = runners?.[0] ?? null
  const installed = runner && model ? installedName(runner, model) : null

  const run = async (pulled: string, name: string, pull: boolean) => {
    if (!runner || job.at === 'pulling' || job.at === 'checking') return
    const c = new AbortController()
    ctl.current = c
    try {
      if (pull) {
        setJob({ at: 'pulling', progress: null })
        await pullModel(net, pulled, (progress) => setJob({ at: 'pulling', progress }), c.signal)
      }
      setJob({ at: 'checking' })
      const tag = runner.kind === 'ollama' ? await ensureContext(net, pulled, c.signal) : pulled
      const result = await checkModel(net, runner.base, tag, { signal: c.signal })
      if (!result.ok) {
        setJob({ at: 'failed', message: result.message })
        return
      }
      const r: LocalAiReady = { model: tag, name, baseUrl: runner.base, tokensPerSecond: result.tokensPerSecond }
      setJob({ at: 'done', ready: r, result })
      ready.current?.(r)
    } catch (e) {
      setJob(e instanceof DOMException && e.name === 'AbortError' ? { at: 'idle' } : { at: 'failed', message: e instanceof Error ? e.message : String(e) })
    }
  }

  return {
    hardware,
    recommendation,
    model,
    license: model ? licenseOf(model) : null,
    runners,
    installed,
    job,
    next: model && hardware ? nextModelUp(model, hardware, models) : null,
    detect,
    download: () => (model && runner?.kind === 'ollama' ? run(model.ollama, model.name, true) : Promise.resolve()),
    test: (tag) => {
      const t = tag ?? installed
      return t ? run(t, model && t === installed ? model.name : t, false) : Promise.resolve()
    },
    cancel: () => ctl.current?.abort(),
    tryNext: () => {
      const next = model && hardware ? nextModelUp(model, hardware, models) : null
      if (next) setChosen(next)
      setJob({ at: 'idle' })
    },
  }
}

export interface LocalAiSetupProps extends UseLocalAiOptions {
  /** A theme made with createTheme from your edition's tokens, or "dark" / "light". Omitted: the surrounding EmbedTheme, else Nocturne. */
  theme?: Theme | 'dark' | 'light'
  /** Opens Ollama's download page. Default: a new browser tab. Desktop hosts pass their system browser opener. */
  onOpenUrl?: (url: string) => void
  className?: string
  style?: CSSProperties
}

function gb(mb: number | null | undefined): string {
  return mb ? `${Math.round(mb / 1024)} GB` : 'unknown'
}

function Setup({ onOpenUrl, className, style, ...opts }: Omit<LocalAiSetupProps, 'theme'>) {
  const s = useLocalAi(opts)
  const [confirm, setConfirm] = useState(false)
  const hw = s.hardware
  const runner = s.runners?.[0] ?? null
  const open = onOpenUrl ?? ((url: string) => void window.open(url, '_blank', 'noopener'))
  const pct = s.job.at === 'pulling' && s.job.progress?.totalBytes ? Math.min(100, Math.floor((s.job.progress.completedBytes / s.job.progress.totalBytes) * 100)) : 0
  const rec = s.recommendation

  return (
    <div className={className ? `sxe-localai ${className}` : 'sxe-localai'} style={style}>
      <p className="sxe-la-title">Run a model on this computer</p>
      <p className="sxe-la-note">Free and private: questions never leave this computer.</p>
      {hw ? (
        <dl className="sxe-la-facts">
          <dt>Graphics</dt>
          <dd>{hw.gpu ? `${shortGpuName(hw.gpu.name)}${hw.gpu.vramMb ? `, ${gb(hw.gpu.vramMb)}` : ''}` : hw.source === 'browser' ? 'not visible in the browser' : 'none found'}</dd>
          <dt>Memory</dt>
          <dd>{gb(hw.ramMb)}</dd>
          <dt>Processor</dt>
          <dd>{hw.cores ? `${hw.cores} cores` : 'unknown'}</dd>
        </dl>
      ) : (
        <p className="sxe-la-note">Reading this computer&apos;s hardware.</p>
      )}
      {rec && rec.kind !== 'model' ? <p className="sxe-la-note">{rec.reason}</p> : null}
      {s.model && rec?.kind === 'model' ? (
        <div className="sxe-la-rec">
          <b>{s.model.name}</b>
          <p>{s.model.id === rec.model.id ? rec.reason : `Next up from ${rec.model.name}.`}</p>
          <p className="sxe-la-note">
            {formatGb(s.model.downloadGb)} download. Tool use: {s.model.tools}. License: {s.license?.name}. {s.license?.plain}
          </p>
        </div>
      ) : null}
      {rec?.kind !== 'too-weak' && hw ? (
        s.runners === null ? (
          <p className="sxe-la-note">Looking for Ollama or LM Studio on this computer.</p>
        ) : runner ? (
          <p>{runner.label} is running.</p>
        ) : (
          <div className="sxe-la-act">
            <span className="sxe-la-note">A free model app runs the model. Ollama is the simplest.</span>
            <button type="button" className="sxe-primary" onClick={() => open(OLLAMA_DOWNLOAD)}>
              Get Ollama
            </button>
            <button type="button" className="sxe-ghost" onClick={() => void s.detect()}>
              Check again
            </button>
          </div>
        )
      ) : null}
      {runner && s.job.at === 'idle' && !confirm ? (
        <div className="sxe-la-act">
          {s.installed ? (
            <button type="button" className="sxe-primary" onClick={() => void s.test()}>
              Test and use
            </button>
          ) : runner.kind === 'ollama' && s.model ? (
            <button type="button" className="sxe-primary" onClick={() => setConfirm(true)}>
              Download {formatGb(s.model.downloadGb)}
            </button>
          ) : runner.kind === 'lmstudio' && runner.models[0] ? (
            <button type="button" className="sxe-primary" onClick={() => void s.test(runner.models[0])}>
              Test {runner.models[0]}
            </button>
          ) : null}
        </div>
      ) : null}
      {confirm && s.model && s.job.at === 'idle' ? (
        <div className="sxe-la-confirm" role="group" aria-label="Confirm download">
          <p>
            Download {s.model.name} ({formatGb(s.model.downloadGb)}) with Ollama? It is saved on this computer and works offline. License: {s.license?.name}.
          </p>
          <div className="sxe-la-act">
            <button
              type="button"
              className="sxe-primary"
              onClick={() => {
                setConfirm(false)
                void s.download()
              }}
            >
              Download
            </button>
            <button type="button" className="sxe-ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {s.job.at === 'pulling' ? (
        <div className="sxe-la-act">
          <progress max={100} value={pct} aria-label={`Downloading ${s.model?.name ?? 'the model'}`} />
          <span className="sxe-la-note" aria-live="polite">
            {s.job.progress?.totalBytes ? `${formatGb(s.job.progress.completedBytes, 'bytes')} of ${formatGb(s.job.progress.totalBytes, 'bytes')}, ${pct}%` : 'Starting the download'}
          </span>
          <button type="button" className="sxe-ghost" onClick={s.cancel}>
            Cancel
          </button>
        </div>
      ) : null}
      {s.job.at === 'checking' ? <p className="sxe-la-note">Checking a tool call and the speed.</p> : null}
      {s.job.at === 'done' ? (
        <p role="status">
          {s.job.ready.name} is ready. {s.job.result.message}
        </p>
      ) : null}
      {s.job.at === 'failed' ? (
        <div role="alert">
          <p>{s.job.message}</p>
          <div className="sxe-la-act">
            {s.next && runner?.kind === 'ollama' ? (
              <button type="button" className="sxe-primary" onClick={s.tryNext}>
                Try {s.next.name}
              </button>
            ) : (
              <span className="sxe-la-note">Use a cloud model instead.</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** The Set up local AI helper as one piece. */
export function LocalAiSetup({ theme, ...rest }: LocalAiSetupProps) {
  return theme ? (
    <EmbedTheme theme={theme}>
      <Setup {...rest} />
    </EmbedTheme>
  ) : (
    <Setup {...rest} />
  )
}
