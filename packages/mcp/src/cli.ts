#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx-mcp: runs the SlicerX MCP server over stdio (default) or streamable HTTP.
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { createContext, createSlicerxServer, startHttp, SERVER_VERSION, type EngineMode } from './index'
import { setProductColors, setProductName } from '@slicerx/contracts'
import { cloudFromEnv } from './cloud'
import { editionColorsFromEnv, editionNameFromEnv } from './edition'
import { localAiFromEnv } from './localai'
import { sxlockFromEnv } from './sxlock'
import { linkCodeFrom, linkKeyFrom, readHubKey, readKeychainKey } from './link-code'
import { hubUrlFromEnv } from '@slicerx/link-client'

const HELP = `slicerx-mcp ${SERVER_VERSION}: SlicerX tools for MCP clients

Usage: slicerx-mcp [options]
       slicerx-mcp [options] call <tool> [<json>] [<tool> [<json>] ...]

call runs tools once, in order, in one process, and prints one JSON line per call
({"tool", "ok", "text", "output"}), so a project built by the first calls is there
for the next. It stops at the first call that fails, with exit code 1. The tool may
be named with or without its slicerx_ prefix; <json> is its arguments (default {}).
Example: slicerx-mcp call project_open '{"printer":"bambu_a1"}' \
           project_add_filament '{"type":"PETG","color":"#ff5500"}' project_show
With --app the design calls edit the project open in the app, each step in its history:
         slicerx-mcp call --app design_new '{"name":"Clip"}' design_list

Transport
  --http                   Serve streamable HTTP on /mcp instead of stdio
  --host <addr>            HTTP bind address (default 127.0.0.1)
  --port <n>               HTTP port (default 3977)
  --token-file <path>      Where the bearer token is written, mode 0600 (default
                           ~/.config/slicerx/mcp-http-token). A new random token is made
                           at every launch; clients send "Authorization: Bearer <token>".
                           SLICERX_MCP_TOKEN sets a fixed token instead (never on argv)
  --allowed-host <name>    Extra Host header to accept behind a reverse proxy; repeat for more

Files
  --allow-dir <dir>        Directory models may be read from; repeat for more.
                           Default: any path for stdio, none for HTTP
  --out-dir <dir>          Where G-code and downloads go (default <tmp>/slicerx-mcp)
  --no-urls                Refuse http(s) model URLs
  --data-dir <dir>         Knowledge base and guides location (default: bundled)

Engine
  --engine auto|sx|stub    auto uses sx when found, else the stub estimator (default auto)
  --sx-bin <path>          Path to the sx CLI (default: SLICERX_SX_BIN, then PATH)
  --sx-geom-bin <path>     Path to sx-geom for the mesh tools (default: SLICERX_SX_GEOM_BIN, next to sx, then PATH)
  --cloud-api <url>        Cloud slicing API (default: SLICERX_MCP_CLOUD_API, SLICERX_CLOUD_API_URL, or SLICERX_CONFIG with cloudSlicing on; else off)

Printers
  --printers demo|link|off demo: simulated printers (default); link: real printers through sx-link
  --link-url <ws-url>      sx-link address (default ws://127.0.0.1:47615, or the port in SX_TEST_HUB_PORT)
                           The hub's agent code is read from its state directory
                           (agent-code, written with mode 0600), or from SLICERX_MCP_LINK_CODE.
                           A partner app passes its key in SLICERX_MCP_LINK_KEY instead.
  --link-state-dir <dir>   sx-link's state directory, when it is not the default
  --no-app                 with --printers link: keep designs on this server, even while the app link to
                           the open app answers (SLICERX_MCP_NO_APP=1)
  --app                    run the design tools only in the project open in the app, through the app link;
                           sets --printers link, and a design call fails while the link does not answer
                           instead of running here (SLICERX_MCP_APP=1)

Permissions and records
  --policy <file>          Permission policy (default ~/.config/slicerx/mcp-policy.json if present,
                           else: slicing allowed, queue, start and profile ask first)
  --log <file>             Action log, one JSON line per call (default <out-dir>/actions.jsonl)
  --profiles-dir <dir>     Where saved profile changes go (default ~/.config/slicerx/profiles)

Edition
  SLICERX_CONFIG names a resolved edition config (edition-config resolve). Tool text,
  results and errors then name the app by its brand.name instead of SlicerX,
  make_model takes its brand.colors, and the sx engine this server runs reads the
  same file.

Every option also reads an environment variable: SLICERX_MCP_<OPTION> in upper
snake case, such as SLICERX_MCP_ALLOW_DIR (colon separated) or SLICERX_MCP_ENGINE.
`

