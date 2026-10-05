// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// Motion: follow the system's reduce motion setting, or always on, or always reduced, on the root as data-motion.
import { afterEach, describe, expect, it, vi } from 'vitest'

// a system reduce motion setting the test can flip, with its change event
function system(reduce: boolean) {
  const cbs = new Set<() => void>()
  const mq = { matches: reduce, media: '(prefers-reduced-motion: reduce)', addEventListener: (_: string, cb: () => void) => cbs.add(cb), removeEventListener: (_: string, cb: () => void) => cbs.delete(cb) }
  vi.stubGlobal('matchMedia', () => mq)
  return { flip: (v: boolean) => ((mq.matches = v), cbs.forEach((cb) => cb())) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  delete document.documentElement.dataset['motion']
})

describe('motion', () => {
  it('resolves each choice against the system', async () => {
    const { resolveMotion } = await import('../src/motion')
    expect(resolveMotion('system', true)).toBe('reduced')
    expect(resolveMotion('system', false)).toBe('full')
    expect(resolveMotion('full', true)).toBe('full')
    expect(resolveMotion('reduced', false)).toBe('reduced')
  })

  it('follows the system from load, and the root says so', async () => {
    const sys = system(true)
    const m = await import('../src/motion')
    expect(document.documentElement.dataset['motion']).toBe('reduced')
    expect(m.motionReduced()).toBe(true)
    sys.flip(false)
    expect(document.documentElement.dataset['motion']).toBe('full')
    expect(m.motionReduced()).toBe(false)
  })

  it('On overrides a system that reduces motion, and Reduced forces it', async () => {
    const sys = system(true)
    const m = await import('../src/motion')
    const { prefersReducedMotion } = await import('../src/tokens')
    m.setMotionPreference('full')
    expect(document.documentElement.dataset['motion']).toBe('full')
    expect(m.motionReduced()).toBe(false)
    expect(prefersReducedMotion()).toBe(false)
    // a system change does not touch a fixed choice
    sys.flip(true)
    expect(document.documentElement.dataset['motion']).toBe('full')
    sys.flip(false)
    m.setMotionPreference('reduced')
    expect(document.documentElement.dataset['motion']).toBe('reduced')
    expect(prefersReducedMotion()).toBe(true)
  })

  it('keys every reduced motion rule in the kit stylesheet on the root, none on the media query', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8')
    expect(css).not.toMatch(/@media \(prefers-reduced-motion/)
    expect(css).toMatch(/:root\[data-motion="reduced"\] \*,/)
  })
})
