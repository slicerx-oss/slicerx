// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Everything the phone reaches outside itself, behind one object. Screens never import
// this; they use the hooks in src/data. Printers come from the paired computer when
// there is one (packages/pair) and from the demo fleet otherwise. The phone never
// slices locally: `slicer` and `cloud` are the same cloud slicer.
import { createCloudClient, createCloudSlicer } from '@slicerx/cloud'
import type { ApprovalHost, ApprovalVerifier, AuthClient, AuthHost, LlmTransport, PrinterHost, SlicerHost, StoreClient } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { createApprovalBroker } from '@slicerx/pilot'
import { createEditionAuth, createEditionStore, editionSignInMethods } from '@slicerx/store'
import { createAuth } from '@slicerx/store/auth'
import * as WebBrowser from 'expo-web-browser'
import { createCloudStub } from '../cloud/stub'
import { authCallbackUrl, edition } from '../config/edition'
import { createDemoPrinters } from './demo-printers'
import { secureAuthStorage } from './secure-storage'
import { switchablePrinters, type SwitchablePrinters } from './switchable'

export type { PrinterSource, SwitchablePrinters } from './switchable'

export interface PocketHost {
  edition: EditionConfig
  /** The demo fleet until a computer is paired; `printers.use()` switches the source. */
  printers: SwitchablePrinters
  /** The demo fleet, for switching back when no paired computer is online. */
  demoPrinters: PrinterHost
  approvals: ApprovalHost & ApprovalVerifier
  /** Sign-in, session, tokens, data export and account deletion. The store when the edition has one. */
  account: AuthClient
  /** The free library; null when the edition ships without the store module. */
  store: StoreClient | null
  auth: PocketAuth
  cloud: SlicerHost
  slicer: SlicerHost
  llm: LlmTransport
}

// The phone has no model key of its own; mimir answers offline until a paired
// computer or the SlicerX service carries the model traffic.
const noLlm: LlmTransport = {
  available: async () => false,
  stream: () => {
    throw new Error('mimir on the phone runs through a paired computer or your SlicerX account')
  },
}

export interface PocketAuth extends AuthHost {
  /** Hands a callback URL that arrived through the OS (a magic link) to the listeners. */
  deliver(url: string): void
}

function createAuthHost(scheme: string): PocketAuth {
  const listeners = new Set<(url: string) => void>()
  return {
    deliver: (url) => {
      for (const l of listeners) l(url)
    },
    redirectUrl: authCallbackUrl,
    // OAuth runs in an in-app browser session that closes itself on the callback URL.
    openExternal: async (url) => {
      const r = await WebBrowser.openAuthSessionAsync(url, `${scheme}://auth/callback`)
      if (r.type === 'success') for (const l of listeners) l(r.url)
    },
    // app/auth/callback.tsx forwards magic links that arrive through the OS.
    onDeepLink: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

function cloudSlicer(config: EditionConfig, account: AuthClient): SlicerHost {
  const stub = createCloudStub()
  if (!config.backend.cloudApi) return stub
  const client = createCloudClient({
    baseUrl: config.backend.cloudApi,
    // The signed-in session's JWT, refreshed by the store; null when signed out or offline.
    credential: () => account.accessToken(),
  })
  return createCloudSlicer({ client, local: stub })
}

export function createPocketHost(): PocketHost {
  const config = edition()
  const approvals = createApprovalBroker()
  const auth = createAuthHost(config.apps.deepLinkScheme)
  const platform = { kind: 'mobile' as const, openExternal: auth.openExternal, storage: secureAuthStorage }
  // One client carries the session: the store when the edition has it (it is an AuthClient too),
  // else accounts alone, else the offline example account.
  const store = createEditionStore(config, platform)
  const account = store ?? createEditionAuth(config, platform) ?? createAuth({ offline: true, signIn: editionSignInMethods(config) })
  const cloud = cloudSlicer(config, account)
  const demo = createDemoPrinters(approvals)
  return {
    edition: config,
    printers: switchablePrinters({ kind: 'demo' }, demo),
    demoPrinters: demo,
    approvals,
    account,
    store,
    auth,
    cloud,
    slicer: cloud,
    llm: noLlm,
  }
}
