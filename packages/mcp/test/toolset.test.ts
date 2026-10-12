// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design toolset is the one definition of the design and CAD tools: the server lists exactly these, and a host
// with no files (the app's plate) runs the same tools, refusing only the calls that need a file.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Designs } from '../src/design'
import { ToolInputError } from '../src/errors'
import { mcpName } from '../src/gate'
import { designToolset } from '../src/toolset'
import { connect } from './helpers'

const noEngine = async (op: string): Promise<never> => {
  throw new Error(`no engine call expected (${op})`)
}

function host(): Designs {
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-toolset-'))
  return new Designs({ engine: noEngine, policy: { allowDirs: [dir], allowUrls: false, outDir: join(dir, 'out') } })
}

const run = (tools: ReturnType<typeof designToolset>, name: string, input: unknown) => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.run(input as never, {} as never)
}

describe('design toolset', () => {
  it('is what the server lists, tool for tool', async () => {
    const h = await connect({ geomEngine: noEngine })
    const listed = new Map((await h.client.listTools()).tools.map((t) => [t.name, t.description]))
    const tools = designToolset(host())
    expect(tools.length).toBeGreaterThan(10)
    for (const t of tools) expect(listed.get(mcpName(t.name)), t.name).toMatch(t.description)
  })

  it('runs on a host with no files and refuses only the file calls', async () => {
    const tools = designToolset(host())
    const started = (await run(tools, 'design.new', { name: 'Backplate' })) as { output: { design: string; steps: number } }
    expect(started.output).toMatchObject({ design: 'd1', steps: 0 })
    const listed = (await run(tools, 'design.list', {})) as { output: { designs: { design: string }[] } }
    expect(listed.output.designs.map((d) => d.design)).toEqual(['d1'])
    for (const [name, input] of [
      ['design.new', { name: 'From a file', from: 'sample:x-mark' }],
      ['design.open', { path: '/tmp/part.3mf' }],
    ] as const) {
      const err = await run(tools, name, input).catch((e: unknown) => e)
      expect(err, name).toBeInstanceOf(ToolInputError)
      expect((err as ToolInputError).code).toBe('not_supported')
    }
  })
})
