// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Connect your AI agent: the MCP clients SlicerX can be added to, on @slicerx/mcp's install steps
// (packages/mcp/README.md, "Connect your AI agent"). The app entry registers a host that knows
// where the server lives, the hub's key, how to keep an agent credential in the keychain and how
// to run a step. The browser has none of that and shows the steps to finish in the desktop app.
// An agent can watch, slice and queue; it can never start a print without a tap.
import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { AGENT_CLIENTS, agentKeyRef, installSteps, type AgentClientId, type InstallInput, type InstallStep } from '@slicerx/mcp/agents'
import { mcpServerId, publisherOf } from '@slicerx/edition-config'
import { appName, currentEdition } from '../edition'

export type AgentId = AgentClientId
export { AGENT_CLIENTS, agentKeyRef }

export interface AgentInfo {
  id: AgentId
  name: string
  /** Brand mark slug in @slicerx/brand-icons, when one may be used to identify the client. */
  mark?: 'claude' | 'cursor'
  /** One line on what "Add to" does. */
  what: string
}

const WHAT = (id: AgentId, server: string): string =>
  ({
    'claude-desktop': `Builds the ${server}.mcpb extension and opens it; Claude Desktop asks once and installs it.`,
    'claude-code': `Runs claude mcp add-json ${server}, so every Claude Code session on this machine can use it.`,
    cursor: 'Opens a Cursor install link; Cursor asks once and adds the server for all projects.',
    codex: `Runs codex mcp add ${server}, so Codex can use it from any project.`,
    chatgpt: `Adds ${appName()} as a connector in ChatGPT, through your camera relay.`,
  })[id]

/** The app the MCP server belongs to, as the clients list it: the edition's server name, product name and publisher. */
export function serverApp(): NonNullable<InstallInput['app']> {
  const edition = currentEdition()
  const { publisher } = publisherOf(edition)
  return { id: mcpServerId(edition), name: appName(), author: { name: publisher, ...(edition.apps.web.origin ? { url: edition.apps.web.origin } : {}) } }
}
const MARK: Partial<Record<AgentId, 'claude' | 'cursor'>> = { 'claude-desktop': 'claude', 'claude-code': 'claude', cursor: 'cursor' }

// `what` names the server, which depends on the edition, so it is read when shown.
export const AGENTS: readonly AgentInfo[] = AGENT_CLIENTS.map((c) => ({
  id: c.id,
  name: c.name,
  ...(MARK[c.id] ? { mark: MARK[c.id]! } : {}),
  get what() {
    return WHAT(c.id, serverApp().id)
  },
}))

export const needsRelay = (id: AgentId): boolean => AGENT_CLIENTS.find((c) => c.id === id)?.needsRelay ?? false

export interface InstallResult {
  ok: boolean
  /** One line for the person: what happened, or what to do next. */
  message: string
  /** The config entry, for people who prefer to paste it, or when nothing could be run here. */
  paste?: string
  /** Where to paste it. */
  pasteInto?: string
}

/** What an app entry with a shell provides. Every method may say no; the flow then shows what to paste. */
export interface AgentInstallHost {
  /** How a client starts the server shipped with this app, such as node and the path of cli.js. */
  serverCommand(): Promise<{ command: string; args: string[] } | null>
  /** The hub's public key and address, from the bridge this app runs. */
  hub(): Promise<{ hubKey: string; linkUrl?: string } | null>
  /** Gets this agent its own hub credential and keeps it in the keychain under agentKeyRef(client). Never returns the key. */
  credential(client: AgentId): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Runs one step: opens a deep link, runs a command, or builds and opens a bundle. */
  run(client: AgentId, step: InstallStep): Promise<InstallResult>
  /** True once a camera relay gives hosted assistants an HTTPS endpoint. */
  relayReady?(): Promise<boolean>
  /** True when this agent has a credential in the keychain. */
  connected?(client: AgentId): Promise<boolean>
  /** Revokes the agent's hub credential and removes it from the keychain. The client's own config entry stays; without a key it connects to nothing. */
  disconnect?(client: AgentId): Promise<void>
}

type Factory = () => AgentInstallHost
let factory: Factory | null = null
let marks: ((mark: NonNullable<AgentInfo['mark']>, size: number, title: string) => ReactNode) | null = null
const listeners = new Set<() => void>()

/** Called once by an app entry that has a shell (the desktop app). */
export function registerAgentInstall(f: Factory | null): void {
  factory = f
  for (const l of listeners) l()
}

/** Called once by an app entry that bundles the client marks. Marks identify the client only; never altered. */
export function registerAgentMarks(r: typeof marks): void {
  marks = r
  for (const l of listeners) l()
}

export const agentMark = (mark: NonNullable<AgentInfo['mark']>, size: number, title: string): ReactNode => marks?.(mark, size, title) ?? null

export function useAgentInstall(): AgentInstallHost {
  const f = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => factory,
    () => null,
  )
  return f ? f() : browserHost
}

/** The browser build: no shell, no keychain, no hub key. It shows the steps and points at the desktop app. */
export const browserHost: AgentInstallHost = {
  serverCommand: async () => null,
  hub: async () => null,
  credential: async () => ({ ok: false, reason: `The browser has no keychain for an agent credential. Finish this in the ${appName()} desktop app.` }),
  run: async () => ({ ok: false, message: 'Nothing can run from the browser. Copy the entry below, or open the desktop app.' }),
  relayReady: async () => false,
}

const FALLBACK_SERVER = { command: 'node', args: ['/path/to/slicerx/packages/mcp/dist/cli.js'] }

function os(): 'mac' | 'windows' | 'linux' {
  const p = typeof navigator === 'undefined' ? '' : navigator.platform
  return p.startsWith('Mac') ? 'mac' : p.startsWith('Win') ? 'windows' : 'linux'
}

const configOf = (steps: InstallStep[]): { paste?: string; pasteInto?: string } => {
  const c = steps.find((s): s is Extract<InstallStep, { kind: 'config' }> => s.kind === 'config')
  return c ? { paste: c.snippet, pasteInto: c.path } : {}
}

/** The whole flow for one client: credential, then the one-click step, with the config entry to paste as the fallback. */
export async function installAgent(host: AgentInstallHost, client: AgentId): Promise<InstallResult> {
  if (needsRelay(client) && !(await host.relayReady?.())) {
    const [step] = installSteps(client, { server: FALLBACK_SERVER, hubKey: '', app: serverApp() }, os())
    return { ok: false, message: step?.kind === 'waits' ? step.reason : 'Available once the camera relay is set up.' }
  }
  const server = (await host.serverCommand()) ?? FALLBACK_SERVER
  const hub = await host.hub()
  const input: InstallInput = { server, hubKey: hub?.hubKey ?? '<hub key: shown by the desktop app>', app: serverApp(), ...(hub?.linkUrl ? { linkUrl: hub.linkUrl } : {}) }
  const steps = installSteps(client, input, os())
  const config = configOf(steps)
  if (!hub) return { ok: false, message: `This needs the ${appName()} desktop app, which runs the printer hub and keeps the agent credential in your keychain. The entry below shows what it will add.`, ...config }
  const cred = await host.credential(client)
  if (!cred.ok) return { ok: false, message: cred.reason, ...config }
  const first = steps[0]
  if (!first || first.kind === 'waits') return { ok: false, message: first?.kind === 'waits' ? first.reason : 'No install step for this client yet.', ...config }
  if (first.kind === 'config') return { ok: true, message: `Copied the entry. Paste it into ${first.path}.`, ...config }
  const r = await host.run(client, first)
  return { ...r, ...(r.paste ? {} : config) }
}