function env(name: string): string | undefined {
  const v = process.env[`SLICERX_MCP_${name}`]
  return v === undefined || v === '' ? undefined : v
}

const flag = (name: string): boolean => ['1', 'true', 'yes'].includes((env(name) ?? '').toLowerCase())

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      http: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      token: { type: 'string' },
      'token-file': { type: 'string' },
      'allowed-host': { type: 'string', multiple: true },
      'allow-dir': { type: 'string', multiple: true },
      'out-dir': { type: 'string' },
      'no-urls': { type: 'boolean' },
      'data-dir': { type: 'string' },
      engine: { type: 'string' },
      'sx-bin': { type: 'string' },
      'sx-geom-bin': { type: 'string' },
      'cloud-api': { type: 'string' },
      printers: { type: 'string' },
      'link-url': { type: 'string' },
      'link-code': { type: 'string' },
      'link-state-dir': { type: 'string' },
      'no-app': { type: 'boolean' },
      app: { type: 'boolean' },
      policy: { type: 'string' },
      log: { type: 'string' },
      'profiles-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    strict: true,
  })
  if (values.help) return void process.stdout.write(HELP)
  const calls = positionals[0] === 'call' ? parseCalls(positionals.slice(1)) : undefined
  if (!calls && positionals.length) throw new Error(`Unknown argument ${positionals[0]}. See slicerx-mcp --help.`)
  if (values.version) return void process.stdout.write(`${SERVER_VERSION}\n`)
  // Command lines are visible to every local user (ps), so a secret never goes there.
  if (values.token !== undefined) throw new Error('--token is no longer accepted, since other users can read command lines. Set SLICERX_MCP_TOKEN, or let the server write a token file (--token-file).')

  // A white-label edition's name in tool text and messages, before any tool is built.
  const name = editionNameFromEnv(process.env)
  if (name) setProductName(name)
  const colors = editionColorsFromEnv(process.env)
  if (colors) setProductColors(colors)

  const http = values.http ?? flag('HTTP')
  const engine = values.engine ?? env('ENGINE') ?? 'auto'
  if (!['auto', 'sx', 'stub'].includes(engine)) throw new Error(`--engine must be auto, sx or stub, not ${engine}`)
  const app = values.app ?? flag('APP')
  const noApp = values['no-app'] ?? flag('NO_APP')
  if (app && noApp) throw new Error('--app and --no-app cannot both be set')
  const printers = values.printers ?? env('PRINTERS') ?? (app ? 'link' : 'demo')
  if (app && printers !== 'link') throw new Error(`--app works through sx-link, so --printers must be link, not ${printers}`)
  if (printers !== 'demo' && printers !== 'link' && printers !== 'off') throw new Error(`--printers must be demo, link or off, not ${printers}`)
  const envDirs = env('ALLOW_DIR')?.split(':').filter(Boolean)
  const keyRef = env('LINK_KEY_REF')
  // Read once, then gone from the environment, so the engine and anything else this server runs never inherit it.
  const partnerKey = env('LINK_KEY')
  delete process.env['SLICERX_MCP_LINK_KEY']
  const allowDirs = values['allow-dir'] ?? envDirs ?? (http ? [] : undefined)

  const ctx = await createContext({
    dataDir: values['data-dir'] ?? env('DATA_DIR') ?? process.env['SLICERX_DATA_DIR'],
    allowDirs,
    outDir: values['out-dir'] ?? env('OUT_DIR'),
    engine: engine as EngineMode,
    sxBin: values['sx-bin'] ?? env('SX_BIN'),
    sxGeomBin: values['sx-geom-bin'] ?? env('SX_GEOM_BIN'),
    cloud: cloudFromEnv(process.env, values['cloud-api']),
    sxlock: sxlockFromEnv(process.env),
    localAi: localAiFromEnv(process.env),
    printers,
    // Else a test or dev run's SX_TEST_HUB_PORT (the variable the app's test builds and sx-link read), else sx-link's default.
    linkUrl: values['link-url'] ?? env('LINK_URL') ?? hubUrlFromEnv(process.env),
    // A client set up from the "Connect your AI agent" panel names its own credential in the keychain;
    // a partner app hands over the key it keeps itself.
    ...(printers === 'link' && keyRef ? { linkClientKey: readKeychainKey(keyRef) } : printers === 'link' && partnerKey ? { linkClientKey: linkKeyFrom(partnerKey) } : {}),
    linkCode: keyRef || partnerKey ? undefined : linkCodeFrom({ argvCode: values['link-code'], stateDir: values['link-state-dir'] ?? env('LINK_STATE_DIR'), envCode: env('LINK_CODE'), needed: printers === 'link' }),
    // The hub's key from its state directory is checked even when the code comes from the environment.
    linkHubKey: printers === 'link' ? (env('LINK_HUB_KEY') ?? readHubKey(values['link-state-dir'] ?? env('LINK_STATE_DIR'))) : undefined,
    app: app ? 'required' : !noApp,
    policyFile: values.policy ?? env('POLICY'),
    logFile: values.log ?? env('LOG'),
    profilesDir: values['profiles-dir'] ?? env('PROFILES_DIR'),
    allowUrls: !(values['no-urls'] ?? flag('NO_URLS')),
  })
  // Logs go to stderr: stdout carries the protocol in stdio mode.
  const engineLine = ctx.slicer ? `engine ${ctx.slicer.kind}` : `no engine (${ctx.slicerUnavailable ?? ''})`
  process.stderr.write(`slicerx-mcp ${SERVER_VERSION}: ${engineLine}, printers ${ctx.printers?.kind ?? 'off'}, ${ctx.tools.length} gated tools, policy ${ctx.gate.policyPath ?? 'defaults'}, log ${ctx.gate.log.path}\n`)

  if (calls) {
    try {
      return await runCalls(createSlicerxServer(ctx), calls)
    } finally {
      // The sx-link connection is an open socket, so Node would keep running after the last call. Closing it lets the
      // process end on its own, with the exit code runCalls set.
      ctx.printers?.close?.()
    }
  }

  if (http) {
    const host = values.host ?? env('HOST') ?? '127.0.0.1'
    const port = Number(values.port ?? env('PORT') ?? '3977')
    const allowedHosts = values['allowed-host'] ?? env('ALLOWED_HOST')?.split(',').filter(Boolean) ?? []
    const fixed = env('TOKEN')
    const token = fixed ?? randomBytes(32).toString('hex')
    const tokenFile = fixed ? undefined : resolve(values['token-file'] ?? env('TOKEN_FILE') ?? join(homedir(), '.config', 'slicerx', 'mcp-http-token'))
    if (tokenFile) writeSecretFile(tokenFile, token)
    // One pending map per MCP session: a client sees and approves only its own requests.
    await startHttp(() => createSlicerxServer(ctx, { pending: new Map() }), { host, port, token, allowedHosts })
    process.stderr.write(`slicerx-mcp: listening on http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp\n`)
    process.stderr.write(tokenFile ? `slicerx-mcp: bearer token written to ${tokenFile} (mode 0600, new at every launch)\n` : 'slicerx-mcp: bearer token from SLICERX_MCP_TOKEN\n')
    return
  }
  const server = createSlicerxServer(ctx)
  // The sx-link connection is an open socket, so it goes when the session does, or Node would keep running.
  server.server.onclose = () => ctx.printers?.close?.()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  endAtStdinEnd(transport, () => void server.close())
}

