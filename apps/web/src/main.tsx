// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// First: Zod must be jitless before any module makes a schema (packages/app/src/zod-jitless.ts).
import '@slicerx/app/zod-jitless'
import type { AppFeature, EditionHost } from '@slicerx/contracts'
import { setCurrentEdition, SlicerXApp } from '@slicerx/app'
import { editionFromBuild } from '@slicerx/edition-config'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createWebHost } from './host'

declare const __SX_FEATURE_STORE__: boolean
declare const __SX_FEATURE_PILOT__: boolean
declare const __SX_FEATURE_CONNECT__: boolean
declare const __SX_FEATURE_CLOUD__: boolean
declare const __SX_TEST_HUB_PORT__: string
declare const __SX_E2E__: boolean

// The edition names the app from the first frame: the window title, menus and setup read it before the app renders.
setCurrentEdition(editionFromBuild())

async function features(): Promise<AppFeature[]> {
  const out: AppFeature[] = []
  if (__SX_FEATURE_STORE__) out.push((await import('../../../packages/app/src/features/store/index')).storeFeature)
  if (__SX_FEATURE_CONNECT__) out.push((await import('@slicerx/app/features/fleet')).fleetFeature)
  if (__SX_FEATURE_PILOT__) out.push((await import('@slicerx/app/features/pilot')).pilotFeature)
  if (__SX_FEATURE_CLOUD__) out.push((await import('../../../packages/app/src/features/cloud/index')).cloudFeature)
  return out
}

// Printer makers get their official mark where one is vendored, else a neutral lettermark tile. The tile comes from
// its own subpath: importing the package index keeps every export of @slicerx/ui in the startup chunk.
if (__SX_FEATURE_CONNECT__) {
  const [{ MakerTile, makerSlugFor }, { OfficialMark, hasOfficialMark }, { setVendorMarks }] = await Promise.all([
    import('@slicerx/ui/maker-tile'),
    import('@slicerx/brand-icons'),
    import('@slicerx/app'),
  ])
  setVendorMarks((vendor, size, on) => {
    const maker = makerSlugFor(vendor)
    if (!maker) return null
    return hasOfficialMark(maker) ? <OfficialMark slug={maker} size={size} on={on} title={vendor} /> : <MakerTile maker={maker} size={size} />
  })
}

// The browser build connects to sx-link when the person asks (Settings > Printer bridge).
if (__SX_FEATURE_CONNECT__) {
  const [{ setBridgeConnector, testHubUrl }, { browserBridge, shellBridge }] = await Promise.all([import('@slicerx/app'), import('./host/link')])
  // An end-to-end test build pairs with the hub port its page names (a bridge spec's own hub, e2e/bridge-hub.ts), else
  // its run's (SX_TEST_HUB_PORT); the dev server with SX_TEST_HUB_PORT when it was started with one; a release build
  // with sx-link's. __SX_E2E__ folds the page's port away elsewhere.
  const pagePort = __SX_E2E__ ? (window as { __sxTestHubPort?: unknown }).__sxTestHubPort : undefined
  // An end-to-end page can stand in for the desktop shell's bridge whose start fails with the shell's words, as a Tauri
  // command rejects: with a string. It counts the starts (e2e/bridge-port.spec.ts).
  const page = window as { __sxTestShellStartError?: unknown; __sxTestShellStarts?: number }
  const shellFails = __SX_E2E__ ? page.__sxTestShellStartError : undefined
  const failedStart = (): Promise<never> => {
    page.__sxTestShellStarts = (page.__sxTestShellStarts ?? 0) + 1
    return Promise.reject(shellFails)
  }
  const relay = editionFromBuild().backend.relay
  setBridgeConnector(typeof shellFails === 'string' ? shellBridge(failedStart, relay) : browserBridge(testHubUrl(pagePort ?? __SX_TEST_HUB_PORT__), relay))
  // Phone access keeps its identity and pairings sealed in this browser (features/phone/sealed.ts).
  const { setPairStorage, sealedPairStores, browserDocStore } = await import('@slicerx/app')
  setPairStorage({ ...sealedPairStores(browserDocStore()), name: 'SlicerX in the browser', kind: 'web' })
}

// The AI clients' marks identify them in "Connect your AI agent"; unaltered, never implying endorsement.
// From its own subpath, so the agent list loads with the brand marks and stays out of the startup shell.
if (__SX_FEATURE_PILOT__) {
  const [{ registerAgentMarks }, { BrandLogo }] = await Promise.all([import('@slicerx/app/pilot-connect/agents'), import('@slicerx/brand-icons')])
  registerAgentMarks((mark, size, title) => <BrandLogo slug={mark} size={size} title={title} />)
}

// The end-to-end build answers update checks from a feed the spec puts on the page, so the launch sheet (and a required
// update) can be tested in the browser. A real build has no updater here: __SX_E2E__ folds this away.
if (__SX_E2E__) {
  const feed = (window as { __sxUpdateFeed?: import('../../../packages/app/src/updates/updates').FoundUpdate }).__sxUpdateFeed
  if (feed) {
    const [{ registerUpdater }, { launchCheck }] = await Promise.all([import('@slicerx/app'), import('../../../packages/app/src/updates/updates')])
    const done = async () => undefined
    registerUpdater({ mode: 'install', check: async () => feed, download: done, restart: done, quit: async () => void ((window as { __sxQuit?: boolean }).__sxQuit = true) })
    await launchCheck()
  }
}

