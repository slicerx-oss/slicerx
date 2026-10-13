// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Tool and resource registration for the SlicerX MCP server.
import { readFileSync } from 'node:fs'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { PERMISSION_LABELS, productName } from '@slicerx/contracts'
import type { PilotTool } from '@slicerx/pilot'
import { ORCA_COMMIT } from '@slicerx/settings'
import type { DataStore, KnowledgeKind } from './data'
import { listDocs, settingEntry, settingsReference } from './docs'
import { gatedCall, mcpName, type GateDeps, type ToolProgress } from './gate'
import { ToolInputError, type ErrorCode, type PathPolicy } from './models'
import type { PrinterBackend } from './printers'
import type { ProfileCatalog } from './profiles'
import { explainSetting } from './settings'
import type { SlicerBackend } from './slicer'
import { SERVER_TOOLS } from './toolbox'
export { noPrinterMessage } from './toolbox/slice'

export const SERVER_NAME = 'slicerx-mcp-server'
export const SERVER_VERSION = '0.1.0'
const CHARACTER_LIMIT = 25_000

export interface ServerContext {
  store: DataStore
  profiles: ProfileCatalog
  policy: PathPolicy
  /** Undefined when no engine is available; `slicerUnavailable` says why. */
  slicer: SlicerBackend | undefined
  slicerUnavailable?: string
  printers: PrinterBackend | undefined
  /** mimir's registry plus the MCP project and printer tools. */
  tools: PilotTool<never>[]
  gate: GateDeps
}

function ok(data: object, text?: string): CallToolResult {
  // The text copy is for clients that read only text (the MCP spec asks for it); compact, since every space is paid for.
  let body = text ?? JSON.stringify(data)
  if (body.length > CHARACTER_LIMIT) body = `${body.slice(0, CHARACTER_LIMIT)}\n[truncated at ${CHARACTER_LIMIT} characters; narrow the request]`
  return { content: [{ type: 'text', text: body }], structuredContent: data as Record<string, unknown> }
}

/** A refused call: `Error: <code>: <message>` as text, and `{ error: { code, message } }` for clients that read structured content. */
export function fail(message: string, code: ErrorCode = 'invalid_input', details?: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `Error: ${code}: ${message}` }], structuredContent: { error: { code, message, ...(details ? { details } : {}) } } }
}

async function guard(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ToolInputError) return fail(e.message, e.code, e.details)
    const code = typeof e === 'object' && e !== null && 'code' in e ? `${String((e as { code: unknown }).code)}: ` : ''
    return fail(`${code}${e instanceof Error ? e.message : String(e)}`, 'internal_error')
  }
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

function progressOf(extra: ToolExtra): ToolProgress | undefined {
  const token = extra._meta?.progressToken
  if (token === undefined) return undefined
  let last = 0
  return (line, fraction) => {
    if (fraction !== undefined) last = Math.max(last, Math.min(1, fraction))
    void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: last, total: 1, message: line } }).catch(() => undefined)
  }
}

const KNOWLEDGE_KINDS: KnowledgeKind[] = ['filament', 'printer', 'accessory', 'troubleshoot', 'guide']

export interface SlicerxServerOptions {
  /**
   * Approval requests raised and resolved through this server. HTTP mode passes
   * one map per MCP session, so a session can list and approve only its own
   * requests. Defaults to the context's map (stdio: one client per process).
   */
  pending?: GateDeps['pending']
}

/**
 * Every tool the server lists, once: mimir's registry with the project, CAD and printer tools first, then the
 * server's own tools from src/toolbox (whose printer.list and printer.status stand in only when the registry has
 * none). The server, the command line and the tool docs read this one list.
 */
export function serverTools(ctx: ServerContext, gate: GateDeps = ctx.gate): PilotTool<never>[] {
  const deps = { store: ctx.store, profiles: ctx.profiles, policy: ctx.policy, slicer: ctx.slicer, slicerUnavailable: ctx.slicerUnavailable, printers: ctx.printers, gate }
  const own = SERVER_TOOLS.map((f) => f(deps)).filter((t): t is PilotTool<never> => t !== null)
  const seen = new Set<string>()
  return [...ctx.tools, ...own].filter((t) => {
    const name = mcpName(t.name)
    if (seen.has(name)) return false
    seen.add(name)
    return true
  })
}

