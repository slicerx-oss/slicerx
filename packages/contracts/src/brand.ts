// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The product's name in text people read, for packages that have no edition of their own (settings, the link
// client, the MCP server, the embed and viewport packages): SlicerX, or a white-label edition's name, which the app
// sets once at start. The published packages each bundle a copy of this module, so the name lives on globalThis
// and one setProductName call reaches every copy.

interface BrandState {
  name: string
  /** The edition's named brand colors (`brand.colors`), when it has its own. */
  colors?: Readonly<Record<string, string>> | undefined
  listeners: Set<(name: string) => void>
}

/** The name of the SlicerX edition, the default until the app sets its edition's. */
export const DEFAULT_PRODUCT_NAME = 'SlicerX'

const KEY = Symbol.for('@slicerx/contracts/brand')
const state = ((globalThis as Record<symbol, unknown>)[KEY] ??= { name: DEFAULT_PRODUCT_NAME, listeners: new Set() }) as BrandState

/** The name an app shows for itself. */
export function productName(): string {
  return state.name
}

/** Sets the name, from the edition's brand. The app calls it when it learns its edition. */
export function setProductName(next: string): void {
  state.name = next
  for (const l of state.listeners) l(next)
}

/** The edition's named brand colors, such as `{ black: '#17181f' }`. Undefined when it has none of its own. */
export function productColors(): Readonly<Record<string, string>> | undefined {
  return state.colors
}

/** Sets the named brand colors, from the edition's `brand.colors`; undefined goes back to the default kit. */
export function setProductColors(next: Readonly<Record<string, string>> | undefined): void {
  state.colors = next
}

/** Calls `fn` with each new name, for data written once that names the app (the printer catalog). */
export function onProductName(fn: (name: string) => void): void {
  state.listeners.add(fn)
}
