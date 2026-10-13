// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part of the app's code that failed to download (the network dropped for a moment while the app started) stays
// failed for the rest of the page: the browser keeps the failed module and every later import of it fails at once,
// so "Try again" cannot fix it. Only a reload fetches it again. The app reloads once by itself when nothing would be
// lost; with unsaved work it asks the person to reload after saving instead.
import { appName } from '../edition'
import { isDirty } from '../project/unsaved'
import { toast } from '../state/store'

/** The browsers' messages for a module that could not be fetched (Chromium, Safari, Firefox) and Vite's CSS preload. */
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i

/** Session key holding when the app last reloaded for this, so a part that never loads does not reload forever. */
const KEY = 'sx-chunk-reload'

/** How long after such a reload another one is not tried. */
const AGAIN_MS = 30_000

export function isChunkLoadError(e: unknown): boolean {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return CHUNK_ERROR.test(text)
}

function storage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/**
 * Reloads the page to fetch the app's code again, when that loses nothing and the app has not just done so. Returns
 * whether it reloads; when it does not, the caller says what happened.
 */
export function reloadForChunk(now = Date.now(), dirty = isDirty(), reload = () => window.location.reload()): boolean {
  if (dirty) return false
  const s = storage()
  const last = Number(s?.getItem(KEY) ?? 0)
  if (now - last < AGAIN_MS) return false
  s?.setItem(KEY, String(now))
  reload()
  return true
}

let told = false
let workspaceDown = false

/** The workspace could not load and says so itself, so the toast stays away (the boundary calls this). */
export function noteWorkspaceDown(): void {
  workspaceDown = true
}

/** How long the toast waits, so a workspace that failed with the same download says so first. */
const TOAST_DELAY_MS = 400

/** The message when the app cannot reload by itself: once per page, and only while the workspace is up. */
function tell(): void {
  if (told) return
  window.setTimeout(() => {
    if (told || workspaceDown) return
    told = true
    toast(`Part of ${appName()} did not load (the connection dropped). Save your work, then reload.`, 'warn', { label: 'Reload', run: () => window.location.reload() })
  }, TOAST_DELAY_MS)
}

/** A chunk that failed to load: reloads, or says so. */
export function onChunkError(): void {
  if (!reloadForChunk()) tell()
}

/** Listens for code that failed to load outside a workspace (Vite's preload event and unhandled imports). */
export function startChunkReload(): () => void {
  // Cancelled only when the page reloads; otherwise the import fails as it would have, and the caller handles it.
  const preload = (e: Event) => {
    if (reloadForChunk()) e.preventDefault()
    else tell()
  }
  const rejection = (e: PromiseRejectionEvent) => {
    if (isChunkLoadError(e.reason)) onChunkError()
  }
  window.addEventListener('vite:preloadError', preload)
  window.addEventListener('unhandledrejection', rejection)
  return () => {
    window.removeEventListener('vite:preloadError', preload)
    window.removeEventListener('unhandledrejection', rejection)
  }
}
