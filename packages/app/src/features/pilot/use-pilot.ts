// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Pilot built on this host and the same tool registry the command bar uses. Without a model
// provider it runs the built-in demo model, so the panel still works.
import { DEFAULT_POLICY, type ApprovalHost, type CommandSpec, type Host, type LlmTransport, type Pilot, type PilotConfig, type PrinterHost } from '@slicerx/contracts'
import { createCombinedPlanner, createDemoClient, createPilot, DEFAULT_CONFIG, type CreatePilotOptions, type KnowledgeBase } from '@slicerx/pilot'
import { useEffect, useState } from 'react'
import { listCommands } from '../../commands/registry'
import { useEdition } from '../../edition'
import { useHost } from '../../host'
import { projectExportHost } from '../../export/actions'
import { geom } from '../../geom/client'
import { guardedPrinters } from '../../plate/guard'
import { useMimirCloudHost } from '../../pilot-connect/cloud'
import { pilotModel, pilotTransport } from '../../pilot-connect/llm'
import { hostSlices } from '../../state/model-mode'
import { get } from '../../state/store'
import { dockPilot, setDockPilot } from './dock-model'
import { bundledKb } from './kb'
import { dockLogs } from './dock-log'
import { appProject, pilotSlicer } from './project'

/** Commands that slice, print or change slicer settings, which a host that only models leaves out of mimir's tools. */
export function modelingCommands(commands: readonly CommandSpec[]): CommandSpec[] {
  return commands.filter((c) => c.section !== 'slice' && c.section !== 'printers' && c.section !== 'settings' && c.id !== 'mode-slice' && !c.id.startsWith('layer-'))
}

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
  // the browser build only models: mimir there has the part and knowledge tools, no printers, and says so
  const slices = hostSlices()
  return {
    host: { printers: guardedPrinters(host) ?? printers, slicer: pilotSlicer(host), geom: shapes, llm, approvals, projectExport: projectExportHost(host) },
    config,
    // a local model in the dock gets the dock's own tools (@slicerx/pilot surfaces)
    surface: 'dock',
    policy: DEFAULT_POLICY,
    // every event is logged, for the read-back over the app link (mimir.session)
    store: dockLogs,
    commands: slices ? [...listCommands()] : modelingCommands(listCommands()),
    ...(slices ? {} : { scope: 'cad' as const }),
    kb,
    planner: createCombinedPlanner(kb),
    project,
    // mimir cloud keeps the session only while the person allows it (Settings > mimir)
    share: () => ({ on: get().mimirShare, version: host.build.version }),
  }
}

export function usePilot(): Pilot | null {
  const host = useHost()
  const edition = useEdition()
  // a new mimir cloud host (the browser build, on sign-in or sign-out) makes the runtime again
  const cloud = useMimirCloudHost()
  const [pilot, setPilot] = useState<Pilot | null>(null)
  useEffect(() => {
    const { printers, approvals } = host
    // The connection from Settings (or the host's own); the edition's default otherwise.
    const llm = pilotTransport(host)
    if (!printers || !llm || !approvals) return
    let live = true
    let mine: Pilot | null = null
    const chosen = pilotModel(edition, get().pilot)
    const base0 = chosen ? { ...DEFAULT_CONFIG, ...chosen } : DEFAULT_CONFIG
    // Who pays decides the models: the ChatGPT plan uses huginn and muninn, an API key one model.
    const billing = (llm as { billing?: () => Promise<'plan' | 'key' | null> }).billing?.().catch(() => null) ?? Promise.resolve(null)
    // The guides ship with the app; the demo model cites them too.
    void Promise.all([chosen ? llm.available(base0.provider).catch(() => false) : Promise.resolve(false), billing, bundledKb()]).then(([ok, paid, kb]) => {
      if (!live) return
      // mimir cloud is billed per token like a key: one model for every turn
      const config = base0.provider === 'mimir-cloud' ? { ...base0, billing: 'key' as const } : paid ? { ...base0, billing: paid } : base0
      const base = dockPilotOptions(host, { printers, llm, approvals, config, kb })
      const made = createPilot(ok ? base : { ...base, client: createDemoClient() })
      // clients read back what answers here and the tools its model is offered (mimir.dock)
      setDockPilot({ pilot: made, link: ok ? 'model' : 'demo', config })
      mine = made
      setPilot(made)
    })
    return () => {
      live = false
      if (mine && dockPilot() === mine) setDockPilot(null)
    }
  }, [host, edition, cloud])
  return pilot
}
