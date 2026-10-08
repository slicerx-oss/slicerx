// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The agent bridge's hands (dev and test builds only, docs/agent-bridge.md): find a control by its data-testid, read
// it, click it, type into it, press a key, wait for it. Test ids are part of the UI contract (docs/test-ids.md).
// Controls that print, send to a printer or delete are refused: a test id starting with `danger-`, anything inside the
// approval dialog or the Print sheet, or a control marked data-agent-refuse. The bridge acts only on controls with a
// test id, and test/test-ids.test.ts keeps every test id that names such an action under `danger-`.
import { isVisible, safeUrl } from './capture'

export class BridgeError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'refused' | 'timeout' | 'not_ready',
    message: string,
  ) {
    super(message)
  }
}

/** Where the bridge never clicks, types or presses keys. */
const REFUSED_AREAS = '[data-agent-refuse], .approve-dialog, .print-sheet'

export const sel = (testid: string) => `[data-testid="${testid.replace(/["\\]/g, '\\$&')}"]`

function needId(testid: unknown): string {
  if (typeof testid !== 'string' || !/^[\w.:-]{1,120}$/.test(testid)) throw new BridgeError('invalid_input', 'testid must be a test id (letters, digits, - _ . :)')
  return testid
}

export function enabled(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled) return false
  if (el.getAttribute('aria-disabled') === 'true') return false
  return !el.closest('fieldset[disabled]')
}

/** Why a control must not be used by the bridge, or null. */
export function refusal(el: Element): string | null {
  const id = el.getAttribute('data-testid') ?? ''
  if (id.startsWith('danger-')) return `${id} is marked as destructive`
  if (el.closest(REFUSED_AREAS)) return 'it is inside the approval dialog, the Print sheet or a control the bridge must not use'
  return null
}

export function find(doc: Document, testid: unknown, index = 0): { el: Element; count: number } {
  const id = needId(testid)
  const all = [...doc.querySelectorAll(sel(id))]
  const shown = all.filter(isVisible)
  const list = shown.length ? shown : all
  const el = list[index]
  if (!el) throw new BridgeError('not_found', all.length ? `${id}: ${all.length} found, none at index ${index} on screen` : `no element with data-testid ${id}`)
  return { el, count: list.length }
}

/** Images kept per control; a card has a cover and a logo. */
const IMAGES_MAX = 20

/**
 * The pictures in a control (or the control itself, an img): the address without its query, and whether it loaded. A
 * lazy picture far off screen has not started yet (`pending`); one the browser gave up on is `failed`.
 */
export function images(el: Element): Record<string, unknown>[] {
  const view = el.ownerDocument.defaultView
  const Img = view?.HTMLImageElement ?? HTMLImageElement
  const list = el instanceof Img ? [el] : [...el.querySelectorAll('img')]
  return list.slice(0, IMAGES_MAX).map((img) => {
    const src = img.currentSrc || img.getAttribute('src') || ''
    const state = !img.complete ? 'pending' : img.naturalWidth > 0 ? 'loaded' : src ? 'failed' : 'empty'
    const r = img.getBoundingClientRect()
    const inView = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < (view?.innerHeight ?? 0) && r.left < (view?.innerWidth ?? 0)
    return {
      url: safeUrl(src, el.ownerDocument.location?.href),
      state,
      ...(state === 'loaded' ? { width: img.naturalWidth, height: img.naturalHeight } : {}),
      inView,
      ...(img.getAttribute('loading') === 'lazy' ? { lazy: true } : {}),
    }
  })
}

