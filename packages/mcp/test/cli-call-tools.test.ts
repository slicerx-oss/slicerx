// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// `slicerx-mcp call` against the tool list, both run the way a client runs them: as their own processes. Every tool the
// stdio server lists (tools/list) can be named to `call`, with or without its slicerx_ prefix, and `call` refuses a
// name the server doesn't list, with exit code 1 and the reason in plain words: no "MCP error <code>:" in front, the
// prefix the MCP SDK's own errors carry.
//
// The boundary: a listed tool that needs arguments only has to be reached. It is sent arguments its own input schema
// rejects, so the server finds it by name and answers "Invalid arguments for tool <name>", and its handler never runs.
// Only read-only tools and in-memory project edits run for real, on the simulated demo printers (--printers demo), in a
// throwaway home and output directory, so nothing here can start a print or touch a real printer or the user's files.
//
// Each `call` run starts a whole server (a few seconds), so the default run sends every listed tool through one stdio
// server and keeps `call` to a few runs. SX_MCP_CALL_SWEEP=1 also gives every listed tool a `call` run of its own.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

const PKG = resolve(__dirname, '..')

/** Demo tools that answer for real with no arguments on any machine: reads, plus opening an empty project. */
const RUN_FOR_REAL = ['printer_list', 'slicerx_fleet_overview', 'spool_inventory', 'slicerx_project_open', 'project_show', 'slicerx_get_policy', 'list_fleets', 'slicerx_list_profiles', 'pending_approvals', 'slicerx_theme_get']

/** Tools with no arguments to reject that may still run in the sweep: they change only the in-memory project. */
const IN_MEMORY_EDITS = new Set(['slicerx_project_plate_add'])

/** The process environment of a run: nothing from the caller's own setup, and a home of its own (no user policy). */
function runEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('SLICERX_') && k !== 'SX_TEST_HUB_PORT') env[k] = v
  env['HOME'] = home
  env['USERPROFILE'] = home
  return env
}

const cliArgs = (dir: string, printers: 'demo' | 'off', extra: string[] = []) => ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--printers', printers, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), ...extra]

/** A client of the stdio server it spawned, and the tools the server lists to it, every page of them. */
async function stdioServer(parent: string, printers: 'demo' | 'off'): Promise<{ client: Client; tools: Tool[] }> {
  const dir = mkdtempSync(join(parent, 'stdio-'))
  const client = new Client({ name: 'call-tools-test', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: cliArgs(dir, printers), cwd: PKG, env: runEnv(dir), stderr: 'pipe' }))
  const tools: Tool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : {})
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  return { client, tools }
}

async function listed(parent: string, printers: 'demo' | 'off'): Promise<Tool[]> {
  const { client, tools } = await stdioServer(parent, printers)
  await client.close()
  return tools
}

type Schema = { type?: unknown; properties?: Record<string, { type?: unknown }>; required?: string[]; anyOf?: Schema[]; oneOf?: Schema[] }

/**
 * Arguments the tool's own input schema rejects, so a call reaches the tool without running it: none at all when it
 * needs some, else one argument of the wrong type. Undefined when the schema rejects nothing (a tool with no
 * arguments), and for a schema this can't read.
 */
function rejected(tool: Tool): Record<string, unknown> | undefined {
  const s = tool.inputSchema as Schema
  const branches = s.anyOf ?? s.oneOf
  if (s.required?.length || (branches?.length && branches.every((b) => b.required?.length))) return {}
  if (branches?.length) return undefined
  for (const [name, prop] of Object.entries(s.properties ?? {})) {
    if (prop.type === 'string') return { [name]: 0 }
    if (typeof prop.type === 'string') return { [name]: 'not a value of this type' }
  }
  return undefined
}

const textOf = (r: CallToolResult) => r.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
const refusedArgs = (name: string) => `Invalid arguments for tool ${name}`

interface Run {
  code: number
  stdout: string
  stderr: string
}

/** One `slicerx-mcp call ...` run, in a directory of its own; one that outlives the limit is stopped (by its pid). */
function call(parent: string, words: string[], printers: 'demo' | 'off' = 'demo'): Promise<Run> {
  const dir = mkdtempSync(join(parent, 'call-'))
  return new Promise((done) => {
    execFile(process.execPath, cliArgs(dir, printers, ['call', ...words]), { cwd: PKG, env: runEnv(dir), timeout: 50_000 }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr })
    })
  })
}

const lines = (out: string) => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; ok: boolean; text: string })

