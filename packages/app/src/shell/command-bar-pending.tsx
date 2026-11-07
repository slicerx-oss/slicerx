// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The command bar's stand-in while its code downloads: Cmd+K shows a palette with a focused input in the same frame,
// and what is typed (and an Enter) goes to the draft the real bar takes over. It lists nothing, so there is nothing
// for an Enter to run until the real bar is there.
import { CommandPalette } from '@slicerx/ui'
import { useApp } from '../state/store'
import { closeCommandBar, commandPlaceholder, queueCommandSubmit, setCommandQuery, useCommandQuery } from './command-draft'

const none: never[] = []

export function CommandBarPending() {
  const open = useApp((s) => s.commandOpen)
  const query = useCommandQuery()
  return (
    <CommandPalette
      open={open}
      onClose={closeCommandBar}
      query={query}
      onQueryChange={setCommandQuery}
      groups={none}
      placeholder={commandPlaceholder()}
      empty="Loading commands"
      onSelect={() => undefined}
      onSubmitEmpty={queueCommandSubmit}
    />
  )
}
