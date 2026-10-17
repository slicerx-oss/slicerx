// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the links journey shares: one sx-link hub and one paired app page per worker, and the clients that reach the
// app through them. Every link spec used to start its own hub (bridge-hub.ts useBridge), seed and boot its own page,
// wait for "this window hosts the app link" and answer a grant. Here the hub starts once for the worker, the journey
// page is paired with it once, and each test only makes a client (a new key, so a new grant) and answers its prompt.
// Runs only when SX_LINK_BIN names a built sx-link (cargo build -p sx-link); SX_LINK_REQUIRE=1 (CI) makes a missing
// binary a failure, as bridge-hub.ts does.
import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { ONBOARDING_VERSION } from '../../../../../packages/app/src/first-run/onboarding.ts'
import type { Admin } from '../../bridge-hub'
import { COLD_START_MS, plateReady } from '../../fixtures'
import { withClientCredential } from '../../client-credential'
import { interceptFileDialogs } from '../../file-dialog'
import { expect, journey } from '../../journey'

export { expect }

const bin = process.env['SX_LINK_BIN']
const required = process.env['SX_LINK_REQUIRE'] === '1'
/** True when there is no sx-link to run against and the run does not insist on one: the whole journey skips. */
export const linkMissing = !bin && !required

const root = join(import.meta.dirname, '../../../../..')
export const mcpDir = join(root, 'packages/mcp')
/** Resolves the MCP package's own dependencies (its SDK, tsx, esbuild), as its specs always have. */
export const mcpRequire = createRequire(join(mcpDir, 'package.json'))

export type Answer = { isError?: boolean; content?: { text?: string }[]; structuredContent?: { ok?: boolean; summary?: string; output?: any; error?: { code: string; message?: string; details?: unknown } } }
type McpClient = { connect(t: unknown): Promise<void>; callTool(p: { name: string; arguments: Record<string, unknown> }, s?: unknown, o?: { timeout?: number }): Promise<unknown>; listTools(): Promise<{ tools: { name: string }[] }>; close(): Promise<void> }
type McpServer = { connect(t: unknown): Promise<void>; close(): Promise<void> }
type Runtime = { createContext(o: Record<string, unknown>): Promise<{ printers?: { close?(): void } }>; createSlicerxServer(ctx: unknown): McpServer }

/** A client of the open app: calls tools, and answers the person's grant prompt when one comes up. */
export interface Agent {
  /** Calls a tool and returns its output; fails the test when the answer is an error. */
  call(tool: string, args?: Record<string, unknown>): Promise<any>
  /** Calls a tool and returns the whole answer, an error included. */
  raw(tool: string, args?: Record<string, unknown>): Promise<Answer>
  /** `slicerx-mcp call a b ...` as a command line: one JSON line per call. */
  cli(...calls: (string | Record<string, unknown>)[]): Promise<{ tool: string; ok: boolean; output: { output: any } }[]>
}

export interface Link {
  hub: { url: string; code: string; port: number; stateDir: string; admin: Admin }
  /** The MCP package's source bundled once for this worker, so a test needs no `pnpm build` of it. */
  runtime: string
  /** The client every test shares: slicerx-mcp over stdio with a remembered key, as Connect your AI agent sets it up. */
  agent(): Promise<Agent>
}

/** The person allows a client the first time it calls; a client already allowed is not asked again. */
export async function allowWhenAsked<T>(page: Page, call: Promise<T>): Promise<T> {
  const allow = page.getByTestId('app-link-allow')
  let done = false
  void call.then(
    () => void (done = true),
    () => void (done = true),
  )
  const asked = (async () => {
    while (!done) {
      if (await allow.isVisible()) {
        await expect(allow).toBeEnabled()
        await allow.click()
        return
      }
      await page.waitForTimeout(200)
    }
  })()
  const out = await call
  await asked
  return out
}

async function loadSdk(): Promise<{ Client: new (i: { name: string; version: string }) => McpClient; InMemoryTransport: { createLinkedPair(): [unknown, unknown] }; StdioClientTransport: new (p: { command: string; args: string[]; cwd: string; env?: Record<string, string>; stderr?: 'inherit' }) => unknown }> {
  const at = async (id: string) => (await import(pathToFileURL(mcpRequire.resolve(id)).href)) as Record<string, unknown>
  const { Client } = await at('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await at('@modelcontextprotocol/sdk/inMemory.js')
  const { StdioClientTransport } = await at('@modelcontextprotocol/sdk/client/stdio.js')
  return { Client, InMemoryTransport, StdioClientTransport } as never
}

const cleanEnv = (drop: string): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string' && !e[0].startsWith(drop)))

/** slicerx-mcp as a client runs it from source, checking the hub's key from the hub's state directory. */
const serverArgs = (link: Link['hub'], dir: string) => [mcpRequire.resolve('tsx/cli'), 'src/cli.ts', '--engine', 'stub', '--printers', 'link', '--link-url', link.url, '--link-state-dir', link.stateDir, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles')]

/**
 * `slicerx-mcp call` with only a hub code, as a script would run it: no key the hub remembers, so the app never asks
 * the person. Returns the exit code and the JSON lines it printed.
 */
export async function codeOnlyCli(link: Link, dir: string, ...calls: string[]): Promise<{ code: number; rows: { tool?: string; ok: boolean; output: { error: { code: string; message: string; details?: unknown } } }[] }> {
  const result = await promisify(execFile)(process.execPath, [...serverArgs(link.hub, dir), 'call', ...calls], { cwd: mcpDir, env: cleanEnv('SLICERX_MCP_'), timeout: 60_000 }).then(
    (out) => ({ ...out, code: 0 }),
    (error: { code: number; stdout: string }) => error,
  )
  return { code: result.code, rows: result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)) }
}