export function createSlicerxServer(ctx: ServerContext, opts: SlicerxServerOptions = {}): McpServer {
  const gate: GateDeps = opts.pending ? { ...ctx.gate, pending: opts.pending } : ctx.gate
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `${productName()}, the AI-ready slicer. Tools slice and estimate models, plan and check OrcaSlicer settings, run mimir skills on a project (orient, arrange, cut, slice), and read and control printers. Anything that changes a printer, a saved profile or spends money follows the permission policy the user set: it runs, asks the user first, or is refused. When a tool returns status "approval_required", show the request to the user and call slicerx_approve only with their answer. Resources hold the knowledge base, the settings reference, printer setup guides and the theming and embedding docs.`,
    },
  )
  const { store } = ctx

  // One list: the server's own tools (src/toolbox) and mimir's registry with the project, CAD and printer tools.
  const ungated = (tool: PilotTool<never>, args: unknown, extra: ToolExtra): Promise<CallToolResult> =>
    guard(async () => {
      const out = await (tool as PilotTool<unknown>).run(args, gate.context(undefined, extra.signal, progressOf(extra)))
      if (out.passthrough) return out.passthrough as CallToolResult
      if (out.structured !== undefined || out.text !== undefined) return ok(out.structured ?? {}, out.text)
      return ok({ ok: out.ok !== false, summary: out.summary, ...(out.output !== undefined ? { output: out.output } : {}) })
    })
  for (const tool of serverTools(ctx, gate)) {
    const read = tool.permission === 'read' && !tool.permissionFor
    const label = PERMISSION_LABELS[tool.permission as keyof typeof PERMISSION_LABELS]
    const h = tool.hints ?? {}
    server.registerTool(
      mcpName(tool.name),
      {
        title: tool.title ?? tool.name,
        description: read ? tool.description : `${tool.description} Permission class: ${tool.permission}${label ? ` (${label.title})` : ''}. The user's policy decides whether it runs, asks the user first, or is off.`,
        inputSchema: tool.input as unknown as z.ZodObject,
        ...(tool.outputShape ? { outputSchema: tool.outputShape } : {}),
        annotations: {
          readOnlyHint: h.readOnly ?? read,
          destructiveHint: h.destructive ?? (tool.permission === 'start' || tool.permission === 'queue'),
          idempotentHint: h.idempotent ?? read,
          openWorldHint: h.openWorld ?? tool.source === 'plugin',
        },
      },
      (args: unknown, extra: ToolExtra) => (tool.ungated ? ungated(tool, args, extra) : gatedCall(server, gate, tool as PilotTool<unknown>, args, extra.signal, progressOf(extra))),
    )
  }

  server.registerResource(
    'knowledge',
    new ResourceTemplate('slicerx://knowledge/{kind}/{id}', {
      list: () => ({
        resources: store
          .knowledge()
          .filter((e) => KNOWLEDGE_KINDS.includes(e.kind))
          .map((e) => ({ uri: `slicerx://knowledge/${e.kind}/${e.id}`, name: `${e.kind}: ${e.name}`, mimeType: 'application/yaml' })),
      }),
      complete: {
        kind: () => KNOWLEDGE_KINDS,
        id: (value, context) =>
          store
            .knowledge()
            .filter((e) => (context?.arguments?.['kind'] ? e.kind === context.arguments['kind'] : true) && e.id.startsWith(value))
            .map((e) => e.id),
      },
    }),
    { title: `${productName()} print knowledge`, description: 'Filament, printer, troubleshooting and workflow entries, as YAML with cited sources', mimeType: 'application/yaml' },
    (uri, vars) => {
      const kind = String(vars['kind'])
      const id = String(vars['id'])
      const e = store.knowledge().find((k) => k.kind === kind && k.id === id)
      if (!e) throw new Error(`No knowledge entry ${kind}/${id}`)
      return { contents: [{ uri: uri.href, mimeType: 'application/yaml', text: e.text }] }
    },
  )

  server.registerResource(
    'settings-catalog',
    'slicerx://settings/catalog',
    { title: 'Settings catalog', description: 'OrcaSlicer keys with Pilot edit rules and guardrail bounds (knowledge/settings.yaml)', mimeType: 'application/yaml' },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/yaml', text: store.knowledge().find((e) => e.kind === 'settings_catalog')?.text ?? '' }] }),
  )

  server.registerResource(
    'settings-schema',
    'slicerx://settings/schema',
    { title: 'Settings schema', description: `Every OrcaSlicer setting ${productName()} knows: type, unit, default, limits, help and invalidated stage`, mimeType: 'application/json' },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ orca_commit: ORCA_COMMIT, settings: store.settingsSchema() }) }] }),
  )

  const docs = listDocs(store.paths)
  server.registerResource(
    'docs',
    new ResourceTemplate('slicerx://docs/{+id}', {
      list: () => ({ resources: docs.map((d) => ({ uri: `slicerx://docs/${d.id}`, name: d.title, mimeType: 'text/markdown' })) }),
    }),
    { title: `${productName()} guides`, description: 'Install, embedding, theming, printer and Home Assistant setup, and this server', mimeType: 'text/markdown' },
    (uri, vars) => {
      const d = docs.find((x) => x.id === String(vars['id']))
      if (!d) throw new Error(`No doc ${String(vars['id'])}`)
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readFileSync(d.path, 'utf8') }] }
    },
  )

  const referenceIndex = docs.find((d) => d.id === 'settings/reference/index')
  server.registerResource(
    'settings-reference',
    'slicerx://settings/reference',
    { title: 'Settings reference', description: `Every setting ${productName()} reads, with links to each group; one entry per key at slicerx://settings/reference/{key}`, mimeType: 'text/markdown' },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: referenceIndex ? readFileSync(referenceIndex.path, 'utf8') : settingsReference(store) }] }),
  )

  server.registerResource(
    'setting',
    new ResourceTemplate('slicerx://settings/reference/{key}', {
      list: undefined,
      complete: { key: (value) => store.settingsSchema().filter((d) => d.key.startsWith(value)).slice(0, 50).map((d) => d.key) },
    }),
    { title: 'Setting reference entry', description: 'One setting: label, help, type, unit, default, ranges, dependencies, the slice stage it redoes, Easy mode mapping and effect', mimeType: 'text/markdown' },
    (uri, vars) => {
      const key = String(vars['key'])
      const def = store.setting(key)
      if (!def) throw new Error(`Unknown setting ${key}`)
      const text = settingEntry(store.paths, def.section, def.group, key) ?? `### \`${key}\`\n\n${JSON.stringify(explainSetting(store, key), null, 2)}`
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] }
    },
  )

  const skills = store.knowledge().find((e) => e.kind === 'skill_catalog')
  if (skills) {
    server.registerResource(
      'skill-catalog',
      'slicerx://pilot/skills',
      { title: 'mimir skill catalog', description: 'Multi-step jobs mimir plans and runs, with the tools and permission classes each one uses', mimeType: 'application/yaml' },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/yaml', text: skills.text }] }),
    )
  }

  return server
}
