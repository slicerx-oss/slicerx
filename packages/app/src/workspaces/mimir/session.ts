// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir and its conversations: the mimir tab is the one place it runs. One runtime for the window; every event lands
// in a session log, which the read-back for clients serves, and the person's messages are kept beside it (the runtime
// logs only its own events). With a model set up (mimir cloud, a key or a local model, as in Settings > mimir) the tab
// runs it; with none, the scripted stub answers over the same tools, and the chat says so.
import { DEFAULT_POLICY, type CommandSpec, type Host, type LlmTransport, type MeshHandle, type MeshPart, type Pilot, type PilotConfig } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { designToolset } from '@slicerx/mcp/toolset'
import { createCombinedPlanner, createMemorySessionStore, createPilot, DEFAULT_CONFIG, isLocalModel, type CreatePilotOptions, type KnowledgeBase, type LlmClient, type PilotTool } from '@slicerx/pilot'
import { motionReduced } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { setSessionSource } from '../../app-link/sessions'
import { appDesignHost } from '../../cad/design-host'
import { listCommands, useCommands } from '../../commands/registry'
import { useEdition } from '../../edition'
import { projectExportHost } from '../../export/actions'
import { geom } from '../../geom/client'
import { useHost } from '../../host'
import { guardedPrinters } from '../../plate/guard'
import { useMimirCloudHost } from '../../pilot-connect/cloud'
import { pilotModel, pilotTransport } from '../../pilot-connect/llm'
import { slicePlate } from '../../state/actions'
import { hostSlices } from '../../state/model-mode'
import { get, useApp, type PilotPref } from '../../state/store'
import { setMimirLink, type MimirLink } from './connection'
import { bundledKb } from './kb'
import { appProject, pilotSlicer } from './project'
import { mimirTools, NO_APPROVALS, NO_PRINTERS, scriptRouter } from './scripted'
import { SCRIPTS } from './scripts'

export const mimirLogs = createMemorySessionStore()

/** The person's messages per session, in order. */
export const mimirMessages = new Map<string, { text: string; attachments: string[] }[]>()

/** What the tab's mimir runs on, for the read-back: the stub, or a model with its provider and models. */
export interface TabModel {
  link: Exclude<MimirLink, 'none'>
  provider: string
  model: string
  /** Auto's two models when the person chose Auto: huginn to start, muninn for pictures, many-step parts and sizes only the person knows. */
  auto?: { huginn: string; muninn: string }
  /** Whether the model runs on this computer (Ollama or LM Studio). */
  local?: boolean
}

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

let tools: PilotTool<never>[] = []
let current: { key: string; pilot: Pilot; model: TabModel } | null = null
let building: { key: string; done: Promise<Pilot> } | null = null

/** The tools the tab's mimir calls, for editing a built sheet's steps the same way. */
export function tabTools(): readonly PilotTool<never>[] {
  return tools
}

/** What the tab's mimir runs on now, or null before the tab first opens. */
export function tabModel(): TabModel | null {
  return current?.model ?? null
}

/**
 * `mimir.tab` over the app link: what answers in the tab (none before it first opens, scripted, or model), the model
 * and Auto's pair, whether it runs on this computer, and the tools the model is offered there (a local model gets a
 * shorter list). No key or token.
 */
export function tabState(): { link: MimirLink; provider: string | null; model: string | null; auto: { huginn: string; muninn: string } | null; local: boolean; tools: string[] } {
  if (!current) return { link: 'none', provider: null, model: null, auto: null, local: false, tools: [] }
  const m = current.model
  return { link: m.link, provider: m.provider, model: m.model, auto: m.auto ?? null, local: m.local === true, tools: current.pilot.tools().map((t) => t.name) }
}

/** The tab's tools: the questions, lookups and sheets, then the design tools on the plate. Made once per window. */
function toolsFor(loader: Loader): PilotTool<never>[] {
  if (tools.length === 0) tools = mimirTools(designToolset(appDesignHost(loader)))
  return tools
}

/** Commands that slice, print or change slicer settings, which a host that only models leaves out of mimir's tools. */
export function modelingCommands(commands: readonly CommandSpec[]): CommandSpec[] {
  return commands.filter((c) => c.section !== 'slice' && c.section !== 'printers' && c.section !== 'settings' && c.id !== 'mode-slice' && !c.id.startsWith('layer-'))
}

