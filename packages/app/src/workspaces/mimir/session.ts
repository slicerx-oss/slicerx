// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir and its conversations: the mimir tab is the one place it runs. One runtime for the window; every event lands
// in a session log, which the read-back for clients serves, and the person's messages are kept beside it (the runtime
// logs only its own events). With a model set up (mimir cloud, a key or a local model, as in Settings > mimir) the tab
// runs it; with none, the scripted stub answers over the same tools, and the chat says so.
import { DEFAULT_POLICY, type CommandSpec, type Host, type LlmTransport, type MeshHandle, type MeshPart, type Pilot, type PilotConfig } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { designToolset, nozzleOr } from '@slicerx/mcp/toolset'
import { createCombinedPlanner, createMemorySessionStore, createPilot, DEFAULT_CONFIG, isLocalModel, sliceFigures, whereNotesGo, type CommandToolContext, type CreatePilotOptions, type KnowledgeBase, type LlmClient, type NotesWhere, type PilotTool } from '@slicerx/pilot'
import { motionReduced } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { setSessionSource } from '../../app-link/sessions'
import { appDesignHost } from '../../cad/design-host'
import { commandsLoaded, commandsLoading, getCommand, isEnabled, listCommands, useCommands } from '../../commands/registry'
import { useEdition } from '../../edition'
import { projectExportHost } from '../../export/actions'
import { geom } from '../../geom/client'
import { useHost } from '../../host'
import { guardedPrinters } from '../../plate/guard'
import { sendLedger } from '../../plate/send-ledger'
import { useMimirCloudHost } from '../../pilot-connect/cloud'
import { editionToolGroups, withBrain } from '../../pilot-connect/brain'
import { chatNotesGo, pilotMemory, useMemoryAccount } from '../../pilot-connect/memory'
import { pilotModel, pilotTransport } from '../../pilot-connect/llm'
import { isStandInLlm } from '../../pilot-connect/stand-in-llm'
import { slicePlate } from '../../state/actions'
import { plateSliceConfig } from '../../state/slice-plate'
import { hostSlices } from '../../state/model-mode'
import { get, useApp, type PilotPref } from '../../state/store'
import { setMimirLink, type MimirLink } from './connection'
import { bundledKb } from './kb'
import { withPlanTies } from './plan-tool'
import { mimirPlans } from './plans'
import { answersReachTheirRun, forgetReplaced, retire } from './answers'
import { appPrintRun } from './print-run'
import { appProject, pilotSlicer } from './project'
import { mimirTools, NO_APPROVALS, NO_PRINTERS, SCRIPTED_TIERS, scriptRouter } from './scripted'
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
  /** Whether it is a local model (a server the person runs, such as Ollama or LM Studio), which gets the shorter tool list. */
  local?: boolean
  /** Where the model's server is, by its address (whereNotesGo): this computer, the person's network, or elsewhere. */
  where?: NotesWhere
}

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

let tools: PilotTool<never>[] = []
let current: { key: string; pilot: Pilot & { forgetRun?(sessionId: string): void }; model: TabModel } | null = null
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
 * and Auto's pair, whether it is a local model, where the model's server is (this computer, the person's network, or
 * elsewhere; null without a model), and the tools the model is offered there (a local model gets a shorter list). No
 * key or token.
 */
export function tabState(): { link: MimirLink; provider: string | null; model: string | null; auto: { huginn: string; muninn: string } | null; local: boolean; where: NotesWhere | null; tools: string[] } {
  if (!current) return { link: 'none', provider: null, model: null, auto: null, local: false, where: null, tools: [] }
  const m = current.model
  return { link: m.link, provider: m.provider, model: m.model, auto: m.auto ?? null, local: m.local === true, where: m.where ?? null, tools: current.pilot.tools().map((t) => t.name) }
}