/** What an agent may read off a control. Password fields never give their value. */
export function describe(el: Element, index: number): Record<string, unknown> {
  const input = el as HTMLInputElement
  const value = 'value' in el && typeof input.value === 'string' && input.type !== 'password' ? input.value : undefined
  // The row's item and state ride on data attributes: data-listing, data-object-id, data-state, data-step, data-tone.
  const data: Record<string, string> = {}
  for (const a of el.attributes) if (a.name.startsWith('data-') && a.name !== 'data-testid') data[a.name.slice(5)] = a.value.slice(0, 200)
  const pictures = images(el)
  return {
    index,
    tag: el.tagName.toLowerCase(),
    visible: isVisible(el),
    enabled: enabled(el),
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
    ...(value !== undefined ? { value } : {}),
    ...(el.getAttribute('aria-label') ? { label: el.getAttribute('aria-label') } : {}),
    ...(input.type === 'checkbox' || input.type === 'radio' ? { checked: input.checked } : {}),
    ...(el.getAttribute('aria-checked') ? { checked: el.getAttribute('aria-checked') === 'true' } : {}),
    ...(el.getAttribute('aria-pressed') ? { pressed: el.getAttribute('aria-pressed') === 'true' } : {}),
    ...(el.getAttribute('aria-expanded') ? { expanded: el.getAttribute('aria-expanded') === 'true' } : {}),
    ...(el.getAttribute('aria-current') ? { current: el.getAttribute('aria-current') } : {}),
    ...(Object.keys(data).length ? { data } : {}),
    ...(pictures.length ? { images: pictures } : {}),
  }
}

export function elements(doc: Document, testid: unknown): Record<string, unknown>[] {
  const id = needId(testid)
  return [...doc.querySelectorAll(sel(id))].map((el, i) => describe(el, i))
}

/** Every test id on screen (or in the document), with how many carry it. */
export function testids(doc: Document, visibleOnly = true): Record<string, number> {
  const out: Record<string, number> = {}
  for (const el of doc.querySelectorAll('[data-testid]')) {
    if (visibleOnly && !isVisible(el)) continue
    const id = el.getAttribute('data-testid') ?? ''
    out[id] = (out[id] ?? 0) + 1
  }
  return out
}

function usable(el: Element): void {
  const why = refusal(el)
  if (why) throw new BridgeError('refused', `The bridge does not use this control: ${why}.`)
  if (!isVisible(el)) throw new BridgeError('not_ready', `${el.getAttribute('data-testid')} is not on screen`)
  if (!enabled(el)) throw new BridgeError('not_ready', `${el.getAttribute('data-testid')} is disabled`)
}

/** A person's click: pointer and mouse down and up, then click, at the control's center. */
export function click(doc: Document, testid: unknown, index = 0): Record<string, unknown> {
  const { el, count } = find(doc, testid, index)
  usable(el)
  ;(el as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'center' })
  const view = doc.defaultView
  const r = el.getBoundingClientRect()
  const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }
  const Pointer = view?.PointerEvent ?? view?.MouseEvent ?? MouseEvent
  el.dispatchEvent(new Pointer('pointerdown', { ...at, buttons: 1 }))
  el.dispatchEvent(new (view?.MouseEvent ?? MouseEvent)('mousedown', { ...at, buttons: 1 }))
  ;(el as HTMLElement).focus?.()
  el.dispatchEvent(new Pointer('pointerup', at))
  el.dispatchEvent(new (view?.MouseEvent ?? MouseEvent)('mouseup', at))
  ;(el as HTMLElement).click()
  return { clicked: el.getAttribute('data-testid'), matches: count }
}

/** Types into an input, text area or select the way React sees typing: the native setter, then input and change. */
export function fill(doc: Document, testid: unknown, value: unknown, index = 0): Record<string, unknown> {
  if (typeof value !== 'string') throw new BridgeError('invalid_input', 'value must be a string')
  const { el } = find(doc, testid, index)
  usable(el)
  const view = doc.defaultView
  const proto =
    el instanceof (view?.HTMLTextAreaElement ?? HTMLTextAreaElement)
      ? (view?.HTMLTextAreaElement ?? HTMLTextAreaElement).prototype
      : el instanceof (view?.HTMLSelectElement ?? HTMLSelectElement)
        ? (view?.HTMLSelectElement ?? HTMLSelectElement).prototype
        : el instanceof (view?.HTMLInputElement ?? HTMLInputElement)
          ? (view?.HTMLInputElement ?? HTMLInputElement).prototype
          : null
  if (!proto) throw new BridgeError('invalid_input', `${String(testid)} is not an input, text area or select`)
  ;(el as HTMLElement).focus()
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { filled: el.getAttribute('data-testid'), length: value.length }
}

