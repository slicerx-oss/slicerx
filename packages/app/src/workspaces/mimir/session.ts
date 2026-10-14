// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tab's mimir and its conversations. One runtime for the window; every event lands in a session log, which the
// read-back for clients serves, and the person's messages are kept beside it (the runtime logs only its own events).
// With a model set up (mimir cloud, a key or a local model, as in Settings > mimir) the tab runs it over the design
// tools; with none, the scripted stub answers, and the chat says so.
import type { Host, LlmTransport, MeshHandle, MeshPart, Pilot, PilotConfig } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { designToolset } from '@slicerx/mcp/toolset'
import { createMemorySessionStore, createPilot, DEFAULT_CONFIG, type CreatePilotOptions, type KnowledgeBase, type LlmClient, type PilotTool } from '@slicerx/pilot'
import { motionReduced } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { setSessionSource } from '../../app-link/sessions'
import { appDesignHost } from '../../cad/design-host'
import { useEdition } from '../../edition'
import { bundledKb } from '../../features/pilot/kb'
import { useHost } from '../../host'
import { useMimirCloudHost } from '../../pilot-connect/cloud'
import { pilotModel, pilotTransport } from '../../pilot-connect/llm'
import { get, useApp, type PilotPref } from '../../state/store'
import { setMimirLink, type MimirLink } from './connection'
import { mimirTools, NO_APPROVALS, NO_PRINTERS, scriptedMimir } from './scripted'
import { SCRIPTS } from './scripts'

export const mimirLogs = createMemorySessionStore()

/** The person's messages per session, in order. */
export const mimirMessages = new Map<string, { text: string; attachments: string[] }[]>()

/** What the tab's mimir runs on, for the read-back: the stub, or a model with its provider and models. */
export interface TabModel {
  link: Exclude<MimirLink, 'none'>
  provider: string
  model: string
  /** Auto's two models when the person chose Auto: huginn to start, muninn for pictures and many-step parts. */
  auto?: { huginn: string; muninn: string }
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
 * and Auto's pair, and the tools mimir has there. No key or token.
 */
export function tabState(): { link: MimirLink; provider: string | null; model: string | null; auto: { huginn: string; muninn: string } | null; tools: string[] } {
  if (!current) return { link: 'none', provider: null, model: null, auto: null, tools: [] }
  const m = current.model
  return { link: m.link, provider: m.provider, model: m.model, auto: m.auto ?? null, tools: current.pilot.tools().map((t) => t.name) }
}

/** The tab's tools: the questions, lookups and sheets, then the design tools on the plate. Made once per window. */
function toolsFor(loader: Loader): PilotTool<never>[] {
  if (tools.length === 0) tools = mimirTools(designToolset(appDesignHost(loader)))
  return tools
}

/** The stub: the same runtime and tools, answering with the scripts. Replies stream at a reading pace, at once under reduced motion. */
function scripted(loader: Loader): Pilot {
  const still = motionReduced()
  return scriptedMimir(SCRIPTS, toolsFor(loader), { store: mimirLogs, delayMs: still ? 0 : 28, callDelayMs: still ? 0 : 350 })
}

/**
 * What the tab's model runtime is made from. The design scope builds every part with the design tools (no part
 * generator), so each step lands in the timeline; Auto starts on huginn and moves to muninn only for a picture or PDF,
 * or a part of many steps. Nothing in the tab reaches a printer or asks for an approval.
 */
export function tabPilotOptions(parts: { llm: LlmTransport; config: PilotConfig; kb: KnowledgeBase; tools: readonly PilotTool<never>[]; client?: LlmClient; share?: CreatePilotOptions['share'] }): CreatePilotOptions {
  return {
    host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: parts.llm },
    // a part takes many feature steps; the stub's limits hold for a model too
    config: { ...parts.config, maxSteps: Math.max(parts.config.maxSteps, 40), maxToolCalls: Math.max(parts.config.maxToolCalls, 60) },
    scope: 'design',
    commands: [],
    kb: parts.kb,
    tools: [...parts.tools],
    store: mimirLogs,
    ...(parts.client ? { client: parts.client } : {}),
    ...(parts.share ? { share: parts.share } : {}),
  }
}

/** The setup the tab would use now: what Settings > mimir chose, or the edition's own. A change makes the runtime again. */
function setupKey(host: Host, edition: EditionConfig, pref: PilotPref | null, cloud: unknown): string {
  return JSON.stringify([edition.id, pref, cloud ? 1 : 0, host.llm ? 1 : 0])
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
      const pilot = createPilot(tabPilotOptions({ llm, config, kb, tools: toolsFor(loader), share: () => ({ on: get().mimirShare, version: host.build.version }) }))
      const auto = config.auto && config.models?.huginn && config.models.muninn ? { huginn: config.models.huginn, muninn: config.models.muninn } : undefined
      made = { pilot, model: { link: 'model', provider: config.provider, model: config.model, ...(auto ? { auto } : {}) } }
    } else {
      made = { pilot: scripted(loader), model: { link: 'scripted', provider: 'scripted', model: 'scripted' } }
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
  const [pilot, setPilot] = useState<Pilot | null>(() => (current?.key === setupKey(host, edition, get().pilot, cloud) ? current.pilot : null))
  useEffect(() => {
    let live = true
    void tabMimir(host, edition, cloud).then((p) => {
      if (live) setPilot(p)
    })
    return () => {
      live = false
    }
  }, [host, edition, cloud, pref])
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