/** The tab's tools: the questions, lookups and sheets, then the design tools on the plate. Made once per window. */
function toolsFor(loader: Loader): PilotTool<never>[] {
  // design.check reads the tab's plans, and holds walls to the nozzle the printer has now (0.4 mm when that is not a
  // positive size). The card's design.plan puts its plans in the same registry, and the part built after an approved
  // plan ties to it (withPlanTies), so design.check checks that design. The toolset's design.put_plan (for MCP clients)
  // is left out of the tab (mimirTools).
  if (tools.length === 0) tools = withPlanTies(mimirTools(designToolset(appDesignHost(loader), {}, { plans: mimirPlans, nozzleMm: () => nozzleOr(get().profile?.nozzle), cardSide: true })))
  return tools
}

/** Commands that slice, print or change slicer settings, which a host that only models leaves out of mimir's tools. */
export function modelingCommands(commands: readonly CommandSpec[]): CommandSpec[] {
  return commands.filter((c) => c.section !== 'slice' && c.section !== 'printers' && c.section !== 'settings' && c.id !== 'mode-slice' && !c.id.startsWith('layer-'))
}

/**
 * The app's commands as mimir runs them: the same, except that a slice happens where mimir is, so the tab and its
 * conversation stay on screen. The slice replies with its time, filament, cost and warnings, and records them in the
 * chat's print run, which shows them on the slice card.
 */
/** app.slice's reply when no slice ran and the one on screen no longer matches the plate. */
export const STALE_REPLY = 'The slice on screen is out of date because the plate changed after it. Slice the plate again.'

/** What mimir's tool for a command is made from: id, title, section, workspace, permission and input schema. */
function commandSignature(c: CommandSpec): string {
  return JSON.stringify([c.id, c.title, c.section, c.workspace ?? null, c.tool?.permission ?? null, c.tool?.inputSchema ?? null])
}

/** app.<id>'s reply when the command it was made from changed or went away since: it did not run. */
export const GONE_REPLY = 'This command changed or is gone since mimir started, so it did not run.'

/**
 * The registered commands, each running the command registered under its id when it runs: the same commands
 * registering again (a layout change brings the built-in ones back) keep the runtime, which then calls the new ones.
 * Only a command the same as the one the tool was made from runs: a changed one, one gone, or one turned off is
 * refused (a runtime that was replaced may still have a card waiting to run it).
 */
export function liveCommands(commands: readonly CommandSpec[] = listCommands()): CommandSpec[] {
  return commands.map((c) => {
    const made = commandSignature(c)
    return {
      ...c,
      run: (input?: unknown, cx?: CommandToolContext) => {
        const live = getCommand(c.id)
        if (!live || commandSignature(live) !== made) return { status: 'error', message: GONE_REPLY }
        if (!isEnabled(live)) return { status: 'error', message: `${live.title} is not available right now.` }
        return (live.run as (input: unknown, cx?: CommandToolContext) => unknown)(input, cx)
      },
    }
  })
}

export function mimirCommands(host: Host, commands: readonly CommandSpec[]): CommandSpec[] {
  return commands.map((c) =>
    c.id !== 'slice'
      ? c
      : {
          ...c,
          run: async (_input?: unknown, cx?: CommandToolContext) => {
            // the plate and its fingerprint are read before slicing, so an edit made while the slice runs leaves it stale
            const before = get()
            const plate = Math.max(1, before.plates.findIndex((p) => p.id === before.activePlate) + 1)
            const fingerprint = cx?.run?.fingerprint(plate)
            await slicePlate(host)
            const after = get()
            const s = after.slice
            if (s.status === 'error') {
              // the engine refused: no slice for this plate is recorded or kept, so none can be sent
              cx?.refused?.(plate)
              return { status: 'error', message: s.message }
            }
            if (s.status !== 'done') return { status: s.status }
            // a slice that did not run leaves the last one, which an edit since has made stale: it is not this plate's
            if (s.stale) return { status: 'stale', message: STALE_REPLY }
            const r = s.result
            const figures = sliceFigures(r)
            // only a slice this call made is recorded: when none ran (a host that cannot slice), the one on screen was
            // recorded by whatever made it, and recording it again would stamp it with this moment's plate
            const made = after.slicesDone > before.slicesDone
            if (made && cx?.run && fingerprint !== undefined) cx.run.update({ plate, slice: { sliceId: r.id, plate, at: new Date().toISOString(), ...figures, fingerprint, stale: false } })
            // printer.queue sends the runtime's slice of the plate, so this slice replaces any older one there
            if (made) cx?.sliced?.(plate, r, plateSliceConfig(before, before.plates.find((p) => p.id === before.activePlate)))
            return { status: 'done', sliceId: r.id, ...figures }
          },
        },
  )
}

