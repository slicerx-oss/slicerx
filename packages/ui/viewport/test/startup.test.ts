// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { CompileClock, emptyStartup, warmupWaits } from '../src/startup'

/** A stand-in for a GL context: its methods live on the prototype, as a real context's do. */
class FakeGl {
  calls: string[] = []
  linkProgram(p: string): void {
    this.calls.push(`link ${p}`)
    const until = performance.now() + 3
    while (performance.now() < until) {
      // A link that takes a moment.
    }
  }
  getProgramParameter(): boolean {
    this.calls.push('param')
    return true
  }
  drawArrays(): void {
    this.calls.push('draw')
  }
}

describe('CompileClock', () => {
  it('times the compile and link calls and counts the programs, until stopped', () => {
    const gl = new FakeGl()
    const clock = new CompileClock()
    clock.start(gl as unknown as WebGL2RenderingContext)
    gl.linkProgram('a')
    gl.getProgramParameter()
    gl.drawArrays()
    gl.linkProgram('b')
    expect(clock.programs).toBe(2)
    expect(clock.ms).toBeGreaterThanOrEqual(5)
    // The calls still reach the context, with their own `this`.
    expect(gl.calls).toEqual(['link a', 'param', 'draw', 'link b'])
    clock.stop()
    expect(Object.prototype.hasOwnProperty.call(gl, 'linkProgram')).toBe(false)
    gl.linkProgram('c')
    expect(clock.programs).toBe(2)
  })

  it('wraps a context once however often it starts', () => {
    const gl = new FakeGl()
    const clock = new CompileClock()
    clock.start(gl as unknown as WebGL2RenderingContext)
    clock.start(gl as unknown as WebGL2RenderingContext)
    gl.linkProgram('a')
    expect(clock.programs).toBe(1)
  })

  it('starts with nothing measured', () => {
    expect(emptyStartup()).toMatchObject({ rendererMs: 0, waitMs: null, firstFrameMs: null, warmMs: null })
  })
})

describe('warmupWaits', () => {
  const idle = { held: false, plateUndrawn: false, opening: false, refiningParts: 0 }

  it('lets the bead warm-up start when nothing waits', () => {
    expect(warmupWaits(idle)).toBe(false)
  })

  it('holds it while a file opens or a plate set is not drawn yet', () => {
    expect(warmupWaits({ ...idle, held: true })).toBe(true)
    expect(warmupWaits({ ...idle, opening: true })).toBe(true)
    expect(warmupWaits({ ...idle, plateUndrawn: true })).toBe(true)
  })

  it('holds it while big parts still wait for their final geometry', () => {
    // its compiles held up the swap from the stand-ins by a second on software GL
    expect(warmupWaits({ ...idle, refiningParts: 3 })).toBe(true)
  })
})
