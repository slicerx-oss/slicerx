// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The running-app MCP server: the same tools on macOS, Windows and Linux, each forwarded to the app's agent bridge
// (docs/agent-bridge.md). Reads report what a person would see; acts use the controls and code paths a person's
// clicks, a double-clicked file and the sign-in link use. No tool prints, sends to a printer or deletes anything.
// Errors follow @slicerx/mcp: `Error: <code>: <message>` as text and `{ error: { code, message } }` as structured content.
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { BridgeCallError, type AppClient } from './client.ts'
import { NotRunning } from './connection.ts'

export const SERVER_NAME = 'slicerx-app-bridge'
export const SERVER_VERSION = '0.1.0'
const CHARACTER_LIMIT = 25_000

function ok(data: unknown): CallToolResult {
  let text = JSON.stringify(data, null, 2) ?? 'null'
  if (text.length > CHARACTER_LIMIT) text = `${text.slice(0, CHARACTER_LIMIT)}\n[truncated at ${CHARACTER_LIMIT} characters; pass since or limit to narrow it]`
  return { content: [{ type: 'text', text }], ...(data && typeof data === 'object' && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}) }
}

export function fail(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `Error: ${code}: ${message}` }], structuredContent: { error: { code, message } } }
}

async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof BridgeCallError) return fail(e.code, e.message)
    if (e instanceof NotRunning) return fail('not_running', e.message)
    return fail('internal_error', e instanceof Error ? e.message : String(e))
  }
}

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const act = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const

