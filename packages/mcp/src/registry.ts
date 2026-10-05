// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's tool registry, hosted for MCP clients: the same skills and
// tools the app's assistant uses, with this server's printer backend, Node
// slicer host, project and saved-profile store behind them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalToken, ApprovalVerifier, PilotContext, PrinterHost, SettingValue } from '@slicerx/contracts'
import { hashParams } from '@slicerx/contracts'
import { builtinTools, createCombinedPlanner, createKnowledgeBase, pluginToolsFrom, type KbIndex, type KnowledgeBase, type PilotTool, type SettingsPlanner, type ToolContext, type ToolHost } from '@slicerx/pilot'
import kbIndex from '@slicerx/pilot/kb.json' with { type: 'json' }
import type { ProjectRef } from './tools'
import type { NodeSlicerHost } from './slicerhost'

/** Tools that need the app itself (its command palette, a web search key, the report card). */
const APP_ONLY = new Set(['pilot.report', 'web.lookup'])

/** mimir's built-in tools, minus the ones that need the app itself. */
export function pilotTools(planner: SettingsPlanner): PilotTool<never>[] {
  return builtinTools({ planner, commands: [] }).filter((t) => !APP_ONLY.has(t.name) && t.source !== 'command')
}

/**
 * Tools declared by service plugins (Spoolman, Home Assistant). Printer plugins are left out:
 * the printer.* tools already cover them with the host's own approval parameters.
 */
export async function servicePluginTools(printers: PrinterHost | undefined): Promise<PilotTool<never>[]> {
  if (!printers) return []
  const manifests = await printers.plugins()
  return pluginToolsFrom(manifests.filter((m) => m.kind !== 'printer'))
}

export function createKb(): KnowledgeBase {
  return createKnowledgeBase(kbIndex as unknown as KbIndex)
}

export { createCombinedPlanner }

/**
 * Saved profiles written by settings.apply with target "profile": one JSON
 * file of changed keys per profile id. The write happens only with a token the
 * broker verifies for exactly these changes.
 */
export function createProfileStore(dir: string, approvals: ApprovalVerifier): NonNullable<ToolHost['profiles']> {
  return {
    async write(profileId: string, changes: Record<string, SettingValue>, token: ApprovalToken) {
      const check = await approvals.verify(token, 'profile.write', profileId, await hashParams({ profileId, changes }))
      if (!check.ok) throw Object.assign(new Error(`Profile write refused: ${check.reason}`), { code: 'approval_invalid' })
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${profileId.replace(/[^\w.@ -]+/g, '_')}.json`)
      const current = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { changes?: Record<string, SettingValue> }) : {}
      writeFileSync(file, `${JSON.stringify({ profileId, changes: { ...(current.changes ?? {}), ...changes }, updatedAt: new Date().toISOString() }, null, 2)}\n`)
    },
  }
}

export interface ContextDeps {
  printers: PrinterHost | undefined
  slicer: NodeSlicerHost
  profiles: NonNullable<ToolHost['profiles']>
  kb: KnowledgeBase
  setup?: NonNullable<ToolHost['setup']>
  project: ProjectRef
  today(): string
}

const NO_PRINTERS: PrinterHost = new Proxy({} as PrinterHost, {
  get: () => () => Promise.reject(Object.assign(new Error('Printer access is off on this server (--printers off).'), { code: 'not_supported' })),
})

/** Builds the ToolContext each call runs with. */
export function toolContext(deps: ContextDeps, token: ApprovalToken | undefined, signal: AbortSignal, progress?: (line: string, fraction?: number) => void): ToolContext {
  const project = deps.project.current
  const machine = project?.machine()
  const context: PilotContext = {
    ...(project ? { project: project.name, objects: project.objects().map((o) => ({ id: o.id, name: o.name, bboxMm: o.bboxMm })) } : {}),
    ...(machine ? { machine } : {}),
  }
  return {
    host: { printers: deps.printers ?? NO_PRINTERS, slicer: deps.slicer, profiles: deps.profiles, ...(deps.setup ? { setup: deps.setup } : {}) },
    sessionId: 'mcp',
    callId: `call-${Math.random().toString(36).slice(2, 10)}`,
    signal,
    ...(token ? { token } : {}),
    context,
    today: deps.today(),
    ...(project ? { project } : {}),
    kb: deps.kb,
    progress: progress ?? (() => undefined),
  }
}
