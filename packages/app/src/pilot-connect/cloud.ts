// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud: the edition's model proxy on its Supabase project (supabase/functions/mimir), free per day with no
// key. The desktop app registers a host whose commands run in Rust (packages/pilot/llm cloud.rs): the install token
// lives in the keychain and the webview never sees it. The browser build registers its own host (browser-cloud.ts),
// which runs for signed-in members only.
// This module loads with the shell; the edition check is in cloud-edition.ts, loaded with the pilot.
import { useSyncExternalStore } from 'react'

/** Today's use for this install, in micro-dollars, per Melbourne day. */
export interface MimirQuota {
  edition: string
  day: string
  installUsed: number
  installCap: number
  ipUsed: number
  ipCap: number
  /** False when mimir cloud is paused or the edition's budget for today is used up. */
  editionOpen: boolean
  /** The usage report (quota v2) as the proxy sent it; usage-quota.ts reads it. */
  v2?: unknown
}

export interface MimirCloudHost {
  /** True while the person is signed out, where mimir cloud needs a signed-in person (the browser). Unset elsewhere. */
  needsSignIn?: boolean
  quota(): Promise<MimirQuota>
  /** Deletes the sessions this install shared; resolves to how many. */
  forget(): Promise<number>
  /** Registers this install again (a new token). */
  register(): Promise<void>
  /**
   * The browser build's host sends mimir's model calls itself (browser-cloud.ts), with the member's session; the desktop's
   * go through its Rust transport and leave this out.
   */
  send?(url: string, init: { method: string; headers: Record<string, string>; body?: string }, signal?: AbortSignal): Promise<Response>
}

let host: MimirCloudHost | null = null
const listeners = new Set<() => void>()
// a stand-in proxy address for the test hook below, in an edition without a backend
let testBase: string | null = null

/** The test hook's stand-in proxy address, if a script set one. */
export const cloudTestBase = (): string | null => testBase

/** Called by an app entry whose shell carries mimir cloud: once on the desktop, on each sign-in or sign-out in the browser. */
export function registerMimirCloud(h: MimirCloudHost | null): void {
  host = h
  for (const l of listeners) l()
}

export function mimirCloudHost(): MimirCloudHost | null {
  return host
}

export function useMimirCloudHost(): MimirCloudHost | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => host,
  )
}

// Test hook: with localStorage 'slicerx.debug' set, a script can stand in for mimir cloud (window.__sxMimirCloud) in a
// build without a backend, the way tests reach the store as window.__sx.
if (typeof window !== 'undefined' && localStorage.getItem('slicerx.debug')) {
  Object.assign(window, {
    __sxMimirCloud: (h: MimirCloudHost, base: string) => {
      testBase = base
      registerMimirCloud(h)
    },
  })
}
