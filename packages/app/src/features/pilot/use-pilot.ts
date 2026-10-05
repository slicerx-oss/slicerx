// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Pilot built on this host and the same tool registry the command bar uses. Without a model
// provider it runs the built-in demo model, so the panel still works.
import { DEFAULT_POLICY, type ApprovalHost, type Host, type LlmTransport, type Pilot, type PilotConfig, type PrinterHost } from '@slicerx/contracts'
import { createCombinedPlanner, createDemoClient, createPilot, DEFAULT_CONFIG, type CreatePilotOptions, type KnowledgeBase } from '@slicerx/pilot'
import { useEffect, useState } from 'react'
import { listCommands } from '../../commands/registry'
import { useEdition } from '../../edition'
import { useHost } from '../../host'
import { projectExportHost } from '../../export/actions'
import { geom } from '../../geom/client'
import { guardedPrinters } from '../../plate/guard'
import { pilotModel, pilotTransport } from '../../pilot-connect/llm'
import { get } from '../../state/store'
import { bundledKb } from './kb'
import { appProject, pilotSlicer } from './project'

/**
 * What the docked Pilot runs with. Its printer calls go through the same preflight and bed-clear card as the Print
 * button. Its skills work on the open project and plan settings with the same planner as MCP; approvals stay with
 * the person, and each tool call is one undo step.
 */
export function dockPilotOptions(host: Host, parts: { printers: PrinterHost; llm: LlmTransport; approvals: ApprovalHost; config: PilotConfig; kb: KnowledgeBase }): CreatePilotOptions {
  const project = appProject(host)
  // The same geometry engine as the object tools (cut, repair, hollow), in its worker.
  const shapes = { run: (op: string, input: unknown, signal?: AbortSignal) => geom().call(op, input, signal) }
  const { printers, llm, approvals, config, kb } = parts
  return {
    host: { printers: guardedPrinters(host) ?? printers, slicer: pilotSlicer(host), geom: shapes, llm, approvals, projectExport: projectExportHost(host) },
    config,
    policy: DEFAULT_POLICY,
    commands: [...listCommands()],
    kb,
    planner: createCombinedPlanner(kb),
    project,
  }
}

export function usePilot(): Pilot | null {
  const host = useHost()
  const edition = useEdition()
  const [pilot, setPilot] = useState<Pilot | null>(null)
  useEffect(() => {
    const { printers, approvals } = host
    // The connection from Settings (or the host's own); the edition's default otherwise.
    const llm = pilotTransport(host)
    if (!printers || !llm || !approvals) return
    let live = true
    const chosen = pilotModel(edition, get().pilot)
    const base0 = chosen ? { ...DEFAULT_CONFIG, ...chosen } : DEFAULT_CONFIG
    // Who pays decides the models: the ChatGPT plan uses huginn and muninn, an API key one model.
    const billing = (llm as { billing?: () => Promise<'plan' | 'key' | null> }).billing?.().catch(() => null) ?? Promise.resolve(null)
    // The guides ship with the app; the demo model cites them too.
    void Promise.all([chosen ? llm.available(base0.provider).catch(() => false) : Promise.resolve(false), billing, bundledKb()]).then(([ok, paid, kb]) => {
      if (!live) return
      const config = paid ? { ...base0, billing: paid } : base0
      const base = dockPilotOptions(host, { printers, llm, approvals, config, kb })
      setPilot(createPilot(ok ? base : { ...base, client: createDemoClient() }))
    })
    return () => {
      live = false
    }
  }, [host, edition])
  return pilot
}