// The runs are separate processes with directories of their own, so the cases run at once.
describe.concurrent('slicerx-mcp call and the tool list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-call-tools-'))
  let server: Client
  let tools: Tool[] = []

  beforeAll(async () => {
    ;({ client: server, tools } = await stdioServer(dir, 'demo'))
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists every tool under a name call takes, with or without the slicerx_ prefix', () => {
    const names = tools.map((t) => t.name)
    expect(names.length).toBeGreaterThan(50)
    expect(new Set(names).size).toBe(names.length)
    // call adds the prefix to a name without it, so a listed name without the prefix could never be called.
    expect(names.filter((n) => !/^slicerx_[a-z0-9_]+$/.test(n))).toEqual([])
  })

  it('reaches every listed tool by name: it answers with its own argument check or its own result, never "not found"', async () => {
    const wrong: string[] = []
    for (const tool of tools) {
      const args = rejected(tool)
      const real = !args && (tool.annotations?.readOnlyHint === true || IN_MEMORY_EDITS.has(tool.name))
      // A tool that has no arguments to reject and may change something needs a look before it runs here.
      if (!args && !real) {
        wrong.push(`${tool.name}: not run, since it has no arguments to reject and is not read-only; add it to IN_MEMORY_EDITS once it is safe to run`)
        continue
      }
      const said = textOf((await server.callTool({ name: tool.name, arguments: args ?? {} })) as CallToolResult)
      if (/not found/i.test(said) && said.includes(tool.name)) wrong.push(`${tool.name}: ${said}`)
      else if (args && !said.includes(refusedArgs(tool.name))) wrong.push(`${tool.name}: expected its argument check, got ${said.slice(0, 200)}`)
    }
    expect(wrong).toEqual([])
  }, 120_000)

  it('runs listed demo tools for real, named with and without the prefix, and exits 0', async () => {
    const full = RUN_FOR_REAL.map((n) => (n.startsWith('slicerx_') ? n : `slicerx_${n}`))
    expect(full.filter((n) => !tools.some((t) => t.name === n))).toEqual([])
    const r = await call(dir, RUN_FOR_REAL)
    expect(r.stderr).toContain('printers demo')
    expect(r.code, r.stderr).toBe(0)
    const out = lines(r.stdout)
    expect(out.map((o) => o.tool)).toEqual(full)
    expect(out.filter((o) => !o.ok)).toEqual([])
  }, 60_000)

  it('refuses a name the server does not list, with exit code 1, and runs nothing after it', async () => {
    expect(tools.some((t) => t.name === 'slicerx_no_such_tool')).toBe(false)
    const r = await call(dir, ['printer_list', 'no_such_tool', 'get_policy'])
    expect(r.code).toBe(1)
    const out = lines(r.stdout)
    expect(out.map((o) => [o.tool, o.ok])).toEqual([
      ['slicerx_printer_list', true],
      ['slicerx_no_such_tool', false],
    ])
    expect(out[1]!.text).toBe('Tool slicerx_no_such_tool not found')
  }, 60_000)

  it('refuses a tool another setup lists but this one does not', async () => {
    // Printer tools are listed with demo or real printers, and not with --printers off.
    expect(tools.some((t) => t.name === 'slicerx_printer_list')).toBe(true)
    const [off, r] = await Promise.all([listed(dir, 'off'), call(dir, ['printer_list'], 'off')])
    expect(off.some((t) => t.name === 'slicerx_printer_list')).toBe(false)
    expect(r.code).toBe(1)
    expect(lines(r.stdout)).toEqual([expect.objectContaining({ tool: 'slicerx_printer_list', ok: false, text: 'Tool slicerx_printer_list not found' })])
  }, 60_000)

  it('refuses arguments the tool schema rejects in plain words, with exit code 1', async () => {
    const r = await call(dir, ['project_open', '{"printer":5}'])
    expect(r.code).toBe(1)
    const [line, ...more] = lines(r.stdout)
    expect(more).toEqual([])
    expect(line).toMatchObject({ tool: 'slicerx_project_open', ok: false })
    expect(line!.text.startsWith(`Input validation error: ${refusedArgs('slicerx_project_open')}: `), line!.text).toBe(true)
    expect(r.stdout + r.stderr).not.toContain('MCP error')
  }, 60_000)
})

describe.skipIf(process.env['SX_MCP_CALL_SWEEP'] !== '1')('every listed tool through a call run of its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-call-sweep-'))

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reaches each one by its short name', async () => {
    const tools = await listed(dir, 'demo')
    const wrong: string[] = []
    const queue = [...tools]
    const worker = async () => {
      for (let tool = queue.shift(); tool; tool = queue.shift()) {
        const args = rejected(tool)
        if (!args && tool.annotations?.readOnlyHint !== true && !IN_MEMORY_EDITS.has(tool.name)) {
          wrong.push(`${tool.name}: not run (no arguments to reject, not read-only)`)
          continue
        }
        const r = await call(dir, [tool.name.replace(/^slicerx_/, ''), JSON.stringify(args ?? {})])
        const [line, ...more] = lines(r.stdout)
        if (!line || more.length || line.tool !== tool.name) wrong.push(`${tool.name}: exit ${r.code}, ${r.stdout}${r.stderr}`)
        else if (/not found/i.test(line.text)) wrong.push(`${tool.name}: ${line.text}`)
        else if (args && (r.code !== 1 || !line.text.includes(refusedArgs(tool.name)))) wrong.push(`${tool.name}: expected its argument check, got exit ${r.code}, ${line.text.slice(0, 200)}`)
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, availableParallelism() - 1)) }, worker))
    expect(wrong).toEqual([])
  }, 900_000)
})
