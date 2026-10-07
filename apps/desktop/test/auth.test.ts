// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { defineEditionConfig } from '@slicerx/edition-config'
import { createDesktopAuth, type ShellBridge } from '../src/host/auth'
import { lazyStore } from '../../web/src/host/store'

const harbor = JSON.parse(readFileSync(new URL('../../../packages/edition-config/fixtures/fork-harbor.json', import.meta.url), 'utf8')) as unknown
const edition = defineEditionConfig({ features: { demoData: false } }, { extends: harbor as never })

/** A shell that holds sign-in links like the real one: taken once, announced by an event. */
function fakeShell() {
  const waiting: string[] = []
  const listeners = new Set<() => void>()
  const calls: [string, unknown][] = []
  const bridge: ShellBridge = {
    invoke: (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args])
      return cmd === 'auth_callback_take' ? waiting.splice(0) : undefined
    }) as ShellBridge['invoke'],
    listen: async (_event, cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  return {
    bridge: async () => bridge,
    calls,
    arrive(url: string) {
      waiting.push(url)
      listeners.forEach((cb) => cb())
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('desktop sign-in', () => {
  it("sends the edition's deep link as the return address, not the page's own origin", async () => {
    let seen: { redirect?: string | undefined; open?: boolean } = {}
    const auth = createDesktopAuth(edition, fakeShell().bridge)
    const store = lazyStore(edition, auth, async () => ({
      createStore: ((opts: { auth?: { redirectUrl: () => string; openExternal?: unknown } }) => {
        seen = { redirect: opts.auth?.redirectUrl(), open: typeof opts.auth?.openExternal === 'function' }
        return { signInMethods: () => ['email'] }
      }) as never,
    }))
    await store.signInMethods()
    expect(seen.redirect).toBe(`${edition.apps.deepLinkScheme}://auth/callback`)
    expect(seen.open).toBe(true)
  })

  it('hands over a link that opened the app, then each one that arrives later, once each', async () => {
    const shell = fakeShell()
    shell.arrive('harborslice://auth/callback?code=first')
    const got: string[] = []
    const off = createDesktopAuth(edition, shell.bridge).onDeepLink((u) => got.push(u))
    await settle()
    shell.arrive('harborslice://auth/callback?code=second')
    await settle()
    expect(got).toEqual(['harborslice://auth/callback?code=first', 'harborslice://auth/callback?code=second'])
    off()
    shell.arrive('harborslice://auth/callback?code=third')
    await settle()
    expect(got).toHaveLength(2)
  })

  it('opens sign-in pages in the system browser', async () => {
    const shell = fakeShell()
    await createDesktopAuth(edition, shell.bridge).openExternal('https://example.com/login')
    expect(shell.calls).toContainEqual(['open_external', { url: 'https://example.com/login' }])
  })

  it('finishes the sign-in from the deep link and registers the command with the shell', () => {
    const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
    expect(main).toMatch(/lazyStore\(config, auth\)/)
    expect(main).toMatch(/onDeepLink\(\(url\) =>[\s\S]*completeSignIn\(url\)/)
    expect(readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')).toContain('opened::auth_callback_take')
  })
})
