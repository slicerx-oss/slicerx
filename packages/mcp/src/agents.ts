// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "Connect your AI agent": how each MCP client installs this server, one click where the
// client allows it. The panel (desktop and browser) calls `installSteps` and shows or runs the
// result. No secret is ever written into a client's config: the config names a keychain item
// (`agentKeyRef`) that holds this client's own hub credential, and the server reads it there
// at start. The hub's public key is pinned in the config, so the server talks only to this hub.

export type AgentClientId = 'claude-desktop' | 'claude-code' | 'cursor' | 'codex' | 'chatgpt'

export interface AgentClient {
  id: AgentClientId
  name: string
  /** How it installs: a deep link, a bundle file, a command, or not yet (needs the relay). */
  mechanism: 'deeplink' | 'bundle' | 'command' | 'remote'
  /** True when the client reaches only remote HTTPS servers, so it waits for the camera relay. */
  needsRelay: boolean
}

export const AGENT_CLIENTS: readonly AgentClient[] = [
  { id: 'claude-desktop', name: 'Claude Desktop', mechanism: 'bundle', needsRelay: false },
  { id: 'claude-code', name: 'Claude Code', mechanism: 'command', needsRelay: false },
  { id: 'cursor', name: 'Cursor', mechanism: 'deeplink', needsRelay: false },
  { id: 'codex', name: 'Codex', mechanism: 'command', needsRelay: false },
  { id: 'chatgpt', name: 'ChatGPT', mechanism: 'remote', needsRelay: true },
]

/** Server name every client shows. */
export const SERVER_ID = 'slicerx'

/** The keychain service holding a client's hub credential (account `slicerx`). */
export function agentKeyRef(client: AgentClientId): string {
  return `slicerx-agent-${client}`
}

export interface InstallInput {
  /** How the client starts this server, such as `node` and the path of `cli.js` in the app. */
  server: { command: string; args: string[] }
  /** The hub's public key (`hub-key.pub`), pinned. */
  hubKey: string
  /** sx-link's address. Default ws://127.0.0.1:47615. */
  linkUrl?: string
  /** The app the server belongs to, as clients list it: server name, display name and author. Default SlicerX. */
  app?: { id: string; name: string; author?: { name: string; url?: string } }
}

const SLICERX_APP = { id: SERVER_ID, name: 'SlicerX', author: { name: 'The SlicerX contributors', url: 'https://slicerx.app' } }

export type InstallStep =
  /** Open this link: the client asks the person to confirm and installs. */
  | { kind: 'deeplink'; url: string }
  /** Run this (the desktop app can run `argv` itself; the browser shows `text` to copy). */
  | { kind: 'command'; argv: string[]; text: string }
  /** A Claude Desktop extension manifest; packed with the server files as a .mcpb the person opens. */
  | { kind: 'bundle'; fileName: string; manifest: Record<string, unknown> }
  /** The same thing as a config file entry, for people who prefer to edit it. */
  | { kind: 'config'; path: string; format: 'json' | 'toml'; snippet: string }
  /** Not possible yet. */
  | { kind: 'waits'; reason: string }

/** The environment the server starts with for this client. Holds no secret. */
export function serverEnv(client: AgentClientId, input: InstallInput): Record<string, string> {
  return {
    SLICERX_MCP_PRINTERS: 'link',
    SLICERX_MCP_LINK_URL: input.linkUrl ?? 'ws://127.0.0.1:47615',
    SLICERX_MCP_LINK_HUB_KEY: input.hubKey,
    SLICERX_MCP_LINK_KEY_REF: agentKeyRef(client),
  }
}

const b64 = (text: string): string => (typeof btoa === 'function' ? btoa(text) : Buffer.from(text, 'utf8').toString('base64'))

/** POSIX shell quoting for the copyable form of a command. */
function sh(arg: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

const command = (argv: string[]): InstallStep => ({ kind: 'command', argv, text: argv.map(sh).join(' ') })

function toml(id: string, env: Record<string, string>, server: InstallInput['server']): string {
  const q = (s: string): string => JSON.stringify(s)
  return [
    `[mcp_servers.${id}]`,
    `command = ${q(server.command)}`,
    `args = [${server.args.map(q).join(', ')}]`,
    '',
    `[mcp_servers.${id}.env]`,
    ...Object.entries(env).map(([k, v]) => `${k} = ${q(v)}`),
  ].join('\n')
}

/** Where each OS keeps Claude Desktop's config. */
function claudeDesktopConfigPath(os: 'mac' | 'windows' | 'linux'): string {
  if (os === 'mac') return '~/Library/Application Support/Claude/claude_desktop_config.json'
  if (os === 'windows') return '%APPDATA%\\Claude\\claude_desktop_config.json'
  return '~/.config/Claude/claude_desktop_config.json'
}

/** Install steps for one client, the one-click way first. */
export function installSteps(client: AgentClientId, input: InstallInput, os: 'mac' | 'windows' | 'linux' = 'mac'): InstallStep[] {
  const env = serverEnv(client, input)
  const app = input.app ?? SLICERX_APP
  const id = app.id
  const stdio = { command: input.server.command, args: input.server.args, env }
  const json = JSON.stringify({ mcpServers: { [id]: stdio } }, null, 2)
  switch (client) {
    case 'cursor':
      return [
        { kind: 'deeplink', url: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(id)}&config=${encodeURIComponent(b64(JSON.stringify(stdio)))}` },
        { kind: 'config', path: '~/.cursor/mcp.json', format: 'json', snippet: json },
      ]
    case 'claude-code':
      return [
        command(['claude', 'mcp', 'add-json', id, JSON.stringify({ type: 'stdio', ...stdio }), '--scope', 'user']),
        { kind: 'config', path: '.mcp.json (one project) or claude mcp add-json --scope user', format: 'json', snippet: json },
      ]
    case 'codex':
      return [
        command(['codex', 'mcp', 'add', id, ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--', input.server.command, ...input.server.args]),
        { kind: 'config', path: '~/.codex/config.toml', format: 'toml', snippet: toml(id, env, input.server) },
      ]
    case 'claude-desktop':
      return [
        {
          kind: 'bundle',
          fileName: `${id}.mcpb`,
          manifest: {
            manifest_version: '0.3',
            name: id,
            display_name: app.name,
            version: '0.1.0',
            description: `Slice, plan settings, and read and control your printers through the ${app.name} hub on this computer.`,
            author: app.author ?? { name: app.name },
            license: 'Apache-2.0',
            server: { type: 'node', entry_point: 'server/cli.js', mcp_config: { command: 'node', args: ['${__dirname}/server/cli.js'], env } },
          },
        },
        { kind: 'config', path: claudeDesktopConfigPath(os), format: 'json', snippet: json },
      ]
    case 'chatgpt':
      return [
        {
          kind: 'waits',
          reason: `ChatGPT connects only to remote HTTPS servers, so it needs the camera relay that makes the hub reachable from outside this network, and OAuth into ${app.name}. It comes after v1.`,
        },
      ]
  }
}