/**
 * Ends a stdio session when the client closes stdin, as an MCP client does to end one. The SDK's transport stops
 * reading there but never closes. Requests read before the end still get their answers first, so a client that writes
 * its requests and closes stdin at once gets every reply.
 */
function endAtStdinEnd(transport: StdioServerTransport, end: () => void): void {
  const open = new Set<string | number>()
  let ended = false
  const settle = () => {
    if (ended && open.size === 0) end()
  }
  const onmessage = transport.onmessage
  transport.onmessage = (msg: JSONRPCMessage) => {
    if ('method' in msg && 'id' in msg) open.add(msg.id)
    // A canceled request gets no answer.
    else if ('method' in msg && msg.method === 'notifications/cancelled') {
      const id = (msg.params as { requestId?: string | number } | undefined)?.requestId
      if (id !== undefined) open.delete(id)
    }
    onmessage?.(msg)
    settle()
  }
  const send = transport.send.bind(transport)
  transport.send = async (msg: JSONRPCMessage) => {
    await send(msg)
    if (!('method' in msg) && 'id' in msg && msg.id !== undefined) {
      open.delete(msg.id)
      settle()
    }
  }
  process.stdin.once('end', () => {
    ended = true
    settle()
  })
}

/** `call` arguments as tool calls: each tool name, then its arguments when the next word is a JSON object. */
function parseCalls(words: string[]): { name: string; args: Record<string, unknown> }[] {
  if (!words.length) throw new Error('call needs a tool name, such as: slicerx-mcp call project_show')
  const out: { name: string; args: Record<string, unknown> }[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word.trimStart().startsWith('{')) throw new Error(`Arguments ${word} come before any tool name`)
    const name = word.startsWith('slicerx_') ? word : `slicerx_${word}`
    let args: Record<string, unknown> = {}
    const next = words[i + 1]
    if (next?.trimStart().startsWith('{')) {
      try {
        args = JSON.parse(next) as Record<string, unknown>
      } catch {
        throw new Error(`The arguments for ${name} are not JSON: ${next}`)
      }
      i++
    }
    out.push({ name, args })
  }
  return out
}

