// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { AppFeature, EditionHost } from '@slicerx/contracts'
import { editionLogo, registerCrashHost, SlicerXApp } from '@slicerx/app'
import { editionFromBuild } from '@slicerx/edition-config'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createDesktopHost } from './host'
import { createTauriCrash } from './host/crash'
import { blockReloadKeys } from './reload-keys'
import { runProbe } from './probe'

declare const __SX_FEATURE_STORE__: boolean
declare const __SX_FEATURE_PILOT__: boolean
declare const __SX_FEATURE_CONNECT__: boolean
declare const __SX_FEATURE_CLOUD__: boolean

// Panics and web view crashes the shell recorded are sent from the page; register before the app starts.
registerCrashHost(createTauriCrash())
// F5 and Ctrl+R would reload the window and drop the plate; the dev server keeps them for development.
if (!import.meta.env.DEV) blockReloadKeys()

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

// mimir signs in with ChatGPT through the Rust side; the webview never sees a token.
if (__SX_FEATURE_PILOT__) {
  const [{ registerChatGpt, registerAgentInstall }, { createTauriChatGpt }, { createTauriAgents }] = await Promise.all([import('@slicerx/app'), import('./host/chatgpt'), import('./host/agents')])
  registerChatGpt(() => createTauriChatGpt())
  registerAgentInstall(() => createTauriAgents())
  // Set up local AI reads the hardware and reaches Ollama and LM Studio through the shell.
  const [{ registerLocalAi }, { createTauriLocalAi }] = await Promise.all([import('@slicerx/app'), import('./host/local-ai')])
  registerLocalAi(() => createTauriLocalAi())
}

// The desktop app starts its own bridge and connects to it.
if (__SX_FEATURE_CONNECT__) {
  const [{ setBridgeConnector }, { shellBridge }, { invoke }] = await Promise.all([import('@slicerx/app'), import('@slicerx/web/host/link'), import('@tauri-apps/api/core')])
  setBridgeConnector(shellBridge(() => invoke<{ url: string; code: string; hubKey: string }>('link_start'), editionFromBuild().backend.relay))
  // Phone access keeps its identity and pairings sealed by the shell, with a key in the system keychain.
  const [{ setPairStorage, sealedPairStores }, { tauriDocStore }] = await Promise.all([import('@slicerx/app'), import('./host/pair-doc')])
  setPairStorage({ ...sealedPairStores(tauriDocStore()), name: `${editionFromBuild().brand.name} on this computer`, kind: 'desktop' })
}

// The AI clients' marks identify them in "Connect your AI agent"; unaltered, never implying endorsement.
if (__SX_FEATURE_PILOT__) {
  const [{ registerAgentMarks }, { BrandLogo }] = await Promise.all([import('@slicerx/app'), import('@slicerx/brand-icons')])
  registerAgentMarks((mark, size, title) => <BrandLogo slug={mark} size={size} title={title} />)
}

// The native menu bar (File, Edit, View, Help) runs the app's own commands.
{
  const [{ registerNativeMenu, registerLinkOpener, onWindowTitle }, { createNativeMenu }, { openUrl }, { getCurrentWindow }] = await Promise.all([
    import('@slicerx/app'),
    import('./menu'),
    import('@tauri-apps/plugin-opener'),
    import('@tauri-apps/api/window'),
  ])
  registerNativeMenu(createNativeMenu())
  // Help pages open in the system browser.
  registerLinkOpener((url) => openUrl(url))
  // The title names the project's file and marks unsaved changes.
  onWindowTitle((title) => void getCurrentWindow().setTitle(title).catch(() => undefined))
}

// In-app updates, when this build's edition has an update feed: checked at launch and daily, installed on the person's click.
{
  const [{ registerUpdater }, { createTauriUpdater, updaterMode }] = await Promise.all([import('@slicerx/app'), import('./host/updater')])
  const mode = await updaterMode()
  if (mode) registerUpdater(createTauriUpdater(mode))
}

// On Linux the shell reads the real GL renderer, which WebKit hides from the page (gl_renderer is null elsewhere).
{
  const [{ registerShellGpu }, { invoke }] = await Promise.all([import('@slicerx/app'), import('@tauri-apps/api/core')])
  registerShellGpu(() => invoke<string | null>('gl_renderer'))
}

// First run can bring presets over from the slicers installed on this computer.
{
  const [{ registerPresetImport }, { createTauriPresetImport }] = await Promise.all([import('@slicerx/app'), import('./host/presets')])
  registerPresetImport(() => createTauriPresetImport())
}

const el = document.getElementById('root')
if (!el) throw new Error('index.html is missing #root')
const config = editionFromBuild()
const [host, list] = await Promise.all([createDesktopHost(), features()])
if (__SX_FEATURE_CONNECT__) host.bambuConnect = (await import('./host/bambu-connect')).createTauriBambuConnect()
if (__SX_FEATURE_CONNECT__) host.firewall = (await import('./host/firewall')).createTauriFirewall()
if (__SX_FEATURE_STORE__) {
  const [{ lazyStore }, { createDesktopAuth }] = await Promise.all([import('../../web/src/host/store'), import('./host/auth')])
  const edition: EditionHost = host
  // Sign-in and the website's pages open in the system browser through the host, and emailed links come back as
  // the edition's deep link. The store must send that deep link as the return address, or the link lands on the website.
  const auth = createDesktopAuth(config)
  edition.auth = auth
  edition.store = lazyStore(config, auth)
  const store = edition.store
  // Each link is finished once, even when the system hands it over twice; the sign-in form shows a failure as well.
  const handled = new Set<string>()
  auth.onDeepLink((url) => {
    if (handled.has(url)) return
    handled.add(url)
    void Promise.all([store.completeSignIn(url), import('@slicerx/app')]).then(([r, { reportSignInResult, toast }]) => {
      reportSignInResult(r.ok ? { ok: true, ...(r.value.email ? { email: r.value.email } : {}) } : { ok: false, message: r.message })
      if (r.ok) toast(r.value.email ? `Signed in as ${r.value.email}` : 'Signed in', 'ok')
      else toast(`Sign-in did not finish: ${r.message}`, 'error')
    })
  })
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
}
// The app bar's logo slot shows the edition's own logo (brand.logo); SlicerX keeps its wordmark.
createRoot(el).render(
  <StrictMode>
    <SlicerXApp host={host} features={list} edition={config} logo={editionLogo(config)} />
  </StrictMode>,
)

// Closing the window with unsaved changes asks first (save, discard or cancel). The shell holds that close only
// while this page says there is something to lose; any other close exits without waiting on the page.
void (async () => {
  try {
    const [{ listen }, { invoke }, { confirmDiscard, onDirtyChange }] = await Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core'), import('@slicerx/app')])
    onDirtyChange((unsaved) => void invoke('unsaved_set', { unsaved }))
    await listen('sx-close-requested', async () => {
      if (await confirmDiscard('quit')) await invoke('quit_app')
    })
  } catch {
    // Outside the desktop shell there is no window to guard.
  }
})()

void runProbe(host)