/**
 * The app's commands as mimir runs them: the same, except that a slice happens where mimir is, so the tab and its
 * conversation stay on screen. The slice waits in Slice, where the person opens it.
 */
export function mimirCommands(host: Host, commands: readonly CommandSpec[]): CommandSpec[] {
  return commands.map((c) =>
    c.id !== 'slice'
      ? c
      : {
          ...c,
          run: async () => {
            await slicePlate(host)
            const s = get().slice
            return s.status === 'done' ? { status: 'done', note: 'Sliced. The person sees the result in the Slice tab.' } : s.status === 'error' ? { status: 'error', message: s.message } : { status: s.status }
          },
        },
  )
}

/** The scripted stub's setup: a provider and model of its own, so nobody mistakes it for a model. */
const SCRIPTED_CONFIG: PilotConfig = { ...DEFAULT_CONFIG, provider: 'scripted', model: 'scripted' }
const NO_LLM = {} as LlmTransport

/**
 * What the tab's runtime is made from, for a model and for the scripted stub alike (only the client differs). Every
 * part is built with the design tools (no part generator), so each step lands in the timeline, beside the dimension
 * sheet, questions and lookups. Where the host slices, mimir also has the slicing, printer, settings, project and
 * report tools and the app's commands: its printer calls go through the same preflight and bed-clear card as the Print
 * button, approvals stay with the person, and mimir never starts a print on its own. The browser build only models,
 * so there it has the design, knowledge and project tools and says the desktop app slices. Auto starts a build on
 * huginn and moves to muninn for deep work, a picture or PDF, a part of many steps, or a size only the person knows.
 */
export function tabPilotOptions(host: Host, parts: { llm: LlmTransport; config: PilotConfig; kb: KnowledgeBase; tools: readonly PilotTool<never>[]; client?: LlmClient; share?: CreatePilotOptions['share']; commands?: readonly CommandSpec[] }): CreatePilotOptions {
  const slices = hostSlices()
  const commands = mimirCommands(host, parts.commands ?? listCommands())
  return {
    host: {
      printers: guardedPrinters(host) ?? host.printers ?? NO_PRINTERS,
      approvals: host.approvals ?? NO_APPROVALS,
      llm: parts.llm,
      slicer: pilotSlicer(host),
      // the same geometry engine as the object tools (cut, repair, hollow), in its worker
      geom: { run: (op: string, input: unknown, signal?: AbortSignal) => geom().call(op, input, signal) },
      projectExport: projectExportHost(host),
    },
    // a part takes many feature steps
    config: { ...parts.config, maxSteps: Math.max(parts.config.maxSteps, 40), maxToolCalls: Math.max(parts.config.maxToolCalls, 60) },
    ...(slices ? {} : { scope: 'cad' as const }),
    surface: 'tab',
    policy: DEFAULT_POLICY,
    commands: slices ? [...commands] : modelingCommands(commands),
    kb: parts.kb,
    planner: createCombinedPlanner(parts.kb),
    project: appProject(host),
    tools: [...parts.tools],
    store: mimirLogs,
    ...(parts.client ? { client: parts.client } : {}),
    ...(parts.share ? { share: parts.share } : {}),
  }
}

/** The stub: the same runtime and tools, answering with the scripts. Replies stream at a reading pace, at once under reduced motion. */
function scripted(host: Host, kb: KnowledgeBase): Pilot {
  const still = motionReduced()
  const client = scriptRouter(SCRIPTS, { delayMs: still ? 0 : 28, callDelayMs: still ? 0 : 350 })
  return createPilot(tabPilotOptions(host, { llm: NO_LLM, config: SCRIPTED_CONFIG, kb, tools: toolsFor(host.slicer), client }))
}

/** The app commands mimir has as tools, by id: they load after first paint, and mimir's app tools are made from them. */
function toolCommands(): string {
  return listCommands().flatMap((c) => (c.tool ? [c.id] : [])).sort().join(',')
}

/** A number per mimir cloud host, so signing in (a new host) makes the runtime again. */
const cloudIds = new WeakMap<object, number>()
let cloudSeq = 0
function cloudId(cloud: unknown): number {
  if (!cloud) return 0
  if (typeof cloud !== 'object') return -1
  let id = cloudIds.get(cloud)
  if (id === undefined) cloudIds.set(cloud, (id = ++cloudSeq))
  return id
}

