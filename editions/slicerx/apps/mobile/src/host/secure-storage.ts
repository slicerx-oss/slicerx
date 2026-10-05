// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Session persistence in the iOS Keychain and Android Keystore. A Supabase session is
// larger than SecureStore's 2 KB per value on Android, so values are split into chunks.
import type { AuthStorage } from '@slicerx/store/auth'
import * as SecureStore from 'expo-secure-store'

const CHUNK = 1800

// SecureStore keys allow letters, digits, '.', '-' and '_' only.
const safe = (key: string): string => key.replace(/[^\w.-]/g, '_')

export const secureAuthStorage: AuthStorage = {
  async getItem(key) {
    const k = safe(key)
    const count = Number(await SecureStore.getItemAsync(`${k}.n`))
    if (!Number.isInteger(count) || count <= 0) return null
    const parts: string[] = []
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(`${k}.${i}`)
      if (part === null) return null
      parts.push(part)
    }
    return parts.join('')
  },
  async setItem(key, value) {
    const k = safe(key)
    await secureAuthStorage.removeItem(key)
    const count = Math.max(1, Math.ceil(value.length / CHUNK))
    for (let i = 0; i < count; i++) await SecureStore.setItemAsync(`${k}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK))
    await SecureStore.setItemAsync(`${k}.n`, String(count))
  },
  async removeItem(key) {
    const k = safe(key)
    const count = Number(await SecureStore.getItemAsync(`${k}.n`))
    if (Number.isInteger(count)) for (let i = 0; i < count; i++) await SecureStore.deleteItemAsync(`${k}.${i}`)
    await SecureStore.deleteItemAsync(`${k}.n`)
  },
}
