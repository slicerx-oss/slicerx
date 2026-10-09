// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Shown in place of the app when the slicing engine cannot start: the reason and a way to try again. Plain DOM, since
// it shows before the app and its styles load, and it loads only when needed.

/** Fills `root` with the message and resolves when the person asks to try again. */
export function showEngineError(root: HTMLElement, error: unknown): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error)
  root.replaceChildren()
  const box = document.createElement('div')
  box.setAttribute('role', 'alert')
  box.dataset['testid'] = 'engine-error'
  box.style.cssText = 'max-width:460px;margin:18vh auto 0;padding:24px;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f8f8f2;background:#21222c;border:1px solid #44475a;border-radius:12px'
  const title = document.createElement('h1')
  title.textContent = 'The slicing engine could not start'
  title.style.cssText = 'font-size:18px;margin:0 0 8px'
  const body = document.createElement('p')
  body.textContent = 'SlicerX slices in this browser with WebAssembly, and it failed to load. Check your connection and try again. If it keeps failing, try another browser or the desktop app.'
  body.style.cssText = 'margin:0 0 12px;color:#c9cbd6'
  const detail = document.createElement('p')
  detail.textContent = reason
  detail.style.cssText = 'margin:0 0 16px;font:12px/1.4 ui-monospace,monospace;color:#9aa0b8;word-break:break-word'
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = 'Try again'
  retry.style.cssText = 'font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#bd93f9;color:#21222c;cursor:pointer'
  box.append(title, body, detail, retry)
  root.append(box)
  retry.focus()
  return new Promise((resolve) => {
    retry.addEventListener(
      'click',
      () => {
        retry.disabled = true
        retry.textContent = 'Starting'
        resolve()
      },
      { once: true },
    )
  })
}
