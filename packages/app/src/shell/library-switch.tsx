// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Community and Mine are two views of one Library tab, so the tab bar has one Library entry.
import { Seg } from '@slicerx/ui'
import { useFeatures } from '../features'
import { setWorkspace, useApp } from '../state/store'

export function LibrarySwitch() {
  const ws = useApp((s) => s.workspace)
  const { workspaces } = useFeatures()
  // Without the community library there is only My models, and nothing to switch.
  if (!workspaces.some((w) => w.id === 'feed')) return null
  return (
    <Seg<'feed' | 'library'>
      label="Vault"
      size="sm"
      value={ws === 'library' ? 'library' : 'feed'}
      onChange={(v) => setWorkspace(v)}
      options={[
        { value: 'feed', label: 'Community' },
        { value: 'library', label: 'Mine' },
      ]}
    />
  )
}