/** An in-process MCP client with its own key, so its own grant: read-only or edit, answered in the app. */
export interface Session {
  call(tool: string, args?: Record<string, unknown>): Promise<Answer>
  /** The output of a call that must succeed. */
  ok(tool: string, args?: Record<string, unknown>): Promise<any>
  close(): Promise<void>
}

export async function session(link: Link, page: Page, dir: string, name: string, access: 'read' | 'edit', extra: Record<string, unknown> = {}): Promise<Session> {
  const { Client, InMemoryTransport } = await loadSdk()
  const { createContext, createSlicerxServer } = (await import(pathToFileURL(link.runtime).href)) as Runtime
  const { clientKey } = await link.hub.admin.clients.create(name, 'agent')
  const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: link.hub.url, linkHubKey: link.hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: join(dir, name), profilesDir: join(dir, 'profiles'), policyFile: join(dir, 'policy.json'), ...extra })
  const server = createSlicerxServer(ctx)
  const client = new Client({ name, version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const call = (tool: string, args: Record<string, unknown> = {}) => client.callTool({ name: `slicerx_${tool}`, arguments: args }, undefined, { timeout: 60_000 }) as Promise<Answer>
  // The first call has the person's answer to wait for: the buttons arm after a moment.
  const pending = call('design_list')
  const grant = page.getByTestId(access === 'read' ? 'app-link-read' : 'app-link-allow')
  await expect(grant).toBeEnabled({ timeout: 30_000 })
  await grant.click()
  expect((await pending).isError).not.toBe(true)
  return {
    call,
    ok: async (tool, args) => {
      const out = await call(tool, args)
      expect(out.isError, JSON.stringify(out)).not.toBe(true)
      return out.structuredContent!.output
    },
    close: async () => {
      await client.close()
      await server.close()
      ctx.printers?.close?.()
    },
  }
}

/** A directory for one test's scratch files and a policy file that allows everything; removed when `use` ends. */
export async function scratch<T>(prefix: string, use: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `sx-link-${prefix}-`))
  writeFileSync(join(dir, 'policy.json'), '{}')
  try {
    return await use(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

type Sx = { getState(): Record<string, any>; setState(p: unknown): void }
export const sx = {
  /** One top-level key of the app's store; a key holding big values (the plate's meshes) is read inside the page instead. */
  get: (page: Page, key: string): Promise<any> => page.evaluate((k) => (window as unknown as { __sx: Sx }).__sx.getState()[k], key),
  set: (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => (window as unknown as { __sx: Sx }).__sx.setState(p), patch),
}

/** The plate emptied back to one plate with nothing selected, on the tab and in the mode a test names. */
export async function cleanPlate(page: Page, mode: 'slice' | 'design' = 'slice'): Promise<void> {
  await page.keyboard.press('Escape')
  await sx.set(page, { plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', plate: [], selection: null, selectedIds: [] })
  await page.locator(`.sx-tab[data-mode="${mode}"]`).click()
}

/** For `test.use({ journeyPrefs })`: first-run done and the Slice tab in Advanced, as bridge-hub.ts seed() leaves it, and CAD tools on. */
export const linkPrefs = { workspace: 'prepare', settingsMode: 'advanced', cadTools: true, firstRun: { completedAt: '2026-10-01T00:00:00.000Z', step: 'done', look: { id: 'slicerx' }, printerId: null, version: ONBOARDING_VERSION } }

export const test = journey.extend<object, { sxLink: Link['hub']; paired: Page; link: Link }>({
  // One sx-link on a free loopback port with throwaway state, as useBridge starts it, with no mock printers.
  sxLink: [
    async ({}, use, worker) => {
      if (!bin || !existsSync(bin)) throw new Error(`There is no sx-link at ${bin || '(SX_LINK_BIN is not set)'}: build it (cargo build -p sx-link) and name it in SX_LINK_BIN`)
      const { connectLink } = await import('../../../../../packages/connect/link-client/src/index.ts')
      const stateDir = mkdtempSync(join(tmpdir(), 'sx-link-e2e-'))
      // A release hub hosts only the desktop origin or one explicitly allowed at startup.
      const appOrigin = new URL(worker.project.use.baseURL!).origin
      const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(bin, ['--port', '0', '--state-dir', stateDir, '--secrets', 'file', '--no-mdns', '--allow-origin', appOrigin, ...(process.env['SX_TEST_LAN'] === '1' ? [] : ['--loopback'])], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let code = ''
      let port = 0
      const url = await new Promise<string>((resolve, reject) => {
        proc.stdout.on('data', (d: Buffer) => {
          out += d.toString()
          const u = /ws:\/\/127\.0\.0\.1:\d+/.exec(out)
          const c = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)
          if (u && c) {
            code = c[1] ?? ''
            port = Number(u[0].slice(u[0].lastIndexOf(':') + 1))
            resolve(u[0])
          }
        })
        proc.once('exit', () => reject(new Error('sx-link exited early')))
      })
      const admin = (await connectLink({ url, code })) as unknown as Admin
      // The person turns on Let agents use the open project.
      await admin.settings.set({ appLink: true })
      await use({ url, code, port, stateDir, admin })
      admin.close()
      // A hub that ignores the signal is killed outright after 10 s.
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise<void>((r) => proc.once('exit', () => r()))
        proc.kill()
        const late = setTimeout(() => proc.kill('SIGKILL'), 10_000)
        await exited
        clearTimeout(late)
      }
      rmSync(stateDir, { recursive: true, force: true })
    },
    { scope: 'worker', timeout: 60_000 },
  ],

  // The journey page paired with the hub, the way the desktop shell pairs its window: the test shell hook names the hub
  // and the bridge connects on its own with the app link on. Pairing is once for the worker, so the page reloads once.
  paired: [
    async ({ app, sxLink }, use) => {
      interceptFileDialogs(app)
      const hosting: string[] = []
      app.on('console', (m) => {
        if (m.text().startsWith('[app link]')) hosting.push(m.text())
      })
      await app.addInitScript(
        ({ shell, port }) => {
          Object.assign(window, { __sxTestShell: shell, __sxTestHubPort: port })
          localStorage.setItem('slicerx.debug', '1')
        },
        { shell: { url: sxLink.url, code: sxLink.code, hubKey: sxLink.admin.hubKey }, port: sxLink.port },
      )
      await app.reload()
      await plateReady(app)
      await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
      await expect.poll(async () => (await sx.get(app, 'bridgeStatus')).state, { timeout: 30_000 }).toBe('on')
      await use(app)
    },
    { scope: 'worker', timeout: COLD_START_MS + 60_000 },
  ],
  link: [
    async ({ sxLink, paired }, use) => {
      const { build } = (await import(pathToFileURL(mcpRequire.resolve('esbuild')).href)) as { build(o: Record<string, unknown>): Promise<unknown> }
      const dir = mkdtempSync(join(mcpDir, '.link-runtime-'))
      const runtime = join(dir, 'index.mjs')
      await build({ entryPoints: [join(mcpDir, 'src/index.ts')], outfile: runtime, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
      const home = mkdtempSync(join(tmpdir(), 'sx-link-agent-'))
      let agent: Promise<Agent> | undefined
      let client: McpClient | undefined
      let held: Promise<void> | undefined
      let release: (() => void) | undefined
      const link: Link = {
        hub: sxLink,
        runtime,
        agent: () => (agent ??= new Promise<Agent>((resolve, reject) => {
          // The remembered credential lives as long as the callback runs (it is removed after, on Windows too), so the
          // callback stays open until the worker is done with the client.
          held = (async () => {
            const { Client, StdioClientTransport } = await loadSdk()
            const { clientKey } = await sxLink.admin.clients.create('journey agent', 'agent')
            await withClientCredential(home, clientKey!, async (env) => {
              const args = serverArgs(sxLink, home)
              client = new Client({ name: 'journey-agent', version: '0.0.0' })
              await client.connect(new StdioClientTransport({ command: process.execPath, args, cwd: mcpDir, env, stderr: 'inherit' }))
              const page = paired
              const raw = (tool: string, a: Record<string, unknown> = {}) => allowWhenAsked(page, client!.callTool({ name: tool, arguments: a }, undefined, { timeout: 90_000 }) as Promise<Answer>)
              resolve({
                raw: (tool, a) => raw(tool.startsWith('slicerx_') ? tool : `slicerx_${tool}`, a),
                call: async (tool, a) => {
                  const answer = await raw(tool.startsWith('slicerx_') ? tool : `slicerx_${tool}`, a)
                  expect(answer.isError, JSON.stringify(answer)).toBeFalsy()
                  return answer.structuredContent!.output
                },
                cli: async (...calls) => {
                  const argv = calls.flatMap((c) => (typeof c === 'string' ? [c] : [JSON.stringify(c)]))
                  const { stdout } = await allowWhenAsked(page, promisify(execFile)(process.execPath, [...args, 'call', ...argv], { cwd: mcpDir, env, windowsHide: true, timeout: 120_000 }))
                  return stdout.trim().split('\n').map((l) => JSON.parse(l))
                },
              })
              await new Promise<void>((done) => (release = done))
            })
          })().catch(reject)
        })),
      }
      await use(link)
      await client?.close().catch(() => undefined)
      release?.()
      await held
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
    { scope: 'worker', timeout: 120_000 },
  ],

  page: async ({ paired }, use) => {
    await use(paired)
  },
})

