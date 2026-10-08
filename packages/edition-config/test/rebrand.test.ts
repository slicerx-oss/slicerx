// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A white-label edition carries none of SlicerX's name, publisher, link scheme or icons.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { attribution, checkEditionConfig, DESKTOP_WINDOW, desktopFileTypes, editionLinks, logoImage, mcpServerId, mergeLayers, POWERED_BY, SLICERX_LINKS, tauriConfig, type EditionConfig } from '../src/index.ts'
import { inlineLogo, loadEditionConfig } from '../src/node.ts'
import slicerxEdition from '../../../editions/slicerx/edition.config.ts'

const acmeFile = fileURLToPath(new URL('../fixtures/acme/acme.json', import.meta.url))
const acmeJson = JSON.parse(readFileSync(acmeFile, 'utf8')) as Record<string, unknown>
const conf = JSON.parse(readFileSync(new URL('../../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as Record<string, unknown>
const loadAcme = () => loadEditionConfig({ file: acmeFile, env: {} })
const issues = (input: unknown) => {
  const r = checkEditionConfig(input)
  return r.ok ? '' : r.issues.map((i) => `${i.path}: ${i.message}`).join('\n')
}

/** RFC 7396, the way `tauri build --config` merges the overlay: objects merge, everything else is replaced. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out: Record<string, unknown> = target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {}
  for (const [k, v] of Object.entries(patch)) out[k] = v === null ? undefined : mergePatch(out[k], v)
  return out
}

describe('a white-label edition', () => {
  it('builds a desktop app with nothing of SlicerX in its Tauri config', async () => {
    const acme = await loadAcme()
    const overlay = tauriConfig(acme, 'desktop')
    // The overlay is what the desktop shell's own tests read (apps/desktop/src-tauri/src/brand.rs).
    const pinned = new URL('../fixtures/acme/tauri.desktop.json', import.meta.url)
    const text = JSON.stringify(overlay, null, 2) + '\n'
    if (process.env['SX_WRITE_FIXTURES']) writeFileSync(pinned, text)
    expect(readFileSync(pinned, 'utf8')).toBe(text)

    const merged = mergePatch(conf, overlay) as { productName: string; app: { windows: { title: string }[] }; bundle: Record<string, unknown>; plugins: Record<string, { desktop: { schemes: string[] } }> }
    expect(merged.productName).toBe('Acme Slicer')
    expect(merged.app.windows.map((w) => w.title)).toEqual(['Acme Slicer'])
    expect(merged.bundle['publisher']).toBe('Acme Printers Inc.')
    expect(merged.bundle['copyright']).toBe('Copyright (C) 2026 Acme Printers Inc.')
    expect(merged.bundle['shortDescription']).toBe('The slicer for Acme printers')
    expect(merged.bundle['icon']).toEqual(['gen/icons/32x32.png', 'gen/icons/128x128.png', 'gen/icons/128x128@2x.png', 'gen/icons/icon.icns', 'gen/icons/icon.ico'])
    expect(merged.plugins['deep-link']?.desktop.schemes).toEqual(['acmeslicer'])
    // The shell may open the edition's own help pages.
    expect(merged).toHaveProperty(['app', 'security', 'capabilities', 1, 'permissions', 0, 'allow'], [{ url: 'https://slicer.acme.example/*' }])
    // Not one value in the merged config names SlicerX, its publisher, its scheme or its icons.
    const all = JSON.stringify(merged)
    expect(all).not.toMatch(/slicer\s*x/i)
    expect(all).not.toContain('Sean Leonard')
    expect(all).not.toMatch(/"icons\//)
  })

  it('keeps the SlicerX overlay in step with tauri.conf.json', () => {
    const overlay = tauriConfig(slicerxEdition, 'desktop') as { app: { windows: unknown[] }; bundle: Record<string, unknown> }
    const base = conf as { app: { windows: Record<string, unknown>[] }; bundle: Record<string, unknown> }
    expect(overlay.app.windows).toEqual(base.app.windows)
    expect({ ...base.app.windows[0], title: undefined }).toEqual({ ...DESKTOP_WINDOW, title: undefined })
    // the release build merges this window over tauri.conf.json's whole, so the macOS title bar keys must ship in it
    expect(overlay.app.windows[0]).toMatchObject({ titleBarStyle: 'Overlay', hiddenTitle: true, trafficLightPosition: { x: 18, y: 20 } })
    for (const k of ['publisher', 'copyright', 'shortDescription', 'fileAssociations']) expect(overlay.bundle[k]).toEqual(base.bundle[k])
    expect(overlay.bundle).not.toHaveProperty('icon')
    expect(overlay.app).not.toHaveProperty('security.capabilities')
  })

  it('names file types after the edition and keeps the format extensions', async () => {
    const types = desktopFileTypes(await loadAcme())
    expect(types.find((t) => t.ext.includes('sx3mf'))?.name).toBe('Acme Slicer 3MF file')
    expect(types.find((t) => t.ext.includes('sxlock'))?.name).toBe('Locked Acme Slicer project')
  })

  it('links its own pages, shows the Made possible by SlicerX credit, and lists its own MCP server', async () => {
    const acme = await loadAcme()
    expect(editionLinks(acme)).toEqual({ docs: 'https://slicer.acme.example/docs', support: 'https://slicer.acme.example/help', download: 'https://slicer.acme.example/download' })
    const bare = { ...acme, links: {} } as EditionConfig
    expect(editionLinks(bare)).toEqual(SLICERX_LINKS)
    expect(attribution(acme)).toEqual(POWERED_BY)
    expect(POWERED_BY).toEqual({ text: 'Made possible by SlicerX', url: 'https://slicerx.app/support' })
    expect(mcpServerId(acme)).toBe('acmeslicer')
    expect(mcpServerId(slicerxEdition)).toBe('slicerx')
  })

  it('inlines its logo files for the build', async () => {
    const acme = inlineLogo(await loadAcme(), acmeFile)
    expect(logoImage(acme, 'mark')).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(logoImage(acme, 'wordmark')).toBeNull()
    expect(logoImage(slicerxEdition, 'mark')).toBeNull()
  })

  it('must link its own source, use its own icon and its own link scheme', () => {
    const without = (edit: (c: { legal: Record<string, unknown>; brand: { logo: Record<string, unknown> } }) => void) => {
      const c = structuredClone(acmeJson) as Parameters<typeof edit>[0]
      edit(c)
      return issues(c)
    }
    expect(issues(acmeJson)).toBe('')
    expect(without((c) => delete c.legal['sourceUrl'])).toMatch(/legal\.sourceUrl/)
    expect(without((c) => delete c.brand.logo['appIcon'])).toMatch(/brand\.logo\.appIcon/)
    expect(issues(mergeLayers(acmeJson, { apps: { deepLinkScheme: 'slicerx' } }))).toMatch(/link scheme/)
    expect(issues(mergeLayers(acmeJson, { apps: { desktop: { productName: 'SlicerX Acme' } } }))).toMatch(/trademark/)
    expect(issues(mergeLayers(acmeJson, { legal: { attribution: { text: 'Made possible by SlicerX', url: 'https://slicerx.app/support' } } }))).toBe('')
    expect(issues(mergeLayers(acmeJson, { legal: { attribution: { text: 'Acme Slice', url: 'https://acme.example' } } }))).toMatch(/credit/)
  })
})
