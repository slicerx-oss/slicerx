// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scenarios for jobs that left mimir. Their scripts still name the calls
// a user flow makes, but they run here as plain app functions with no model:
// every call goes straight to runAppFunction (or, for a setup step such as
// slice, to the tool itself) against the same simulated fleet and project.
import { createCombinedPlanner } from '../src/kb/combined-planner'
import { runAppFunction, type FunctionResult } from '../src/functions'
import { createScriptedClient } from '../src/provider/scripted'
import { createShared } from '../src/shared'
import type { ToolContext, ToolHost } from '../src/tool'
import { builtinTools } from '../src/tools/index'
import { createAppFunctionTools } from '../skills/index'
import { createEvalEnv, createEvalSlicer } from './harness'
import type { Scenario } from './types'

const shared0 = createShared()
const PILOT_TOOLS = new Set(builtinTools({ planner: undefined, commands: [], shared: shared0 }).map((t) => t.name))
const FUNCTIONS = new Set(createAppFunctionTools(shared0).map((t) => t.name))

function calls(s: Scenario): { name: string; args: unknown }[] {
  return s.script.flatMap((step) => (typeof step === 'function' ? [] : (step.calls ?? []).map((c) => ({ name: c.name, args: c.args }))))
}

/** A scenario mimir still runs: every tool it expects or calls is in mimir's registry. */
export function isPilotScenario(s: Scenario): boolean {
  const names = [...(s.expect.tools ?? []), ...calls(s).map((c) => c.name)]
  return names.every((n) => PILOT_TOOLS.has(n) || n.includes('.'))
}

/** Scenarios whose point is a refusal (no geometry host, nothing to read). */
export const EXPECTED_REFUSALS = new Set<string>(['skill-mesh-repair-no-geometry'])

export interface FunctionRun {
  name: string
  result: FunctionResult
}

/**
 * Runs a scenario's scripted calls as the app would: app functions through
 * runAppFunction, setup tools (slice, printer reads) directly. Approval-gated
 * tools are skipped; nothing here can reach a printer.
 */
export async function runFunctionScenario(s: Scenario): Promise<FunctionRun[]> {
  const env = createEvalEnv({ client: createScriptedClient([]), machine: s.machine, objects: s.objects, ...(s.fleet ? { fleet: s.fleet } : {}), ...(s.hosts ? { hosts: s.hosts } : {}) })
  const host: ToolHost = {
    printers: env.sim,
    slicer: createEvalSlicer(() => env.project),
    ...(s.hosts ? s.hosts({ broker: env.broker, audit: env.audit }) : {}),
  }
  const shared = createShared()
  for (const [id, rate] of Object.entries({ 'bay-1': 0.34, 'bay-2': 0.21, 'bay-3': 0.18, 'bay-4': 0.26, 'bay-5': 0.3 })) shared.machineRates.set(id, rate)
  const context = { project: 'eval', machine: s.machine, objects: s.objects.map((o) => ({ id: o.id, name: o.name, bboxMm: o.bboxMm })) }
  const fnEnv = { host, project: env.project, context, shared, kb: env.kb, today: '2026-09-30' }
  const setup = new Map(builtinTools({ planner: createCombinedPlanner(env.kb), commands: [], shared }).map((t) => [t.name, t]))
  const out: FunctionRun[] = []
  for (const c of calls(s)) {
    if (FUNCTIONS.has(c.name)) {
      out.push({ name: c.name, result: await runAppFunction(c.name, c.args, fnEnv) })
      continue
    }
    const tool = setup.get(c.name)
    if (!tool || (tool.permission !== 'read' && tool.permission !== 'slice')) continue
    const ctx: ToolContext = { host, sessionId: 'fn', callId: c.name, signal: new AbortController().signal, context, today: '2026-09-30', kb: env.kb, project: env.project, progress: () => {} }
    const parsed = tool.input.safeParse(c.args ?? {})
    if (parsed.success) await tool.run(parsed.data as never, ctx)
  }
  return out
}
