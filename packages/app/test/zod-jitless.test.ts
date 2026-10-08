// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Zod never tries `new Function` once zod-jitless.ts has run: the desktop app's content security policy refuses it and
// the web view reports the refusal at startup. Each case runs in a fresh Node process, so Zod's one-time check is not
// already cached by another test.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const app = join(import.meta.dirname, '..')

/** How many times `new Function` ran while a module making object schemas loaded and parsed, with or without jitless first. */
function probes(jitless: boolean): number {
  const script = `
    const Real = globalThis.Function
    let calls = 0
    globalThis.Function = new Proxy(Real, { construct(t, a) { calls++; return Reflect.construct(t, a) }, apply(t, self, a) { calls++; return Reflect.apply(t, self, a) } })
    ${jitless ? `await import(${JSON.stringify(pathToFileURL(join(app, 'src', 'zod-jitless.ts')).href)})` : ''}
    const { z } = await import('zod')
    z.object({ name: z.string(), size: z.object({ x: z.number() }) }).parse({ name: 'cube', size: { x: 20 } })
    if (${jitless} && z.config().jitless !== true) throw new Error('Zod does not see jitless')
    process.stdout.write(String(calls))
  `
  return Number(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: app, encoding: 'utf8' }))
}

describe('zod jitless', () => {
  it('Zod probes new Function by default, so the check below can see it', () => {
    expect(probes(false)).toBeGreaterThan(0)
  })

  it('never probes new Function after zod-jitless runs', () => {
    expect(probes(true)).toBe(0)
  })
})
