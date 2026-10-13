// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud: the edition's model proxy on its Supabase project (supabase/functions/mimir), free per day with no
// key. The desktop app registers a host whose commands run in Rust (packages/pilot/llm cloud.rs): the install token
// lives in the keychain and the webview never sees it. The browser build has no host, so it never offers the cloud.
import type { EditionConfig } from '@slicerx/edition-config'
import { useSyncExternalStore } from 'react'

/** The model mimir cloud runs; the proxy pins it whatever is sent. */
export const CLOUD_MODEL = 'claude-haiku-5-5'

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
}

export interface MimirCloudHost {
  quota(): Promise<MimirQuota>
  /** Deletes the sessions this install shared; resolves to how many. */
  forget(): Promise<number>
  /** Registers this install again (a new token). */
  register(): Promise<void>
}

let host: MimirCloudHost | null = null
const listeners = new Set<() => void>()

/** Called once by an app entry whose shell carries mimir cloud (the desktop app). */
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

/** The proxy's base for the pilot's adapter, which adds /v1/messages. Null when the edition has no cloud. */
export function cloudBase(edition: EditionConfig): string | null {
  const url = edition.ai.keySource === 'cloud' ? edition.backend.supabase?.url : undefined
  if (!url) return null
  try {
    return `${new URL(url).origin}/functions/v1/mimir`
  } catch {
    return null
  }
}

/** True when this build can run mimir on mimir cloud: the edition has it and the shell carries it. */
export function cloudReady(edition: EditionConfig, h: MimirCloudHost | null = host): boolean {
  return h !== null && cloudBase(edition) !== null
}