/** The setup the tab would use now: what Settings > mimir chose, or the edition's own, the mimir cloud host and the app's commands. A change makes the runtime again. */
function setupKey(host: Host, edition: EditionConfig, pref: PilotPref | null, cloud: unknown): string {
  return JSON.stringify([edition.id, pref, cloudId(cloud), host.llm ? 1 : 0, toolCommands()])
}

/**
 * The tab's mimir for this setup, made on first use and again when the setup changes: a model when one is set up and
 * answers, the scripted stub otherwise. Sets the chat's link to match.
 */
export async function tabMimir(host: Host, edition: EditionConfig, cloud: unknown = null): Promise<Pilot> {
  const pref = get().pilot
  const key = setupKey(host, edition, pref, cloud)
  if (current?.key === key) return current.pilot
  if (building?.key === key) return building.done
  const done = (async (): Promise<Pilot> => {
    const loader = host.slicer
    const llm = pilotTransport(host)
    const chosen = llm ? pilotModel(edition, pref) : null
    // the default config's model pair is the ChatGPT plan's; any other provider runs only the models it chose
    const { models: planModels, ...rest } = DEFAULT_CONFIG
    const base0: PilotConfig = chosen ? { ...rest, ...(chosen.provider === 'openai' && planModels ? { models: planModels } : {}), ...chosen } : DEFAULT_CONFIG
    const billing = (llm as { billing?: () => Promise<'plan' | 'key' | null> } | null)?.billing?.().catch(() => null) ?? Promise.resolve(null)
    const [ok, paid, kb] = await Promise.all([chosen && llm ? llm.available(base0.provider).catch(() => false) : Promise.resolve(false), billing, bundledKb()])
    let made: { pilot: Pilot; model: TabModel }
    if (ok && llm && chosen) {
      // mimir cloud is billed per token like a key: one model for every turn
      const config: PilotConfig = base0.provider === 'mimir-cloud' ? { ...base0, billing: 'key' } : paid ? { ...base0, billing: paid } : base0
      // mimir cloud keeps the session only while the person allows it (Settings > mimir)
      const pilot = createPilot(tabPilotOptions(host, { llm, config, kb, tools: toolsFor(loader), share: () => ({ on: get().mimirShare, version: host.build.version }) }))
      const auto = config.auto && config.models?.huginn && config.models.muninn ? { huginn: config.models.huginn, muninn: config.models.muninn } : undefined
      made = { pilot, model: { link: 'model', provider: config.provider, model: config.model, ...(auto ? { auto } : {}), ...(isLocalModel(config) ? { local: true } : {}) } }
    } else {
      made = { pilot: scripted(host, kb), model: { link: 'scripted', provider: 'scripted', model: 'scripted' } }
    }
    // a newer setup may have started meanwhile; it wins
    if (building?.key === key) {
      current = { key, ...made }
      building = null
      setMimirLink(made.model.link)
    }
    return made.pilot
  })()
  building = { key, done }
  return done
}

/** The tab's mimir for the chat: null while it is set up, then the runtime; made again when Settings change the setup. */
export function useTabMimir(): Pilot | null {
  const host = useHost()
  const edition = useEdition()
  const cloud = useMimirCloudHost()
  const pref = useApp((s) => s.pilot)
  // the app's commands arriving (or changing) makes the runtime again with them
  const commands = useCommands()
  const [pilot, setPilot] = useState<Pilot | null>(() => (current?.key === setupKey(host, edition, get().pilot, cloud) ? current.pilot : null))
  useEffect(() => {
    let live = true
    void tabMimir(host, edition, cloud).then((p) => {
      if (live) setPilot(p)
    })
    return () => {
      live = false
    }
  }, [host, edition, cloud, pref, commands])
  // the tab's conversations are what clients read back while it is open
  useEffect(() => {
    setSessionSource({ store: mimirLogs, messages: (id) => mimirMessages.get(id) ?? [] })
    return () => setSessionSource(null)
  }, [])
  return pilot
}

export function newSessionId(): string {
  return `mimir_${Date.now().toString(36)}`
}

export function noteMessage(sessionId: string, text: string, attachments: readonly { name: string }[]): void {
  const list = mimirMessages.get(sessionId) ?? []
  list.push({ text, attachments: attachments.map((a) => a.name) })
  mimirMessages.set(sessionId, list)
}

/** For tests: forget the runtime, so the next use sets it up again. */
export function resetTabMimir(): void {
  current = null
  building = null
  tools = []
  setMimirLink('none')
}
