// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { router } from 'expo-router'
import { usePairing } from '../src/pair'
import { PairingScreen } from '../src/screens/pairing-screen'

export default function PairRoute() {
  const pairing = usePairing()
  return <PairingScreen {...pairing} onBack={() => router.back()} />
}
