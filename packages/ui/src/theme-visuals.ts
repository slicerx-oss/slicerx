// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Edition colors sit above look presets; removing them restores the latest preset values.

export type VisualTokens = Readonly<Record<string, string>>
type Property = { value: string; priority: string }
type Applied = { values: VisualTokens; base: Map<string, Property> }
const applied = new WeakMap<HTMLElement, Applied>()

const read = (el: HTMLElement, name: string): Property => ({ value: el.style.getPropertyValue(name), priority: el.style.getPropertyPriority(name) })
function restore(el: HTMLElement, name: string, property: Property): void {
  if (property.value) el.style.setProperty(name, property.value, property.priority)
  else el.style.removeProperty(name)
}

export function setVisualTokens(el: HTMLElement, values: VisualTokens): void {
  const previous = applied.get(el)
  for (const [name, property] of previous?.base ?? []) if (!(name in values)) restore(el, name, property)
  const base = new Map<string, Property>()
  for (const [name, value] of Object.entries(values)) {
    base.set(name, previous?.base.get(name) ?? read(el, name))
    el.style.setProperty(name, value)
  }
  if (base.size) applied.set(el, { values: { ...values }, base })
  else applied.delete(el)
}

/** Capture a preset's new values before restoring the edition's colors over it. */
export function reapplyVisualTokens(el: HTMLElement, changed: readonly string[]): void {
  const state = applied.get(el)
  if (!state) return
  const names = new Set(changed)
  for (const [name, value] of Object.entries(state.values)) {
    if (names.has(name)) state.base.set(name, read(el, name))
    el.style.setProperty(name, value)
  }
}

export function clearVisualTokens(el: HTMLElement): void {
  const state = applied.get(el)
  if (!state) return
  for (const [name, property] of state.base) restore(el, name, property)
  applied.delete(el)
}
