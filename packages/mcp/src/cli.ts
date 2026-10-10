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
import { createContext, createSlicerxServer, startHttp, SERVER_VERSION, type EngineMode } from './index'
import { cloudFromEnv } from './cloud'
import { localAiFromEnv } from './localai'
import { sxlockFromEnv } from './sxlock'
import { linkCodeFrom, linkKeyFrom, readHubKey, readKeychainKey } from './link-code'

const HELP = `slicerx-mcp ${SERVER_VERSION}: SlicerX tools for MCP clients

Usage: slicerx-mcp [options]

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
  --link-url <ws-url>      sx-link address (default ws://127.0.0.1:47615)
                           The hub's agent code is read from its state directory
                           (agent-code, written with mode 0600), or from SLICERX_MCP_LINK_CODE.
                           A partner app passes its key in SLICERX_MCP_LINK_KEY instead.
  --link-state-dir <dir>   sx-link's state directory, when it is not the default

Permissions and records
  --policy <file>          Permission policy (default ~/.config/slicerx/mcp-policy.json if present,
                           else: slicing allowed, queue, start and profile ask first)
  --log <file>             Action log, one JSON line per call (default <out-dir>/actions.jsonl)
  --profiles-dir <dir>     Where saved profile changes go (default ~/.config/slicerx/profiles)

Every option also reads an environment variable: SLICERX_MCP_<OPTION> in upper
snake case, such as SLICERX_MCP_ALLOW_DIR (colon separated) or SLICERX_MCP_ENGINE.
`

function env(name: string): string | undefined {
  const v = process.env[`SLICERX_MCP_${name}`]
  return v === undefined || v === '' ? undefined : v
}

const flag = (name: string): boolean => ['1', 'true', 'yes'].includes((env(name) ?? '').toLowerCase())

async function main(): Promise<void> {
  const { values } = parseArgs({
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
      policy: { type: 'string' },
      log: { type: 'string' },
      'profiles-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    strict: true,
  })
  if (values.help) return void process.stdout.write(HELP)
  if (values.version) return void process.stdout.write(`${SERVER_VERSION}\n`)
  // Command lines are visible to every local user (ps), so a secret never goes there.
  if (values.token !== undefined) throw new Error('--token is no longer accepted, since other users can read command lines. Set SLICERX_MCP_TOKEN, or let the server write a token file (--token-file).')

  const http = values.http ?? flag('HTTP')
  const engine = values.engine ?? env('ENGINE') ?? 'auto'
  if (!['auto', 'sx', 'stub'].includes(engine)) throw new Error(`--engine must be auto, sx or stub, not ${engine}`)
  const printers = values.printers ?? env('PRINTERS') ?? 'demo'
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
    linkUrl: values['link-url'] ?? env('LINK_URL'),
    // A client set up from the "Connect your AI agent" panel names its own credential in the keychain;
    // a partner app hands over the key it keeps itself.
    ...(printers === 'link' && keyRef ? { linkClientKey: readKeychainKey(keyRef) } : printers === 'link' && partnerKey ? { linkClientKey: linkKeyFrom(partnerKey) } : {}),
    linkCode: keyRef || partnerKey ? undefined : linkCodeFrom({ argvCode: values['link-code'], stateDir: values['link-state-dir'] ?? env('LINK_STATE_DIR'), envCode: env('LINK_CODE'), needed: printers === 'link' }),
    // The hub's key from its state directory is checked even when the code comes from the environment.
    linkHubKey: printers === 'link' ? (env('LINK_HUB_KEY') ?? readHubKey(values['link-state-dir'] ?? env('LINK_STATE_DIR'))) : undefined,
    policyFile: values.policy ?? env('POLICY'),
    logFile: values.log ?? env('LOG'),
    profilesDir: values['profiles-dir'] ?? env('PROFILES_DIR'),
    allowUrls: !(values['no-urls'] ?? flag('NO_URLS')),
  })
  // Logs go to stderr: stdout carries the protocol in stdio mode.
  const engineLine = ctx.slicer ? `engine ${ctx.slicer.kind}` : `no engine (${ctx.slicerUnavailable ?? ''})`
  process.stderr.write(`slicerx-mcp ${SERVER_VERSION}: ${engineLine}, printers ${ctx.printers?.kind ?? 'off'}, ${ctx.tools.length} gated tools, policy ${ctx.gate.policyPath ?? 'defaults'}, log ${ctx.gate.log.path}\n`)

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
  await createSlicerxServer(ctx).connect(new StdioServerTransport())
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
  process.stderr.write(`slicerx-mcp: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})

