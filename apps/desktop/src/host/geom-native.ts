// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model engine run natively by the shell (src-tauri/src/geom_host.rs), in place of the page's geometry worker. Only
// a build with the native-geom feature has it, and the page uses it only when asked: SLICERX_NATIVE_GEOM=1 in the
// app's environment (tests), or the developer setting localStorage 'sx.nativeGeom' = '1'. SLICERX_NATIVE_GEOM=0 keeps
// the worker whatever the setting says. Without either, the page keeps its worker.
import { EngineEnded, useNativeEngine, type NativeEngine } from '@slicerx/app/geom/native'
import { invoke as shellInvoke } from './invoke'

type Invoke = <T>(cmd: string, args?: Uint8Array | Record<string, unknown>) => Promise<T>

/** The developer setting that has the page use the native engine. */
export const NATIVE_GEOM_KEY = 'sx.nativeGeom'

/** The shell's engine process: each call's frame as a raw body, its answer as raw bytes after the process's number. */
export function tauriEngine(invoke: Invoke = shellInvoke as Invoke): NativeEngine {
  return {
    async call(frame) {
      let out: ArrayBuffer
      try {
        out = await invoke<ArrayBuffer>('geom_call', frame)
      } catch (e) {
        throw endedOf(e) ?? e
      }
      const bytes = new Uint8Array(out)
      return { generation: new DataView(out).getUint32(0, true), frame: bytes.subarray(4) }
    },
    async end() {
      await invoke('geom_end')
    },
  }
}

/** The shell's word that the engine process ended before it answered (`{"ended": true, "code": ...}`). */
function endedOf(e: unknown): EngineEnded | null {
  if (typeof e !== 'string' || !e.startsWith('{')) return null
  try {
    const v = JSON.parse(e) as { ended?: boolean; code?: number | null }
    return v.ended ? new EngineEnded(v.code ?? null) : null
  } catch {
    return null
  }
}

/** Whether the page should use the native engine: the build has it and the environment or the developer setting asks. */
export async function wantsNativeGeom(invoke: Invoke = shellInvoke as Invoke, storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): Promise<boolean> {
  // a build without the feature has no such command
  const info = await invoke<{ native?: boolean; env?: string | null }>('geom_engine').catch(() => null)
  if (!info?.native) return false
  if (info.env === '1') return true
  if (info.env === '0') return false
  try {
    return storage?.getItem(NATIVE_GEOM_KEY) === '1'
  } catch {
    return false
  }
}

/** Makes the native engine the page's geometry provider when wantsNativeGeom says so; true when it did. */
export async function startNativeGeom(invoke: Invoke = shellInvoke as Invoke): Promise<boolean> {
  if (!(await wantsNativeGeom(invoke))) return false
  useNativeEngine(tauriEngine(invoke))
  return true
}