/** Runs the calls through an in-process MCP client, the way any client calls the server, one JSON line each. */
async function runCalls(server: ReturnType<typeof createSlicerxServer>, calls: { name: string; args: Record<string, unknown> }[]): Promise<void> {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'slicerx-mcp call', version: SERVER_VERSION })
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    for (const c of calls) {
      const r = (await client.callTool({ name: c.name, arguments: c.args })) as CallToolResult
      const joined = r.content.map((p) => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n')
      const text = r.isError ? plainSdkText(joined) : joined
      process.stdout.write(`${JSON.stringify({ tool: c.name, ok: r.isError !== true, text, output: r.structuredContent ?? null })}\n`)
      if (r.isError) {
        process.exitCode = 1
        return
      }
    }
  } finally {
    await client.close()
  }
}

/**
 * The MCP SDK's errors read "MCP error -32602: Tool slicerx_x not found", and its server hands that whole message
 * back as a refused call's text. People reading `call` output or a CLI error get the message without the code.
 */
function plainSdkText(text: string): string {
  return text.replace(/^MCP error -?\d+: /, '')
}

/** Writes a fresh file only the current user can read. Never follows a link left at the path. */
function writeSecretFile(path: string, secret: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    if (lstatSync(path).isDirectory()) throw new Error(`${path} is a directory`)
    unlinkSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeSync(fd, `${secret}\n`)
  } finally {
    closeSync(fd)
  }
  chmodSync(path, 0o600)
}

main().catch((e: unknown) => {
  process.stderr.write(`slicerx-mcp: ${plainSdkText(e instanceof Error ? e.message : String(e))}\n`)
  process.exit(1)
})

