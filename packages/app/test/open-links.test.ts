// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every page the app opens is one the desktop shell's capabilities allow, and a refused one shows a toast.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BUG_REPORTS_URL } from '@slicerx/contracts'
import { attribution, DESKTOP_CAPABILITIES, editionLinks, editionPages, NEUTRAL_EDITION, parseEditionConfig, SLICERX_BUG_REPORTS, SLICERX_SOURCE, sourceUrl, tauriConfig, type EditionConfig } from '@slicerx/edition-config'
import { loadEditionConfig } from '@slicerx/edition-config/node'
import { afterEach, describe, expect, it } from 'vitest'
import slicerxEdition from '../../../editions/slicerx/edition.config.ts'
import { bugReportsUrl } from '../src/bugs/where'
import { privacyUrl } from '../src/features/store/routes'
import { openLink, openSafely, registerLinkOpener } from '../src/lib/links'
import { OLLAMA_DOWNLOAD } from '../src/pilot-connect/local-ai'
import { BAMBU_CONNECT_DOWNLOAD } from '../src/send/bambu-connect'
import { get, set } from '../src/state/store'

const capabilities = join(__dirname, '../../../apps/desktop/src-tauri/capabilities')
const COMMIT = '508c58be1d0c7e5a6c2b4f3e9a8d7c6b5a4f3e2d'

type Capability = { identifier: string; permissions: (string | { identifier: string; allow?: { url: string }[] })[] }

function capabilityFile(identifier: string): Capability {
  const file = readdirSync(capabilities).find((f) => (JSON.parse(readFileSync(join(capabilities, f), 'utf8')) as Capability).identifier === identifier)
  if (!file) throw new Error(`no capability file named ${identifier}`)
  return JSON.parse(readFileSync(join(capabilities, file), 'utf8')) as Capability
}

/** The opener allow entries a desktop build of this edition has: the capabilities its Tauri overlay lists. */
function allowed(config: EditionConfig): string[] {
  const listed = (tauriConfig(config, 'desktop') as { app: { security: { capabilities: (string | Capability)[] } } }).app.security.capabilities
  return listed
    .map((c) => (typeof c === 'string' ? capabilityFile(c) : c))
    .flatMap((c) => c.permissions)
    .flatMap((p) => (typeof p === 'object' && p.identifier === 'opener:allow-open-url' ? (p.allow ?? []).map((a) => a.url) : []))
}

/** The glob crate's Pattern::matches with default options, which the opener plugin applies to the whole URL. */
function globMatches(pattern: string, url: string): boolean {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2)
      const body = pattern.slice(i + 1, end)
      re += body.startsWith('!') ? `[^${body.slice(1).replace(/[\\\]^-]/g, '\\$&')}]` : `[${body.replace(/[\\\]^-]/g, '\\$&')}]`
      i = end
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(url)
}

/** Every page the app can open for an edition, as the shell receives it (openLink parses each link first). */
function linksOf(config: EditionConfig): string[] {
  const source = sourceUrl(config, COMMIT) ?? SLICERX_SOURCE
  const releases = (config.release.updates?.endpoints ?? []).flatMap((feed) => {
    const repo = /^https:\/\/github\.com\/[^/]+\/[^/]+\//.exec(feed)?.[0]
    // apps/desktop/release/publish.sh: release_url is the tag's page, deb_url a file of the release
    return repo ? [`${repo}releases/tag/desktop-v0.2.3`, `${repo}releases/download/desktop-v0.2.3/SlicerX_0.2.3_amd64.deb`] : []
  })
  return [
    ...Object.values(editionLinks(config)),
    bugReportsUrl(config),
    source,
    privacyUrl(config, source),
    attribution(config).url,
    config.legal.terms,
    config.legal.privacy,
    config.apps.web.origin,
    ...releases,
    BAMBU_CONNECT_DOWNLOAD,
    OLLAMA_DOWNLOAD,
    // the printer error code pages (packages/connect/src/drivers/bambu/hms.rs)
    'https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/0300_4006',
  ]
    .filter((u): u is string => !!u)
    .map((u) => new URL(u).href)
}