/**
 * The scripted stub's setup: a provider and model of its own, so nobody mistakes it for a model. Its tiers are the stub
 * too, so a deep turn never names a model.
 */
const SCRIPTED_CONFIG: PilotConfig = { ...DEFAULT_CONFIG, provider: 'scripted', model: 'scripted', models: SCRIPTED_TIERS }
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
export function tabPilotOptions(host: Host, parts: { llm: LlmTransport; config: PilotConfig; kb: KnowledgeBase; tools: readonly PilotTool<never>[]; client?: LlmClient; share?: CreatePilotOptions['share']; commands?: readonly CommandSpec[]; memory?: CreatePilotOptions['memory']; toolGroups?: CreatePilotOptions['toolGroups'] }): CreatePilotOptions {
  const slices = hostSlices()
  const commands = mimirCommands(host, parts.commands ?? liveCommands())
  return {
    host: {
      printers: guardedPrinters(host, { ledger: sendLedger }) ?? host.printers ?? NO_PRINTERS,
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
    printRun: appPrintRun(host),
    ...(parts.client ? { client: parts.client } : {}),
    ...(parts.share ? { share: parts.share } : {}),
    ...(parts.memory ? { memory: parts.memory } : {}),
    ...(parts.toolGroups ? { toolGroups: parts.toolGroups } : {}),
  }
}

/**
 * The stub: the same runtime and tools, answering with the scripts, with the edition's tool groups and the person's
 * notes (which stay on this computer). Replies stream at a reading pace, at once under reduced motion.
 */
function scripted(host: Host, kb: KnowledgeBase, edition: EditionConfig): Pilot {
  const still = motionReduced()
  const client = scriptRouter(SCRIPTS, { delayMs: still ? 0 : 28, callDelayMs: still ? 0 : 350 })
  return createPilot(tabPilotOptions(host, { llm: NO_LLM, config: SCRIPTED_CONFIG, kb, tools: toolsFor(host.slicer), client, memory: pilotMemory(edition, { where: chatNotesGo(SCRIPTED_CONFIG, false) }), toolGroups: editionToolGroups(edition) }))
}

/**
 * The app commands mimir has as tools, as it sees them: id, title, section, workspace, permission and input schema, in
 * id order (mimir's app tools are made from these). The same commands registering again give the same signature; a
 * changed one, or one more or fewer, gives a new one.
 */
function toolCommands(): string {
  const seen = hostSlices() ? listCommands() : modelingCommands(listCommands())
  const rows = seen.flatMap((c) => (c.tool ? [{ id: c.id, sig: commandSignature(c) }] : []))
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return JSON.stringify(rows.map((r) => r.sig))
}

/** Which transport the host offers mimir: none, the browser build's stand-in, or its own; and whether it has secure storage (pairing brings it). */
function transportOf(host: Host): [number, number] {
  return [host.llm ? (isStandInLlm(host.llm) ? 2 : 1) : 0, host.capabilities.secureStorage ? 1 : 0]
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

/** How long the tab waits for commands on their way before it makes the runtime without them. */
export const COMMANDS_WAIT_MS = 3000

/** Commands on their way landing, or COMMANDS_WAIT_MS passing (an import that never settles, such as a stalled fetch). */
function commandsLanded(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, COMMANDS_WAIT_MS)
  })
  return Promise.race([commandsLoaded(), late]).finally(() => clearTimeout(timer))
}