export interface KeyArgs {
  key: unknown
  testid?: unknown
  ctrl?: unknown
  shift?: unknown
  alt?: unknown
  meta?: unknown
}

/**
 * Presses a key on a control (or whatever has focus). Pages only see such a key as an event, so the two defaults the
 * app relies on are done here as the browser would: Escape cancels the open dialog, Enter in a form field submits it.
 */
export function pressKey(doc: Document, a: KeyArgs): Record<string, unknown> {
  if (typeof a.key !== 'string' || !a.key || a.key.length > 32) throw new BridgeError('invalid_input', 'key must be a key name such as Enter, Escape, ArrowDown or a')
  const key = a.key
  const target = a.testid !== undefined ? find(doc, a.testid).el : (doc.activeElement ?? doc.body)
  if (target && target !== doc.body) {
    const why = refusal(target)
    if (why) throw new BridgeError('refused', `The bridge does not use this control: ${why}.`)
  }
  const view = doc.defaultView
  const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true, ctrlKey: a.ctrl === true, shiftKey: a.shift === true, altKey: a.alt === true, metaKey: a.meta === true }
  const Key = view?.KeyboardEvent ?? KeyboardEvent
  const down = target.dispatchEvent(new Key('keydown', init))
  target.dispatchEvent(new Key('keyup', init))
  let did: string | null = null
  if (down && key === 'Escape') {
    const dialogs = [...doc.querySelectorAll('dialog[open]')]
    const top = dialogs[dialogs.length - 1] as HTMLDialogElement | undefined
    if (top && !top.closest(REFUSED_AREAS)) {
      if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close()
      did = 'cancelled the dialog'
    }
  } else if (down && key === 'Enter' && target instanceof (view?.HTMLInputElement ?? HTMLInputElement) && target.form) {
    target.form.requestSubmit()
    did = 'submitted the form'
  }
  return { pressed: key, on: target.getAttribute?.('data-testid') ?? target.tagName.toLowerCase(), ...(did ? { did } : {}) }
}

export type WaitState = 'visible' | 'hidden' | 'enabled' | 'present' | 'absent'

/** Waits until a control is in a state, checking every 100 ms. */
export async function waitFor(doc: Document, testid: unknown, state: unknown = 'visible', timeoutMs = 10_000, text?: unknown): Promise<Record<string, unknown>> {
  const id = needId(testid)
  const want = (typeof state === 'string' ? state : 'visible') as WaitState
  if (!['visible', 'hidden', 'enabled', 'present', 'absent'].includes(want)) throw new BridgeError('invalid_input', 'state must be visible, hidden, enabled, present or absent')
  if (text !== undefined && typeof text !== 'string') throw new BridgeError('invalid_input', 'text must be a string')
  const started = Date.now()
  const check = (): boolean => {
    const all = [...doc.querySelectorAll(sel(id))].filter((el) => text === undefined || (el.textContent ?? '').includes(text))
    const shown = all.filter(isVisible)
    switch (want) {
      case 'present':
        return all.length > 0
      case 'absent':
        return all.length === 0
      case 'visible':
        return shown.length > 0
      case 'hidden':
        return shown.length === 0
      case 'enabled':
        return shown.some(enabled)
    }
  }
  for (;;) {
    if (check()) return { testid: id, state: want, waitedMs: Date.now() - started }
    if (Date.now() - started >= timeoutMs) throw new BridgeError('timeout', `${id} was not ${want} after ${timeoutMs} ms`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
