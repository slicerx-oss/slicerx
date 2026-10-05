// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A white-label edition (the Acme Slicer fixture) renders its own name everywhere. The only SlicerX
// left is the Made possible by SlicerX credit; the .sx3mf and .sxlock formats keep their names.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Host } from '@slicerx/contracts'
import { parseEditionConfig, POWERED_BY, type EditionConfig } from '@slicerx/edition-config'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { SlicerXApp } from '../src/app'
import { bugReportsOff, bugReportsUrl } from '../src/bugs/where'
import { builtinCommands } from '../src/commands/builtin'
import { menuModel } from '../src/commands/menu'
import { appName, currentEdition, setCurrentEdition } from '../src/edition'
import { TOPICS } from '../src/first-run/help-topics'
import { helpLinks } from '../src/lib/links'
import { TIPS } from '../src/lib/tips'
import { AGENTS, serverApp } from '../src/pilot-connect/agents'
import { set } from '../src/state/store'

const acme: EditionConfig = parseEditionConfig(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../edition-config/fixtures/acme/acme.json'), 'utf8')))

/** A host that answers every call with nothing (an unsubscribe for listeners): enough to draw the screens. */
function stubHost(): Host {
  const nothing = () => undefined
  const quiet: ProxyHandler<object> = { get: (_, k) => (k === 'then' ? undefined : () => nothing) }
  return {
    kind: 'desktop',
    capabilities: { nativeSlicing: true, orcaEngine: false, printers: 'none', webgpu: false, threads: 4, secureStorage: true },
    build: { version: '1.0.0', commit: '0123456789abcdef', sourceUrl: 'https://git.acme.example/slicer/tree/0123456789abcdef' },
    // No engine: the demo plate stays empty.
    slicer: new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : () => Promise.reject(new Error('no engine in this test'))) }),
    files: new Proxy({}, quiet),
    secrets: new Proxy({}, quiet),
  } as unknown as Host
}

/** Every string a person can see or hear: text, labels, titles, placeholders and tooltips. */
function seen(root: Element): string {
  const attrs = ['aria-label', 'title', 'placeholder', 'alt', 'data-tip-title', 'data-tip-body']
  return [root.textContent ?? '', ...[...root.querySelectorAll('*')].flatMap((e) => attrs.map((a) => e.getAttribute(a) ?? ''))].join('\n')
}

/** What may still say SlicerX: the credit only. */
const leftover = (text: string) => text.replaceAll(POWERED_BY.text, '').match(/[^\n]{0,60}SlicerX[^\n]{0,60}/g) ?? []

// jsdom has no media queries, scrolling or resize observers; the screens use all three.
Element.prototype.scrollTo ??= () => undefined
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false
}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
if (!window.matchMedia) window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia

const roots: { unmount(): void }[] = []
const before = currentEdition()
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount()
  document.body.innerHTML = ''
  setCurrentEdition(before)
  set({ setup: null, aboutOpen: false, agreementOpen: false, settingsOpen: false })
})

async function renderApp(): Promise<Element> {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  flushSync(() => root.render(createElement(SlicerXApp, { host: stubHost(), edition: acme })))
  // Lazy screens (About, first run, settings) load on the next ticks.
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 10))
  return document.body
}

describe('a white-label edition', () => {
  it('names itself on the main screens and shows only the Made possible by SlicerX credit', async () => {
    const screens: Record<string, string> = {}
    for (const [name, state] of [
      ['first run, look', { setup: { step: 'look' as const } }],
      ['first run, printer', { setup: { step: 'printer' as const } }],
      ['workspace', { setup: null }],
      ['about', { setup: null, aboutOpen: true }],
      ['settings', { setup: null, settingsOpen: true }],
      ['agreement', { setup: null, agreementOpen: true }],
    ] as const) {
      set(state)
      screens[name] = seen(await renderApp())
      for (const r of roots.splice(0)) r.unmount()
      document.body.innerHTML = ''
      set({ setup: null, aboutOpen: false, agreementOpen: false, settingsOpen: false })
    }
    for (const [name, text] of Object.entries(screens)) {
      expect(text.length, name).toBeGreaterThan(50)
      expect(leftover(text), name).toEqual([])
    }
    expect(screens['first run, look']).toContain('Acme Slicer')
    expect(screens['about']).toContain('About Acme Slicer')
    expect(screens['about']).toContain(POWERED_BY.text)
  })

  it('names itself in commands, menus, help and tips', () => {
    setCurrentEdition(acme)
    const host = stubHost()
    const strings = [
      ...builtinCommands(host, []).map((c) => c.title),
      JSON.stringify((['macos', 'windows', 'linux'] as const).map((platform) => menuModel(builtinCommands(host, []), { platform }))),
      ...Object.values(TOPICS).flatMap((t) => [t.title, t.body]),
      ...Object.values(TIPS).flatMap((t) => [t.title, t.body]),
      ...AGENTS.map((a) => a.what),
    ].join('\n')
    expect(appName()).toBe('Acme Slicer')
    expect(leftover(strings)).toEqual([])
    expect(strings).toContain('About Acme Slicer')
    expect(strings).toContain('Quit Acme Slicer')
    expect(serverApp()).toEqual({ id: 'acmeslicer', name: 'Acme Slicer', author: { name: 'Acme Printers Inc.', url: 'https://slicer.acme.example' } })
    expect(helpLinks().docs).toBe('https://slicer.acme.example/docs')
  })

  it('has bug reports off without a link or a backend of its own', () => {
    setCurrentEdition(acme)
    expect(bugReportsUrl(acme)).toBeNull()
    expect(bugReportsOff(acme)).toBe(true)
    expect(builtinCommands(stubHost(), []).some((c) => c.id === 'help-report')).toBe(false)
    const menus = JSON.stringify(menuModel([], { platform: 'windows', startup: new Map([['help-report', '']]), omit: new Set(['help-report']) }))
    expect(menus).not.toContain('help-report')
    // With its own link it gets that link, never SlicerX's channel.
    const own = { ...acme, release: { ...acme.release, bugReportsUrl: 'https://forum.acme.example/bugs' } }
    expect(bugReportsUrl(own)).toBe('https://forum.acme.example/bugs')
    expect(bugReportsOff(own)).toBe(false)
  })
})
