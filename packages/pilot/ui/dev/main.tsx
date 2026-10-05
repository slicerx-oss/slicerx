// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Dev harness for the mimir surface: the real runtime, fleet-sim, the approval
// broker and the eval slicer, driven by a replay script. Run from
// packages/pilot with `npx vite ui/dev`. Not shipped.
import '@slicerx/ui/styles.css'
import '../pilot.css'
import { createRoot } from 'react-dom/client'
import { createEvalEnv } from '../../evals/harness'
import { SCENARIOS } from '../../evals/scenarios'
import { SKILL_INFO } from '../../skills/index'
import { createScriptedClient } from '../../src/provider/scripted'
import { PilotWorkspace } from '../index'

const params = new URLSearchParams(location.search)
const id = params.get('scenario') ?? 'bay-planning'
const scenario = SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]
if (!scenario) throw new Error('no scenarios')
const envOpts: Parameters<typeof createEvalEnv>[0] = {
  client: createScriptedClient(scenario.script, { delayMs: Number(params.get('delay') ?? 28), callDelayMs: 350 }),
  machine: scenario.machine,
  objects: scenario.objects,
  realClock: true,
}
if (scenario.fleet) envOpts.fleet = scenario.fleet
if (scenario.policy) envOpts.policy = scenario.policy
const env = createEvalEnv(envOpts)

const root = document.getElementById('root')
if (root) {
  root.className = 'sx-app'
  createRoot(root).render(
    <PilotWorkspace
      pilot={env.pilot}
      sessionId={`dev-${scenario.id}`}
      context={{ project: 'dev', machine: scenario.machine }}
      skills={SKILL_INFO}
      onPolicyChange={(p) => env.pilot.setPolicy(p)}
    />,
  )
}
