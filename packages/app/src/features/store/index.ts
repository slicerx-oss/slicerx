// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Feature `store`: the model Library workspace and the Account settings. Entry
// point @slicerx/app/features/store; only app entries import it.
import type { AppFeature, CommandSpec } from '@slicerx/contracts'
import { setWorkspace } from '@slicerx/app'
import { setLibraryFilter, type LibrarySort } from './filter'

const SORTS: [LibrarySort, string, string[]][] = [
  ['new', 'Show the newest models', ['latest', 'recent']],
  ['popular', 'Show the most printed models', ['popular', 'makes', 'trending']],
]

export const storeFeature: AppFeature = {
  id: 'store',
  requires: ['store'],
  workspaces: [{ id: 'feed', label: 'Library', icon: 'feed', load: () => import('./library').then((m) => ({ default: m.Library })) }],
  settings: [{ id: 'account', label: 'Account', icon: 'creator', load: () => import('./account') }],
  commands: (): CommandSpec[] =>
    SORTS.map(([sort, title, keywords]) => ({
      id: `library-${sort}`,
      title,
      section: 'library',
      keywords: ['library', 'models', ...keywords],
      workspace: 'feed',
      tool: { permission: 'read' },
      run: () => {
        setWorkspace('feed')
        setLibraryFilter({ sort })
      },
    })),
}
