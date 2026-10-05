// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Feature `pilot`: the assistant's docked panel and the Cmd+K handoff of free text.
// Entry point @slicerx/app/features/pilot.
import type { AppFeature } from '@slicerx/contracts'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { set } from '../../state/store'
import { openDock } from './dock-state'

function ask(prompt: string): void {
  openDock()
  set({ pilotPrompt: prompt })
}

export const pilotFeature: AppFeature = {
  id: 'pilot',
  requires: ['llm', 'approvals', 'printers'],
  commands: () => [
    {
      id: 'pilot-ask',
      title: `Ask ${ASSISTANT_NAME}`,
      section: 'pilot',
      keywords: ['agent', 'ai', 'plan', 'question', 'assistant', 'printpilot', 'mimir'],
      shortcut: 'Mod+/',
      run: (input) => {
        if (typeof input === 'string' && input.trim()) ask(input.trim())
        else openDock()
      },
    },
    {
      id: 'pilot-bay-planning',
      title: `${ASSISTANT_NAME}: plan 12 strong PETG brackets by Friday`,
      section: 'pilot',
      keywords: ['demo', 'brackets', 'batch', 'plan', 'cheapest printers'],
      run: () => ask('Plan 12 strong PETG brackets by Friday'),
    },
    {
      id: 'pilot-diagnose',
      title: `${ASSISTANT_NAME}: diagnose the failed print on Bay 4`,
      section: 'pilot',
      keywords: ['layer shift', 'failure', 'why'],
      run: () => ask('Diagnose the Bay 4 failure'),
    },
  ],
}
