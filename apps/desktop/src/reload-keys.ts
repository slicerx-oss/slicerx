// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The web view's own reload keys. On Windows, WebView2 reloads the window on F5 or Ctrl+R that the page leaves
// alone, and Ctrl+R slices in OrcaSlicer and PrusaSlicer, so a habit from either reloaded SlicerX mid-project.
// The shell turns the browser keys off in release builds (src-tauri/src/crash.rs); this keeps them from the
// web view as well, in case that setting is missing or comes late.

/** True for a key the web view would take as reload. */
export function isReloadKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  if (e.key === 'F5' || e.key === 'BrowserRefresh') return true
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'r'
}

/**
 * Stops reload keys from reaching the web view. It only cancels the browser's default, after the app's own
 * handlers have seen the key, so a look that binds Ctrl+R to slicing still slices. Returns the unbind.
 */
export function blockReloadKeys(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isReloadKey(e)) e.preventDefault()
  }
  target.addEventListener('keydown', onKey)
  return () => target.removeEventListener('keydown', onKey)
}
