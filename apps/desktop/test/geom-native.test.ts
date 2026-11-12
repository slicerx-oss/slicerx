// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The native Model engine's switch and its shell transport (src/host/geom-native.ts): the page keeps its worker unless
// the build has the engine and the environment or the developer setting asks, and a frame goes to the shell as raw
// bytes and comes back with the number of the process that answered.
import { afterEach, describe, expect, it } from 'vitest'
import { EngineEnded } from '@slicerx/app/geom/native'
import { setGeomProvider, usesWorker, geom } from '../../../packages/app/src/geom/client'
import { startNativeGeom, tauriEngine, wantsNativeGeom } from '../src/host/geom-native'

afterEach(() => {
  setGeomProvider(null)
  localStorage.clear()
})

const shell = (info: unknown, answer?: (cmd: string, args: unknown) => unknown) =>
  (async (cmd: string, args?: unknown) => {
    if (cmd === 'geom_engine') {
      if (info === null) throw new Error('command geom_engine not found')
      return info
    }
    return answer?.(cmd, args)
  }) as never

describe('the switch', () => {
  it('keeps the worker by default', async () => {
    expect(await wantsNativeGeom(shell({ native: true, env: null }), localStorage)).toBe(false)
    expect(await startNativeGeom(shell({ native: true, env: null }))).toBe(false)
    expect(usesWorker()).toBe(true)
  })

  it('keeps the worker in a build without the native engine, whatever is asked', async () => {
    localStorage.setItem('sx.nativeGeom', '1')
    expect(await wantsNativeGeom(shell(null), localStorage)).toBe(false)
  })

  it('uses the native engine when the developer setting or the environment asks, and the environment wins', async () => {
    localStorage.setItem('sx.nativeGeom', '1')
    expect(await wantsNativeGeom(shell({ native: true, env: null }), localStorage)).toBe(true)
    expect(await wantsNativeGeom(shell({ native: true, env: '0' }), localStorage)).toBe(false)
    localStorage.clear()
    expect(await wantsNativeGeom(shell({ native: true, env: '1' }), localStorage)).toBe(true)
  })

  it('installs the native provider in place of the worker', async () => {
    expect(await startNativeGeom(shell({ native: true, env: '1' }))).toBe(true)
    expect(await geom().call('engine.full', null)).toBe(true)
  })
})

describe('the shell transport', () => {
  it('sends the frame as raw bytes and reads the process number ahead of the answer', async () => {
    const sent: unknown[] = []
    const engine = tauriEngine(shell(null, (cmd, args) => {
      sent.push([cmd, args])
      const out = new Uint8Array([7, 0, 0, 0, 9, 9])
      return out.buffer
    }))
    const frame = new Uint8Array([1, 2, 3])
    const r = await engine.call(frame)
    expect(sent).toEqual([['geom_call', frame]])
    expect(r.generation).toBe(7)
    expect([...r.frame]).toEqual([9, 9])
    await engine.end()
    expect(sent.at(-1)).toEqual(['geom_end', undefined])
  })

  it('turns the shell word for an ended process into EngineEnded', async () => {
    const engine = tauriEngine(shell(null, () => Promise.reject('{"ended":true,"code":134}')))
    const e = await engine.call(new Uint8Array(0)).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(EngineEnded)
    expect((e as EngineEnded).code).toBe(134)
    const other = tauriEngine(shell(null, () => Promise.reject('geom_call expects raw bytes')))
    await expect(other.call(new Uint8Array(0))).rejects.toBe('geom_call expects raw bytes')
  })
})
