// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How the 3D view's start splits up: creating the renderer, the wait for the first frame, that frame, and the bead
// warm-up after it. The shader programs compile inside the first frame and the warm-up, so while the view starts, the
// GL calls that compile, link or wait on a link are timed too.
import type { ViewportStartup } from './types'

/** The GL calls that compile or link a shader program, or block until a link has finished. */
const COMPILE_CALLS = ['compileShader', 'linkProgram', 'getShaderParameter', 'getProgramParameter', 'getShaderInfoLog', 'getProgramInfoLog', 'getActiveUniform', 'getActiveAttrib', 'getUniformLocation', 'getAttribLocation'] as const

/** Times the compile calls on one context until `stop`. */
export class CompileClock {
  ms = 0
  programs = 0
  private undo: (() => void) | null = null

  start(gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    if (this.undo) return
    const ctx = gl as unknown as Record<string, unknown>
    const own = COMPILE_CALLS.filter((n) => typeof ctx[n] === 'function' && !Object.prototype.hasOwnProperty.call(ctx, n))
    for (const name of own) {
      const fn = ctx[name] as (...a: unknown[]) => unknown
      ctx[name] = (...args: unknown[]) => {
        const t0 = performance.now()
        try {
          return fn.apply(gl, args)
        } finally {
          this.ms += performance.now() - t0
          if (name === 'linkProgram') this.programs++
        }
      }
    }
    // The prototype's own methods come back once the instance's are gone.
    this.undo = () => {
      for (const name of own) delete ctx[name]
    }
  }

  stop(): void {
    this.undo?.()
    this.undo = null
  }
}

/** A fresh record, before anything is measured. */
export function emptyStartup(): ViewportStartup {
  return { rendererMs: 0, stageMs: 0, pipelineMs: 0, constructMs: 0, constructPrograms: 0, constructCompileMs: 0, waitMs: null, firstFrameMs: null, firstFramePrograms: null, firstFrameCompileMs: null, warmMs: null, warmPrograms: null, warmCompileMs: null }
}

/** Marks a span on the page's performance timeline (sx:view:<name>), where the profiler and the bridge can read it. */
export function markSpan(name: string, start: number, end = performance.now()): void {
  try {
    performance.measure(`sx:view:${name}`, { start, end })
  } catch {
    // An old engine without measure options: the numbers in stats() are still there.
  }
}
