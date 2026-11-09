// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Feature `pilot`: mimir's commands and the Cmd+K handoff of free text, which open the mimir tab (the tab itself is
// part of the plate workspace, workspaces/mimir). Entry point @slicerx/app/features/pilot.
import type { AppFeature, CommandSpec, Host } from '@slicerx/contracts'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { set, setModelMode } from '../../state/store'

const openMimir = (): void => setModelMode('mimir')

/** Opens the mimir tab with the words as the person's next message. */
function ask(prompt: string): void {
  openMimir()
  set({ pilotPrompt: prompt })
}

/** True while the printers are the in-memory demo fleet; read each time, since a connected bridge replaces it. */
const onDemoFleet = (host: Host) => (): boolean => host.capabilities?.printers === 'sim'

/** Example prompts about the in-memory demo fleet. They only make sense there, so a real install never lists them. */
const demoFleetCommands = (host: Host): CommandSpec[] => [
  {
    id: 'pilot-bay-planning',
    title: `${ASSISTANT_NAME}: plan 12 strong PETG brackets by Friday`,
    section: 'pilot',
    enabled: onDemoFleet(host),
    keywords: ['demo', 'brackets', 'batch', 'plan', 'cheapest printers'],
    run: () => ask('Plan 12 strong PETG brackets by Friday'),
  },
  {
    id: 'pilot-diagnose',
    title: `${ASSISTANT_NAME}: diagnose the failed print on Bay 4`,
    section: 'pilot',
    enabled: onDemoFleet(host),
    keywords: ['layer shift', 'failure', 'why'],
    run: () => ask('Diagnose the Bay 4 failure'),
  },
]

export const pilotFeature: AppFeature = {
  id: 'pilot',
  requires: ['llm', 'approvals', 'printers'],
  commands: (host) => [
    {
      id: 'pilot-ask',
      title: `Ask ${ASSISTANT_NAME}`,
      section: 'pilot',
      keywords: ['agent', 'ai', 'plan', 'question', 'assistant', 'printpilot', 'mimir'],
      shortcut: 'Mod+/',
      run: (input) => {
        if (typeof input === 'string' && input.trim()) ask(input.trim())
        else openMimir()
      },
    },
    ...demoFleetCommands(host),
  ],
}
