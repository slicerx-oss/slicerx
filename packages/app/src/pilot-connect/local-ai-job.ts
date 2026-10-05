// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The one local model download and check that can run at a time. It lives outside any screen, so
// first-run setup can finish while the model downloads; mimir switches when the check passes, and
// a toast says so wherever the person is.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { useSyncExternalStore } from 'react'
import { set, toast } from '../state/store'
import { checkModel, ensureContext, pullModel, type CheckResult, type LocalNet, type PullProgress, type Runner } from './local-ai'

export type LocalAiJob =
  | { at: 'idle' }
  | { at: 'pulling'; name: string; tag: string; progress: PullProgress | null }
  | { at: 'checking'; name: string; tag: string }
  | { at: 'done'; name: string; tag: string; result: CheckResult }
  | { at: 'failed'; name: string; tag: string; message: string }

let job: LocalAiJob = { at: 'idle' }
let ctl: AbortController | null = null
const listeners = new Set<() => void>()

function update(next: LocalAiJob): void {
  job = next
  for (const l of listeners) l()
}

export function localAiJob(): LocalAiJob {
  return job
}

export function useLocalAiJob(): LocalAiJob {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => job,
    () => job,
  )
}

export function localAiBusy(): boolean {
  return job.at === 'pulling' || job.at === 'checking'
}

/** Stops a running download or check; the job goes back to idle. */
export function cancelLocalAi(): void {
  ctl?.abort()
}

/** Back to idle after a result was shown. */
export function resetLocalAi(): void {
  if (!localAiBusy()) update({ at: 'idle' })
}

/**
 * Pulls `tag` through Ollama when `pull` is set, gives it the context mimir needs, checks it, then
 * switches mimir to it. `name` is what people read ("Qwen 2.5 14B"). Resolves when the job ends,
 * whatever the result.
 */
export async function startLocalAi(net: LocalNet, runner: Runner, opts: { tag: string; name: string; pull: boolean }): Promise<void> {
  if (localAiBusy()) return
  const c = new AbortController()
  ctl = c
  const { tag, name } = opts
  try {
    if (opts.pull) {
      update({ at: 'pulling', name, tag, progress: null })
      await pullModel(net, tag, (progress) => update({ at: 'pulling', name, tag, progress }), c.signal)
    }
    update({ at: 'checking', name, tag })
    // The tag mimir uses: in Ollama the variant with mimir's context, shown to people as `tag`.
    const use = runner.kind === 'ollama' ? await ensureContext(net, tag, c.signal) : tag
    const result = await checkModel(net, runner.base, use, { signal: c.signal })
    if (!result.ok) {
      update({ at: 'failed', name, tag, message: result.message })
      toast(`${name} did not pass the check. Settings > ${ASSISTANT_NAME} has other options.`, 'warn')
      return
    }
    set({ pilot: { mode: 'on', provider: 'local', baseUrl: runner.base, model: use } })
    update({ at: 'done', name, tag, result })
    toast(`${ASSISTANT_NAME} now runs ${name} on this computer.`, 'ok')
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') update({ at: 'idle' })
    else update({ at: 'failed', name, tag, message: e instanceof Error ? e.message : String(e) })
  } finally {
    if (ctl === c) ctl = null
  }
}