// The end-to-end build exposes the browser's mimir cloud host, to point at a proxy the spec stubs
// (apps/web/e2e/mimir-web-cloud.spec.ts) with a stand-in session token, or none for signed out.
if (__SX_E2E__ && __SX_FEATURE_PILOT__) {
  const { createBrowserMimirCloud } = await import('@slicerx/app/pilot-connect/browser-cloud')
  Object.assign(window, { __sxBrowserMimirCloud: (base: string, token: string | null) => createBrowserMimirCloud({ base, session: () => token }) })
}

const el = document.getElementById('root')
if (!el) throw new Error('index.html is missing #root')
const config = editionFromBuild()
const [host, list] = await Promise.all([createWebHost(), features()])
if (__SX_FEATURE_STORE__) {
  // Edition members: the store client and sign-in plumbing, loaded on first use.
  const { lazyStore } = await import('./host/store')
  const edition: EditionHost = host
  edition.store = lazyStore(config)
  const store = edition.store
  // The hub signs in to the relay with a relay token minted from the account's session (never the session itself):
  // a new one on sign-in and refresh, null on sign-out, never stored.
  if (__SX_FEATURE_CONNECT__) {
    const { configureRelayTokens, pushAccountToken } = await import('@slicerx/app')
    const sb = config.features.demoData ? null : config.backend.supabase
    // Relay tokens come from the backend's relay-token function, which exists only alongside a relay.
    configureRelayTokens(sb && config.backend.relay ? { url: sb.url, anonKey: sb.anonKey } : null)
    store.onTokenChange((t) => pushAccountToken(t))
    void store.getAccessToken().then((t) => pushAccountToken(t), () => pushAccountToken(null))
  }
  // mimir cloud, for signed-in members only: the host sends the member's session token to the edition's proxy, which
  // checks it and caps the web edition per user. No key ships in the bundle. A new host goes in on each sign-in and
  // sign-out, so the app shows the cloud as ready or as a sign-in step.
  const mimirUrl = config.ai.keySource === 'cloud' ? config.backend.supabase?.url : undefined
  if (__SX_FEATURE_PILOT__ && mimirUrl) {
    const [{ registerMimirCloud }, { createBrowserMimirCloud }] = await Promise.all([import('@slicerx/app'), import('@slicerx/app/pilot-connect/browser-cloud')])
    const base = `${new URL(mimirUrl).origin}/functions/v1/mimir`
    let token: string | null = null
    registerMimirCloud(createBrowserMimirCloud({ base, session: () => token }))
    const seen = (t: string | null) => {
      const flipped = (t === null) !== (token === null)
      token = t
      if (flipped) registerMimirCloud(createBrowserMimirCloud({ base, session: () => token }))
    }
    store.onTokenChange(seen)
    void store.getAccessToken().then(seen, () => seen(null))
  }
  // Saved .sx3mf files name the person who exported them; empty when signed out.
  const { setExportIdentity } = await import('@slicerx/app')
  setExportIdentity(async () => (await store.session())?.userId ?? null)
  const cloudApi = config.backend.cloudApi
  if (__SX_FEATURE_CLOUD__ && cloudApi) {
    // Cloud slicing signs requests with the member's session token, kept current by the store.
    const [{ createCloudClient, createCloudSlicer }, { cloudSlicing }] = await Promise.all([import('@slicerx/cloud'), import('../../../packages/app/src/features/cloud/index')])
    let token: string | null = null
    store.onTokenChange((t) => {
      token = t
    })
    void store.getAccessToken().then((t) => {
      token = t
    })
    const local = host.slicer
    const cloud = createCloudSlicer({ client: createCloudClient({ baseUrl: cloudApi, credential: () => token }), local })
    edition.cloud = cloud
    // Meshes load locally either way, so handles match; only slices and their outputs move.
    const clouded = new Set<string>()
    host.slicer = {
      ...local,
      slice: async (req, opts) => {
        if (!cloudSlicing()) return local.slice(req, opts)
        const r = await cloud.slice({ ...req, config: (await import('@slicerx/settings')).resolveAuto(req.config) }, opts)
        clouded.add(r.id)
        return r
      },
      getPreview: (id) => (clouded.has(id) ? cloud.getPreview(id) : local.getPreview(id)),
      exportGcode: (id, target) => (clouded.has(id) ? cloud.exportGcode(id, target) : local.exportGcode(id, target)),
    }
  }
  edition.auth = {
    redirectUrl: () => `${location.origin}${location.pathname}`,
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener')
    },
    onDeepLink: () => () => undefined,
  }
  // Magic links and OAuth return to /auth/callback; finish the sign-in, then drop the tokens from the address bar.
  if (location.pathname.endsWith('/auth/callback')) {
    void edition.store.completeSignIn(location.href).finally(() => history.replaceState(null, '', location.pathname.replace(/auth\/callback$/, '')))
  }
}
createRoot(el).render(
  <StrictMode>
    <SlicerXApp host={host} features={list} edition={config} />
  </StrictMode>,
)
