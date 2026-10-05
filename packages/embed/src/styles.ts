// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Styles for the embed pieces, scoped by class so a host page is untouched.
// The Nocturne tokens come along, rescoped from :root to the pieces, so they
// look right on a page that never loaded @slicerx/ui.
import tokens from '@slicerx/ui/tokens.css?raw'

// The default tokens go on a piece only outside an EmbedTheme: declared on the piece itself they would
// win over the theme's variables, which the piece inherits from the EmbedTheme wrapper.
const SCOPE = ':is(.sxe-viewport, .sxe-settings, .sxe-agreement, .sxe-localai):not(.sx-theme-scope *), :host'

export const EMBED_CSS = tokens.replace(/:root\b/g, SCOPE) + `
.sxe-viewport { position: relative; min-height: 240px; background: var(--ink-1); border-radius: 12px; overflow: hidden; }
.sxe-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; outline: none; }
.sxe-error { position: absolute; inset: 0; margin: 0; display: grid; place-items: center; padding: 24px; text-align: center; color: var(--muted); font: 13px/1.5 system-ui, sans-serif; }
.sxe-settings { font: 13px/1.5 var(--f-body); color: var(--fg); background: var(--ink-1); border: 1px solid var(--line-soft); border-radius: 12px; padding: 14px 16px; }
.sxe-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--ink-2); border: 1px solid var(--line-soft); margin-bottom: 10px; }
.sxe-tabs button { border: 0; background: none; color: var(--muted); font: 600 12px var(--f-body); height: 26px; padding: 0 12px; border-radius: 7px; cursor: pointer; }
.sxe-tabs button[aria-selected=true] { background: var(--ink-4); color: var(--fg); }
.sxe-row { margin-top: 12px; }
.sxe-row-h { display: flex; justify-content: space-between; margin-bottom: 4px; }
.sxe-row-h output { font: 500 12px var(--f-mono); color: var(--purple); }
.sxe-settings input[type=range] { width: 100%; accent-color: var(--purple); }
.sxe-settings select, .sxe-settings input:not([type=range]):not([type=checkbox]) { height: 28px; border-radius: 6px; border: 1px solid var(--line-soft); background: var(--ink-2); color: inherit; padding: 0 6px; font: inherit; }
.sxe-check { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.sxe-check input, .sxe-list input[type=checkbox] { accent-color: var(--purple); }
.sxe-list { list-style: none; margin: 0; padding: 0; max-height: 360px; overflow: auto; }
.sxe-list li { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px dashed var(--line-soft); }
.sxe-list li input { width: 80px; text-align: right; }
.sxe-settings :focus-visible, .sxe-canvas:focus-visible, .sxe-agreement :focus-visible { outline: 2px solid var(--purple); outline-offset: 2px; }
.sxe-agreement { box-sizing: border-box; max-width: 640px; max-height: 100%; overflow: auto; font: 14px/1.55 var(--f-body); color: var(--fg); background: var(--ink-1); border: 1px solid var(--line-soft); border-radius: var(--r-lg, 12px); padding: 20px 24px; box-shadow: var(--shadow-float); }
.sxe-agreement h2 { margin: 0 0 8px; font: 600 20px/1.25 var(--f-display); }
.sxe-agreement h3 { margin: 16px 0 4px; font: 600 14px/1.3 var(--f-body); }
.sxe-agreement p { margin: 0; color: var(--muted); }
.sxe-agreement a { color: var(--purple); overflow-wrap: anywhere; }
.sxe-ag-eyebrow { font: 600 11px/1 var(--f-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--orange) !important; margin-bottom: 8px !important; }
.sxe-agreement .sxe-check { align-items: flex-start; margin-top: 20px; color: var(--fg); }
.sxe-agreement .sxe-check input { margin-top: 3px; accent-color: var(--purple); }
.sxe-ag-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; font: 12px var(--f-mono); color: var(--dim); }
.sxe-localai { display: flex; flex-direction: column; gap: 10px; font: 13px/1.5 var(--f-body); color: var(--fg); background: var(--ink-1); border: 1px solid var(--line-soft); border-radius: 12px; padding: 14px 16px; }
.sxe-localai p { margin: 0; }
.sxe-la-title { font-weight: 600; font-size: 14px; }
.sxe-la-note { color: var(--muted); font-size: 12px; }
.sxe-la-facts { margin: 0; display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 4px 8px; }
.sxe-la-facts dt { color: var(--muted); }
.sxe-la-facts dd { margin: 0; }
.sxe-la-rec { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--line-soft); padding-top: 10px; }
.sxe-la-act { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sxe-la-act progress { flex: 1; min-width: 120px; accent-color: var(--purple); }
.sxe-la-confirm { display: flex; flex-direction: column; gap: 8px; border-radius: 8px; padding: 10px 12px; background: var(--ink-2); }
.sxe-localai :focus-visible { outline: 2px solid var(--purple); outline-offset: 2px; }
.sxe-ghost { border: 1px solid var(--line-soft); border-radius: 8px; height: 34px; padding: 0 14px; font: 600 13px var(--f-body); background: none; color: var(--fg); cursor: pointer; }
.sxe-primary { border: 0; border-radius: 8px; height: 34px; padding: 0 16px; font: 600 13px var(--f-body); background: var(--purple); color: var(--on-grad); cursor: pointer; }
.sxe-primary:disabled { opacity: 0.45; cursor: not-allowed; }
`

let injected = false

/** Adds the embed styles to the document once. Custom elements add them to their own shadow root instead. */
export function injectStyles(): void {
  if (injected || typeof document === 'undefined') return
  const el = document.createElement('style')
  el.dataset['slicerx'] = 'embed'
  el.textContent = EMBED_CSS
  document.head.appendChild(el)
  injected = true
}