/**
 * The setup the tab would use now: what Settings > mimir chose, or the edition's own, the mimir cloud host, the host's
 * transport, whether the host slices, the app commands mimir has as tools (by what they are, not which objects they
 * are) and whether the edition keeps notes (ai.brain.memory.local). A change makes the runtime again.
 */
function setupKey(host: Host, edition: EditionConfig, pref: PilotPref | null, cloud: unknown): string {
  return JSON.stringify([edition.id, pref, cloudId(cloud), transportOf(host), hostSlices(), toolCommands(), edition.ai.brain.memory.local])
}

/**
 * The tab's mimir for this setup, made on first use and again when the setup changes: a model when one is set up and
 * answers, the scripted stub otherwise. Sets the chat's link to match.
 */
export async function tabMimir(host: Host, edition: EditionConfig, cloud: unknown = null): Promise<Pilot> {
  // commands on their way (a layout change takes the built-in ones away until they load again): the setup is read once
  // they land, so the gap never makes a runtime of its own
  if (commandsLoading()) await commandsLanded()
  const pref = get().pilot
  const key = setupKey(host, edition, pref, cloud)
  if (current?.key === key) {
    // the setup came back to the runtime there is (the commands went away and came back): a build for the setup in
    // between is no longer wanted, so it never replaces this one
    building = null
    return current.pilot
  }
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
      // the edition's brain pack: no web search when its web tools are off, and its models for the person's own key
      const config: PilotConfig = withBrain(base0.provider === 'mimir-cloud' ? { ...base0, billing: 'key' } : paid ? { ...base0, billing: paid } : base0, edition)
      // mimir cloud keeps the session only while the person allows it (Settings > mimir). The person's notes go through
      // the app's one memory handle (the app link and Settings > Memory share it): the tab reads them, and saving one
      // asks first with the memory chip, answered through the app's approvals.
      const pilot = createPilot(tabPilotOptions(host, { llm, config, kb, tools: toolsFor(loader), share: () => ({ on: get().mimirShare, version: host.build.version }), memory: pilotMemory(edition, { where: chatNotesGo(config, true) }), toolGroups: editionToolGroups(edition) }))
      const auto = config.auto && config.models?.huginn && config.models.muninn ? { huginn: config.models.huginn, muninn: config.models.muninn } : undefined
      made = { pilot, model: { link: 'model', provider: config.provider, model: config.model, ...(auto ? { auto } : {}), ...(isLocalModel(config) ? { local: true } : {}), where: whereNotesGo(config) } }
    } else {
      made = { pilot: scripted(host, kb, edition), model: { link: 'scripted', provider: 'scripted', model: 'scripted' } }
    }
    // a newer setup may have started meanwhile; it wins
    if (building?.key === key) {
      // a run going on the runtime this replaces keeps waiting there; the chat's answers reach it through the new one
      if (current) retire(current.pilot)
      answersReachTheirRun(made.pilot)
      current = { key, ...made }
      building = null
      setMimirLink(made.model.link)
      return made.pilot
    }
    // a build no longer wanted: whoever waited on it gets the runtime there is
    return current?.pilot ?? made.pilot
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
  // the account notes sync with, when this host has one
  useMemoryAccount()
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
    setSessionSource({ store: mimirLogs, messages: (id) => mimirMessages.get(id) ?? [], run: (id) => current?.pilot.printRun?.(id) ?? null })
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

/**
 * Starts a new conversation: the old chat is over, so its print run is dropped. A print it started is still watched to
 * its end, and the end line goes to the old chat's log. Returns the new chat's id.
 */
export function startNewChat(oldSessionId: string): string {
  current?.pilot.forgetRun?.(oldSessionId)
  return newSessionId()
}

/** For tests: forget the runtime, so the next use sets it up again. */
export function resetTabMimir(): void {
  forgetReplaced()
  current = null
  building = null
  tools = []
  setMimirLink('none')
}
