// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { AppFeature, EditionHost } from '@slicerx/contracts'
import { SlicerXApp } from '@slicerx/app'
import { editionFromBuild } from '@slicerx/edition-config'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createWebHost } from './host'

declare const __SX_FEATURE_STORE__: boolean
declare const __SX_FEATURE_PILOT__: boolean
declare const __SX_FEATURE_CONNECT__: boolean
declare const __SX_FEATURE_CLOUD__: boolean

async function features(): Promise<AppFeature[]> {
  const out: AppFeature[] = []
  if (__SX_FEATURE_STORE__) out.push((await import('../../../packages/app/src/features/store/index')).storeFeature)
  if (__SX_FEATURE_CONNECT__) out.push((await import('@slicerx/app/features/fleet')).fleetFeature)
  if (__SX_FEATURE_PILOT__) out.push((await import('@slicerx/app/features/pilot')).pilotFeature)
  if (__SX_FEATURE_CLOUD__) out.push((await import('../../../packages/app/src/features/cloud/index')).cloudFeature)
  return out
}

// Printer makers get their official mark where one is vendored, else a neutral lettermark tile.
if (__SX_FEATURE_CONNECT__) {
  const [{ MakerTile, makerSlugFor }, { OfficialMark, hasOfficialMark }, { setVendorMarks }] = await Promise.all([
    import('@slicerx/ui'),
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
  const [{ setBridgeConnector }, { browserBridge }] = await Promise.all([import('@slicerx/app'), import('./host/link')])
  setBridgeConnector(browserBridge(undefined, editionFromBuild().backend.relay))
  // Phone access keeps its identity and pairings sealed in this browser (features/phone/sealed.ts).
  const { setPairStorage, sealedPairStores, browserDocStore } = await import('@slicerx/app')
  setPairStorage({ ...sealedPairStores(browserDocStore()), name: 'SlicerX in the browser', kind: 'web' })
}

// The AI clients' marks identify them in "Connect your AI agent"; unaltered, never implying endorsement.
if (__SX_FEATURE_PILOT__) {
  const [{ registerAgentMarks }, { BrandLogo }] = await Promise.all([import('@slicerx/app'), import('@slicerx/brand-icons')])
  registerAgentMarks((mark, size, title) => <BrandLogo slug={mark} size={size} title={title} />)
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
    configureRelayTokens(sb ? { url: sb.url, anonKey: sb.anonKey } : null)
    store.onTokenChange((t) => pushAccountToken(t))
    void store.getAccessToken().then((t) => pushAccountToken(t), () => pushAccountToken(null))
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
