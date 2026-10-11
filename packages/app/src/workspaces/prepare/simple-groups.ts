// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// In Simple, a control that writes several keys is one setting: badges count its keys once.
import { useMemo } from 'react'
import { effectiveMode, useLayout } from '../../first-run/look'
import { easyGroups } from '../../plate/easy-groups'
import { useApp } from '../../state/store'

export function useSimpleGroups(): string[][] {
  const simple = effectiveMode(useApp((s) => s.settingsMode), useLayout()) === 'simple'
  const easy = useApp((s) => s.easy)
  return useMemo(() => (simple ? Object.values(easyGroups(easy)) : []), [simple, easy])
}
