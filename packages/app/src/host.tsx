// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { Host } from '@slicerx/contracts'
import { createContext, useContext } from 'react'

export const HostContext = createContext<Host | null>(null)

/** The platform host (web or desktop) the app was mounted with. */
export function useHost(): Host {
  const host = useContext(HostContext)
  if (!host) throw new Error('useHost() needs <SlicerXApp host={...}> above it')
  return host
}

