// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Magic links open the app at <scheme>://auth/callback?code=...; the provider finishes
// the PKCE sign-in and this route returns to the app.
import * as Linking from 'expo-linking'
import { router } from 'expo-router'
import { useEffect } from 'react'
import { usePocketHost } from '../../src/data/provider'

export default function AuthCallbackRoute() {
  const host = usePocketHost()
  const url = Linking.useLinkingURL()
  useEffect(() => {
    if (url) host.auth.deliver(url)
    router.replace('/')
  }, [url, host])
  return null
}