const testid = z.string().min(1).max(120).regex(/^[\w.:-]+$/).describe('The control\'s data-testid, as listed in docs/test-ids.md or by app_testids')
const index = z.number().int().min(0).max(1000).optional().describe('Which match to use when several controls carry the test id (0 is the first on screen)')
const since = z.number().int().min(0).optional().describe('Only entries after this marker (the marker a previous read returned). Default: all kept entries')
const limit = z.number().int().min(1).max(1000).optional().describe('At most this many entries, the newest. Default 200')
const timeoutMs = (def: number, max = 900_000) => z.number().int().min(0).max(max).optional().describe(`How long to wait, in ms. Default ${def}`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface PlateView {
  tab?: string
  marker?: number
  unsavedPrompt?: string | null
  plate?: { loading?: boolean; objects?: { id: string }[] }
}

/** Opens a file through the app and waits until the plate (or the tab, for G-code) changes and loading is done. */
async function openFileAndWait(client: AppClient, path: string, waitMs: number): Promise<unknown> {
  const before = (await client.call('state')) as PlateView
  const ids = (s: PlateView) => (s.plate?.objects ?? []).map((o) => o.id).join('\n')
  const handed = await client.call('open_file', { path })
  const started = Date.now()
  for (;;) {
    await sleep(250)
    const now = (await client.call('state')) as PlateView
    const toasts = (await client.call('toasts', { since: before.marker ?? 0 })) as { entries: { text: string; tone: string }[] }
    const failed = toasts.entries.find((t) => t.tone === 'error')
    if (failed) throw new BridgeCallError('open_failed', failed.text)
    if (now.unsavedPrompt) return { handed, asking: `The app asks whether to save before it ${now.unsavedPrompt}; answer the dialog (app_dialogs, app_click).`, state: now }
    const changed = ids(now) !== ids(before) || now.tab !== before.tab
    if (changed && !now.plate?.loading) return { handed, state: now }
    if (Date.now() - started > waitMs) throw new BridgeCallError('timeout', `The plate did not change within ${waitMs} ms of handing over ${path}.`)
  }
}

/** Registers every tool on a new server that talks to the app through `client`. */
export function createAppBridgeServer(client: AppClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  const forward = (tool: string) => (args: Record<string, unknown>) => guard(async () => ok(await client.call(tool, args)))

  // Reads
  server.registerTool(
    'app_health',
    { title: 'Is the app running', description: 'Whether a bridge build of the app is running and reachable: its name, version, process id, platform, whether its page side is up (pageReady) and the app has started (appReady), and the bridge tools it serves.', inputSchema: {}, annotations: read },
    () => guard(async () => ok(await client.health())),
  )
  server.registerTool(
    'app_state',
    {
      title: 'Read the app state',
      description:
        'What the app shows now: the active tab (prepare, preview, feed for the Vault, printers...), the plate (each object with its parts, filament slot, size, Vault listing and the last slice\'s warnings for it), the printer and nozzle, the filament slots, the slicing status with the last slice summary (time, grams, layers, warnings), which export commands are on (the mesh exports stay off for a Vault design), whether setup or the save prompt is open, the dialogs and toasts on screen, and the current log marker.',
      inputSchema: {},
      annotations: read,
    },
    forward('state'),
  )
  server.registerTool(
    'app_toasts',
    { title: 'Read toasts', description: 'Toasts the app showed, each with its text, tone (ok, info, warn, error, plain) and time, in order. Pass since to get only newer ones; the answer carries the new marker.', inputSchema: { since, limit }, annotations: read },
    forward('toasts'),
  )
  server.registerTool(
    'app_dialogs',
    { title: 'Read dialogs', description: 'Dialogs that opened and closed, with their titles, test ids and times, and the dialogs open now. Pass since to get only newer events.', inputSchema: { since, limit }, annotations: read },
    forward('dialogs'),
  )
  server.registerTool(
    'app_console',
    {
      title: 'Read the console',
      description: 'Console lines (log, info, warn, error, debug), page errors, unhandled rejections and content security refusals (level csp), with times. Tokens in the text are masked. Pass since to get only newer lines.',
      inputSchema: { since, limit },
      annotations: read,
    },
    forward('console'),
  )
  server.registerTool(
    'app_network',
    {
      title: 'Read backend calls',
      description: 'The app\'s fetch calls and failed resource loads (images, scripts): method, address without its query string, status, ok and time. Never bodies, headers or tokens. Pass since to get only newer calls.',
      inputSchema: { since, limit },
      annotations: read,
    },
    forward('network'),
  )
  server.registerTool(
    'app_user',
    { title: 'Read the signed-in user', description: 'Whether someone is signed in to the Vault, and if so their user id and email. Nothing else about the account.', inputSchema: {}, annotations: read },
    forward('user'),
  )
  server.registerTool(
    'app_screenshot',
    {
      title: 'Screenshot the window',
      description: 'A PNG of the app window\'s content, taken by the web view itself (no screen recording permission needed). Returned as an image; with path, also written to that absolute .png path.',
      inputSchema: { path: z.string().optional().describe('Absolute path ending in .png to also save the image to') },
      annotations: read,
    },
    ({ path }) =>
      guard(async () => {
        const shot = (await client.call('screenshot')) as { data: string; width: number; height: number; bytes: number; mimeType: string }
        if (path !== undefined) {
          if (!isAbsolute(path) || !path.toLowerCase().endsWith('.png')) return fail('invalid_input', 'path must be absolute and end in .png')
          writeFileSync(path, Buffer.from(shot.data, 'base64'))
        }
        const meta = { width: shot.width, height: shot.height, bytes: shot.bytes, ...(path ? { path } : {}) }
        return { content: [{ type: 'image', data: shot.data, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(meta) }], structuredContent: meta }
      }),
  )
  server.registerTool(
    'app_element',
    { title: 'Read a control', description: 'Every control with this test id: whether it is on screen and enabled, its text, value (never a password), checked, pressed, expanded or current state, and its other data- attributes (data-listing, data-object-id, data-state, data-step), and the pictures in it (address without its query; loaded, pending or failed; on screen or not).', inputSchema: { testid }, annotations: read },
    forward('element'),
  )
  server.registerTool(
    'app_testids',
    { title: 'List test ids', description: 'The test ids on screen now, with how many controls carry each. all: true lists those off screen too.', inputSchema: { all: z.boolean().optional() }, annotations: read },
    forward('testids'),
  )

  // Acts
  server.registerTool(
    'app_click',
    {
      title: 'Click a control',
      description: 'Clicks the control with this test id the way a pointer does. Refuses a control that is off screen or disabled, and any control that prints, sends to a printer or deletes (test ids starting with danger-, the approval dialog, the Print sheet).',
      inputSchema: { testid, index },
      annotations: act,
    },
    forward('click'),
  )
  server.registerTool(
    'app_fill',
    { title: 'Type into a field', description: 'Replaces the value of the input, text area or select with this test id, as typing would (input and change events).', inputSchema: { testid, value: z.string().max(10_000), index }, annotations: act },
    forward('fill'),
  )
  server.registerTool(
    'app_press_key',
    {
      title: 'Press a key',
      description: 'Presses a key (Enter, Escape, Tab, ArrowDown, a, ...) with optional modifiers on the control with this test id, or on whatever has focus. Escape cancels the open dialog and Enter in a form field submits the form, as the browser would.',
      inputSchema: { key: z.string().min(1).max(32), testid: testid.optional(), ctrl: z.boolean().optional(), shift: z.boolean().optional(), alt: z.boolean().optional(), meta: z.boolean().optional() },
      annotations: act,
    },
    forward('press_key'),
  )
  server.registerTool(
    'app_wait_for',
    {
      title: 'Wait for a control',
      description: 'Waits until a control with this test id is visible, hidden, enabled, present or absent (optionally one whose text contains text).',
      inputSchema: { testid, state: z.enum(['visible', 'hidden', 'enabled', 'present', 'absent']).optional(), text: z.string().optional(), timeoutMs: timeoutMs(10_000) },
      annotations: read,
    },
    forward('wait_for'),
  )
  server.registerTool(
    'app_open_file',
    {
      title: 'Open a file',
      description: 'Opens a model or project (STL, 3MF, SX3MF, SXLOCK, OBJ, AMF, STEP, G-code) by absolute path, the way a double-clicked file reaches the app, and waits until it is on the plate. Returns the new state, or says when the app asks to save first.',
      inputSchema: { path: z.string().min(1).describe('Absolute path of the file'), timeoutMs: timeoutMs(60_000) },
      annotations: act,
    },
    ({ path, timeoutMs: wait }) => guard(async () => ok(await openFileAndWait(client, path, wait ?? 60_000))),
  )
  server.registerTool(
    'app_open_vault_design',
    {
      title: 'Open a Vault design',
      description: 'Opens a Vault design by listing id (or slug) or exact title through the Vault: the design\'s sheet, then its Open button, with the download and its progress as a person sees them. Waits until it is on the plate; reports a failed download, a sign-in request or a save prompt instead.',
      inputSchema: { id: z.string().optional(), title: z.string().optional(), timeoutMs: timeoutMs(120_000) },
      annotations: { ...act, openWorldHint: true },
    },
    forward('open_vault_design'),
  )
  server.registerTool(
    'app_clear_plate',
    { title: 'Clear the plate', description: 'Runs Clear the plate. When the app asks whether to save first, returns that question instead of answering it.', inputSchema: {}, annotations: act },
    forward('clear_plate'),
  )
  server.registerTool(
    'app_slice',
    {
      title: 'Slice and wait',
      description: 'Runs Slice the plate and waits for the result: time, grams, layers, tool changes and warnings. A fresh slice already on screen is returned as it is unless force is true.',
      inputSchema: { force: z.boolean().optional(), timeoutMs: timeoutMs(300_000) },
      annotations: act,
    },
    forward('slice'),
  )
  server.registerTool(
    'app_export_gcode',
    {
      title: 'Export G-code',
      description: 'Writes the G-code of the slice on screen to a temporary folder the app owns and returns its path and size. Refuses a slice that is stale or unsafe to print, as the Export button does. Never sends it anywhere.',
      inputSchema: { name: z.string().max(120).optional().describe('File name; the slice\'s own name by default') },
      annotations: act,
    },
    forward('export_gcode'),
  )
  server.registerTool(
    'app_auth_callback',
    {
      title: 'Hand over a sign-in link',
      description: 'Hands a sign-in callback link (<scheme>://auth/callback?...) to the app through the same path the system deep link takes. Only that kind of link is accepted, and it is never echoed or logged.',
      inputSchema: { url: z.string().min(1) },
      annotations: { ...act, openWorldHint: true },
    },
    forward('auth_callback'),
  )
  return server
}

/** The tool names this server registers, in order. */
export const TOOL_NAMES = [
  'app_health',
  'app_state',
  'app_toasts',
  'app_dialogs',
  'app_console',
  'app_network',
  'app_user',
  'app_screenshot',
  'app_element',
  'app_testids',
  'app_click',
  'app_fill',
  'app_press_key',
  'app_wait_for',
  'app_open_file',
  'app_open_vault_design',
  'app_clear_plate',
  'app_slice',
  'app_export_gcode',
  'app_auth_callback',
] as const
