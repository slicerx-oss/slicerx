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

/** The slicing engine (WebAssembly) failed to start, so nothing can be sliced; main.tsx shows it with a retry. */
export class EngineStartError extends Error {
  override name = 'EngineStartError'
}

/**
 * The WASM worker pool. Only a dev server falls back to the synthetic slicer (a tree before `sx-wasm` is built): a real
 * build never slices with it, since its G-code would print nothing useful.
 * The pool's code loads beside the startup shell, not in it: it is needed once the host is made, with the engine module
 * it compiles anyway.
 */
async function slicer(): Promise<{ host: SlicerHost; wasm: boolean }> {
  const { createWebSlicer } = await import('@slicerx/slicer')
  try {
    return { host: await createWebSlicer(), wasm: true }
  } catch (e) {
    if (import.meta.env.DEV) {
      console.warn('sx-wasm is not available; this dev server slices with the synthetic slicer', e)
      return { host: await createWebSlicer({ fake: true }), wasm: false }
    }
    throw new EngineStartError(e instanceof Error ? e.message : String(e), { cause: e })
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

/** The browser host. The desktop build calls it with its native slicer and files. */
export async function createWebHost(over: HostOverrides = {}): Promise<Host> {
  const edition = editionFromBuild()
  const sl = over.slicer ? { host: over.slicer, wasm: false } : await slicer()
  const host: Host = {
    kind: over.kind ?? 'web',
    capabilities: {
      nativeSlicing: over.nativeSlicing ?? false,
      orcaEngine: false,
      printers: __SX_FEATURE_CONNECT__ ? 'sim' : 'none',
      webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
      threads: over.threads ?? Math.max(1, Math.min(11, (navigator.hardwareConcurrency || 4) - 1)),
      secureStorage: false,
    },
    build: {
      version: __SX_VERSION__,
      commit: __SX_COMMIT__,
      // The edition names where its source lives; `{commit}` pins this exact build.
      sourceUrl: sourceUrl(edition, __SX_COMMIT__) ?? SLICERX_SOURCE,
      ...(__SX_E2E__ ? { e2e: true } : {}),
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
      host.printers = createDemoPrinters(broker)
    }
  }
  if (__SX_FEATURE_PILOT__) host.llm = over.llm ?? noLlm
  return host
}