const editions: [string, EditionConfig][] = [
  ['slicerx', slicerxEdition],
  ['reference', parseEditionConfig(NEUTRAL_EDITION)],
  ['acme', await loadEditionConfig({ file: join(__dirname, '../../edition-config/fixtures/acme/acme.json'), env: {} })],
]

describe('the pages the desktop app opens', () => {
  it.each(editions)('are all allowed by the %s build', (_name, config) => {
    const allow = allowed(config)
    const refused = linksOf(config).filter((u) => !allow.some((p) => globMatches(p, u)))
    expect(refused, 'a link the app opens has no allow entry: add it to editionPages (edition config) or capabilities/shared-links.json').toEqual([])
  })

  it('are allowed one link at a time, never a whole site', () => {
    for (const [, config] of editions) for (const p of allowed(config)) expect(p, p).not.toMatch(/^https:\/\/[^/]*\*|^https:\/\/[^/]+\/\*$/)
    expect(allowed(slicerxEdition).some((p) => globMatches(p, 'https://slicerx.app/anything'))).toBe(false)
    expect(allowed(slicerxEdition).some((p) => globMatches(p, 'https://github.com/someone/else/tree/main'))).toBe(false)
  })

  it('include the source of the exact build, the link from the 0.1.1 crash report', () => {
    expect(allowed(slicerxEdition).some((p) => globMatches(p, `https://github.com/slicerx-oss/slicerx/tree/${COMMIT}`))).toBe(true)
  })

  it('keep the shared capabilities every edition lists', () => {
    for (const id of DESKTOP_CAPABILITIES) expect(capabilityFile(id).identifier).toBe(id)
    expect(editionPages(slicerxEdition)).toContain('https://discord.com/channels/1555048815881355324/1556010155802628228')
    expect(SLICERX_BUG_REPORTS).toBe(DEFAULT_BUG_REPORTS_URL)
  })

  it('come from call sites this test knows', () => {
    // A new openLink, openExternal or target="_blank" link fails here until its page is in linksOf above.
    const known: Record<string, number> = {
      'shell/about.tsx': 4,
      'features/store/routes.ts': 2,
      'features/fleet/device-dialog.tsx': 1,
      'features/store/creator-sheet.tsx': 2,
      'features/store/account.tsx': 2,
      'bugs/report-dialog.tsx': 1,
      'state/actions.ts': 1,
      'updates/dialog.tsx': 5,
      'lib/links.ts': 3,
      'first-run/printer-step.tsx': 1,
      'first-run/slicer-step.tsx': 1,
      'first-run/agreement.tsx': 2,
      'commands/builtin.ts': 1,
      'pilot-connect/local-ai-card.tsx': 1,
    }
    const src = join(__dirname, '../src')
    const found: Record<string, number> = {}
    for (const f of readdirSync(src, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(f)) continue
      const n = (readFileSync(join(src, f), 'utf8').match(/\bopenLink\(|\bopenExternal\(|target="_blank"/g) ?? []).length
      if (n) found[f.split('\\').join('/')] = n
    }
    expect(found).toEqual(known)
  })
})

describe('opening a page the shell refuses', () => {
  afterEach(() => set({ toast: null }))

  it('shows the link to copy instead of an unhandled rejection', async () => {
    await openSafely('https://example.com/page', () => Promise.reject(new Error('Not allowed to open url https://example.com/page')))
    expect(get().toast).toMatchObject({ tone: 'warn', action: { label: 'Copy link' } })
    expect(get().toast?.text).toContain('https://example.com/page')
  })

  it('routes links in the page through the opener, and survives a refusal', async () => {
    const opened: string[] = []
    registerLinkOpener(async (url) => {
      opened.push(url)
      throw new Error(`Not allowed to open url ${url}`)
    })
    const a = document.createElement('a')
    a.href = `https://github.com/slicerx-oss/slicerx/tree/${COMMIT}`
    a.target = '_blank'
    document.body.append(a)
    a.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(opened).toEqual([a.href])
    expect(get().toast?.text).toContain(a.href)
    a.remove()

    await openLink('https://slicerx.app')
    expect(opened.at(-1)).toBe('https://slicerx.app/')
  })
})
