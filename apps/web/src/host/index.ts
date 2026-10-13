// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The web Host: every platform service the app uses, for the browser build.
// Optional features are compiled in by SX_FEATURES; each import sits behind
// its constant so a build without it carries none of its code.
import type { ApprovalHost, ApprovalVerifier, FileHost, Host, LlmTransport, SecretsHost, SlicerHost, ThemesHost } from '@slicerx/contracts'
import { editionFromBuild, SLICERX_SOURCE, sourceUrl } from '@slicerx/edition-config'
import { createWebFiles } from './files'

declare const __SX_VERSION__: string
declare const __SX_COMMIT__: string
declare const __SX_E2E__: boolean
declare const __SX_DEV_BUILD__: boolean
/** False in a browser build without the slicing engine (SLICERX_WEB_SLICING=0): the CAD-only studio. */
declare const __SX_WEB_SLICING__: boolean
/** The native test slicer's address in the end-to-end test build (SLICERX_E2E_NATIVE_URL); empty in every other build. */
declare const __SX_E2E_NATIVE_URL__: string
declare const __SX_FEATURE_PILOT__: boolean
declare const __SX_FEATURE_CONNECT__: boolean


const noSecrets: SecretsHost = {
  has: async () => false,
  set: async () => {
    throw new Error('The browser build has no secure storage. Use sx-link or the desktop app to store printer credentials.')
  },
  delete: async () => undefined,
}

// Browser users reach a model provider through sx-link on localhost. Without it, Pilot replays recorded runs.
const noLlm: LlmTransport = {
  available: async () => false,
  stream: () => {
    throw new Error('mimir needs sx-link running on this computer to reach a model provider')
  },
}

/**
 * The WASM worker pool, or the synthetic slicer when the WASM build is missing (a dev tree before `sx-wasm` is built).
 * The pool's code loads beside the startup shell, not in it: it is needed once the host is made, with the engine module
 * it compiles anyway.
 */
async function slicer(): Promise<{ host: SlicerHost; wasm: boolean }> {
  const { createWebSlicer } = await import('@slicerx/slicer')
  try {
    return { host: await createWebSlicer(), wasm: true }
  } catch (e) {
    console.warn('sx-wasm is not available; using the synthetic slicer', e)
    return { host: await createWebSlicer({ fake: true }), wasm: false }
  }
}

/**
 * Settings keep 0 for "automatic" (line widths and a few speeds) so the UI can
 * show Auto; the slicer gets concrete values, resolved for the plate's nozzle.
 */
function resolvingAuto(slicer: SlicerHost): SlicerHost {
  return {
    ...slicer,
    slice: async (req, opts) => {
      // The settings schema is loaded when a slice needs it, not at startup.
      const { resolveAuto } = await import('@slicerx/settings')
      const nozzle = Array.isArray(req.config.nozzle_diameter) ? req.config.nozzle_diameter[0] : undefined
      return slicer.slice({ ...req, config: resolveAuto(req.config, nozzle ? { nozzleDiameter: nozzle } : {}) }, opts)
    },
  }
}

export interface HostOverrides {
  kind?: Host['kind']
  slicer?: SlicerHost
  files?: FileHost
  themes?: ThemesHost
  nativeSlicing?: boolean
  threads?: number
  /** The desktop's native model transport; the browser has none. */
  llm?: LlmTransport
}

/** An end-to-end test asked for the CAD-only studio on the test build. Always false outside that build. */
function cadOnlyTest(): boolean {
  if (!__SX_E2E__) return false
  try {
    return localStorage.getItem('slicerx.e2e.cadOnly') === '1'
  } catch {
    return false
  }
}

/** The browser host. The desktop build calls it with its native slicer and files. */
export async function createWebHost(over: HostOverrides = {}): Promise<Host> {
  const edition = editionFromBuild()
  // The demo fleet's made-up printers (on 192.0.2.0/24) are for development, tests and an edition that asks for demo
  // data, never for a person, who would read them as someone else's. Anywhere else the fleet starts empty.
  const demoPrinters = !cadOnlyTest() && (__SX_DEV_BUILD__ || edition.features.demoData)
  // Without the engine (a CAD-only build) the slicer and its WebAssembly module are left out of the bundle, and a host
  // that only keeps meshes answers the app. The end-to-end test build slices in the native engine instead, unless a test
  // opens it as the CAD-only studio (slicerx.e2e.cadOnly in localStorage).
  const native = __SX_E2E_NATIVE_URL__ && !cadOnlyTest()
  const sl = over.slicer
    ? { host: over.slicer, wasm: false }
    : native
      ? { host: (await import('./native-test')).createNativeTestSlicer(__SX_E2E_NATIVE_URL__), wasm: false }
      : __SX_WEB_SLICING__ && !cadOnlyTest()
        ? await slicer()
        : { host: (await import('./meshes')).createMeshHost(), wasm: false }
  const host: Host = {
    kind: over.kind ?? 'web',
    capabilities: {
      nativeSlicing: over.nativeSlicing ?? false,
      orcaEngine: false,
      printers: __SX_FEATURE_CONNECT__ ? 'sim' : 'none',
      webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
      threads: over.threads ?? Math.max(1, Math.min(11, (navigator.hardwareConcurrency || 4) - 1)),
      secureStorage: false,
      ...(over.slicer || native || (__SX_WEB_SLICING__ && !cadOnlyTest()) ? {} : { slicing: false }),
    },
    build: {
      version: __SX_VERSION__,
      commit: __SX_COMMIT__,
      // The edition names where its source lives; `{commit}` pins this exact build.
      sourceUrl: sourceUrl(edition, __SX_COMMIT__) ?? SLICERX_SOURCE,
      ...(__SX_E2E__ ? { e2e: true } : {}),
      ...(__SX_DEV_BUILD__ ? { dev: true } : {}),
    },
    slicer: resolvingAuto(sl.host),
    files: over.files ?? createWebFiles(),
    secrets: noSecrets,
    ...(over.themes ? { themes: over.themes } : {}),
  }

  if (__SX_FEATURE_PILOT__ || __SX_FEATURE_CONNECT__) {
    const { lazyBroker } = await import('./approvals')
    const broker: ApprovalHost & ApprovalVerifier = lazyBroker()
    host.approvals = broker
    if (__SX_FEATURE_CONNECT__) {
      const { createDemoPrinters } = await import('./printers')
      host.printers = createDemoPrinters(broker, { demo: demoPrinters })
    }
  }
  if (__SX_FEATURE_PILOT__) host.llm = over.llm ?? noLlm
  return host
}
