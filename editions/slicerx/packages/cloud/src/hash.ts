// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

/** Lowercase hex SHA-256 through Web Crypto (browsers, Node, Tauri, React Native with a polyfill). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
