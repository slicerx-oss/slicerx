// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
/** Public assistant identity shared by the app and separately bundled packages. */
export interface AssistantBrand {
  name: string
  icon: string
  accent?: string | Readonly<{ light: string; dark: string }> | undefined
}

export const DEFAULT_ASSISTANT_BRAND: Readonly<AssistantBrand> = Object.freeze({ name: 'mimir', icon: 'builtin:mimir' })
declare const __SX_ASSISTANT_BRAND__: Partial<AssistantBrand> | undefined

function normalize(value?: Partial<AssistantBrand>): Readonly<AssistantBrand> {
  const name = value?.name?.trim() || DEFAULT_ASSISTANT_BRAND.name
  return Object.freeze({
    name: name.toLowerCase() === 'mimir' ? 'mimir' : name,
    icon: value?.icon || DEFAULT_ASSISTANT_BRAND.icon,
    ...(value?.accent ? { accent: typeof value.accent === 'string' ? value.accent : Object.freeze({ ...value.accent }) } : {}),
  })
}

const KEY = Symbol.for('@slicerx/contracts/assistant-brand')
const state = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  value: normalize(typeof __SX_ASSISTANT_BRAND__ === 'undefined' ? undefined : __SX_ASSISTANT_BRAND__),
  listeners: new Set<() => void>(),
}) as { value: Readonly<AssistantBrand>; listeners: Set<() => void> }

export function assistantBrand(): Readonly<AssistantBrand> { return state.value }
export function assistantName(): string { return state.value.name }

/** Brands authored display copy, leaving stable tool names, URLs and command flags alone. */
export function assistantText(text: string): string {
  return text.replace(/(?<![\w:/-])mimir(?![\w-]|\.[a-z_])/g, () => assistantName())
}

/** Path B embedders can name their assistant without an edition config. */
export function setAssistantName(name: string): void {
  if (!name.trim() || name.trim().length > 40 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Assistant name must be 1 to 40 characters without control characters.')
  setAssistantBrand({ ...state.value, name })
}

/** Called when an app or standalone client loads its edition. Omission restores the defaults. */
export function setAssistantBrand(value?: Partial<AssistantBrand>): void {
  const next = normalize(value)
  if (JSON.stringify(next) === JSON.stringify(state.value)) return
  state.value = next
  for (const listener of state.listeners) listener()
}

export function onAssistantBrand(listener: () => void): () => void {
  state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}
