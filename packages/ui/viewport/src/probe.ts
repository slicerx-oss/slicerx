// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Frame probe for profiling: page frame times (requestAnimationFrame deltas), what each viewport render cost on the
// CPU and, where EXT_disjoint_timer_query_webgl2 exists, on the GPU, plus draw calls, triangles and live textures.
// Off unless asked for: `setProbe(true)` on the viewport, or localStorage `slicerx.probe` = 1 before it starts.
import type { WebGLRenderer } from 'three'

export interface ProbeStats {
  /** Wall time the probe covered, ms. */
  spanMs: number
  /** Page frames seen (requestAnimationFrame callbacks). */
  pageFrames: number
  /** Page frame deltas, ms. A long one is a dropped frame whatever caused it (render, React, layout). */
  pageMs: Spread
  /** Frames the viewport drew. Zero while idle when rendering on demand works. */
  renders: number
  /** CPU time of each viewport render (scene, passes and the calls that queue them), ms. */
  cpuMs: Spread
  /** GPU time of each viewport render from timer queries, ms; null where the extension is missing. */
  gpuMs: Spread | null
  /** Per render, from the last one. */
  drawCalls: number
  triangles: number
  /** Live textures and geometries the renderer holds now. */
  textures: number
  geometries: number
  programs: number
}

export interface Spread {
  n: number
  mean: number
  p50: number
  p95: number
  max: number
}

interface TimerExt {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

export function spread(values: readonly number[]): Spread {
  const s = values.slice().sort((a, b) => a - b)
  const at = (q: number): number => (s.length ? (s[Math.min(s.length - 1, Math.floor(q * s.length))] as number) : 0)
  const sum = s.reduce((a, b) => a + b, 0)
  return { n: s.length, mean: s.length ? sum / s.length : 0, p50: at(0.5), p95: at(0.95), max: s.length ? (s[s.length - 1] as number) : 0 }
}

/** True when the page asked for the probe (localStorage `slicerx.probe` = 1). */
export function probeRequested(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('slicerx.probe') === '1'
  } catch {
    return false
  }
}

export class FrameProbe {
  private readonly gl: WebGL2RenderingContext
  private readonly ext: TimerExt | null
  private readonly pending: WebGLQuery[] = []
  private query: WebGLQuery | null = null
  private raf = 0
  private last = 0
  private t0 = 0
  private page: number[] = []
  private cpu: number[] = []
  private gpu: number[] = []
  private renders = 0
  private calls = 0
  private tris = 0
  private cpuStart = 0

  constructor(private readonly renderer: WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext
    this.ext = (this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) ?? null
    this.reset()
    this.loop()
  }

  get gpuTimer(): boolean {
    return this.ext !== null
  }

  private readonly onFrame = (now: number): void => {
    if (this.last) this.page.push(now - this.last)
    this.last = now
    this.collect()
    this.raf = requestAnimationFrame(this.onFrame)
  }

  private loop(): void {
    if (typeof requestAnimationFrame === 'function') this.raf = requestAnimationFrame(this.onFrame)
  }

  /** Called by the viewport right before it draws a frame. */
  begin(): void {
    this.cpuStart = performance.now()
    if (!this.ext || this.query) return
    const q = this.gl.createQuery()
    if (!q) return
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
    this.query = q
  }

  /** Called by the viewport right after the frame's last pass. */
  end(): void {
    this.cpu.push(performance.now() - this.cpuStart)
    this.renders++
    const info = this.renderer.info.render
    this.calls = info.calls
    this.tris = info.triangles
    if (this.ext && this.query) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
      this.pending.push(this.query)
      this.query = null
    }
  }

  /** Reads finished timer queries; a disjoint event (power state, context switch) voids the ones in flight. */
  private collect(): void {
    if (!this.ext || this.pending.length === 0) return
    const gl = this.gl
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean
    while (this.pending.length) {
      const q = this.pending[0] as WebGLQuery
      if (!disjoint && !(gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean)) break
      this.pending.shift()
      if (!disjoint) this.gpu.push((gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6)
      gl.deleteQuery(q)
    }
  }

  reset(): void {
    this.page = []
    this.cpu = []
    this.gpu = []
    this.renders = 0
    this.last = 0
    this.t0 = performance.now()
  }

  stats(): ProbeStats {
    this.collect()
    const mem = this.renderer.info.memory
    return {
      spanMs: performance.now() - this.t0,
      pageFrames: this.page.length + (this.last ? 1 : 0),
      pageMs: spread(this.page),
      renders: this.renders,
      cpuMs: spread(this.cpu),
      gpuMs: this.ext ? spread(this.gpu) : null,
      drawCalls: this.calls,
      triangles: this.tris,
      textures: mem.textures,
      geometries: mem.geometries,
      programs: this.renderer.info.programs?.length ?? 0,
    }
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    if (this.query && this.ext) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    for (const q of this.pending) this.gl.deleteQuery(q)
    if (this.query) this.gl.deleteQuery(this.query)
    this.pending.length = 0
    this.query = null
  }
}
