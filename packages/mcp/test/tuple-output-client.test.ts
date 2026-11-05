// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client on the MCP SDK reads tools/list, then checks each structured result against the tool's output schema with
// its default validator, a draft-07 Ajv. That validator does not know 2020-12 `prefixItems`, so a tuple published as
// `prefixItems` plus `items: false` reads to it as an array that may hold no items, and every box or point comes back
// as -32602. Tuples are listed with `prefixItems` and their length (`minItems`, `maxItems`) only.
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { connect, data } from './helpers'

const fixtures = join(import.meta.dirname, '..', '..', 'step-reader', 'test', 'fixtures')

/**
 * Tuples a draft-07 reader gets wrong: `items` beside `prefixItems` (which that reader applies to every item), or a
 * tuple with no `maxItems`, whose length only `items: false` held.
 */
function tupleProblems(node: unknown, path = '#'): string[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => tupleProblems(v, `${path}/${i}`))
  if (!node || typeof node !== 'object') return []
  const o = node as Record<string, unknown>
  const here = !Array.isArray(o['prefixItems'])
    ? []
    : [
        ...('items' in o ? [`${path} has items ${JSON.stringify(o['items'])}`] : []),
        ...(o['maxItems'] === (o['prefixItems'] as unknown[]).length ? [] : [`${path} has maxItems ${String(o['maxItems'])}`]),
      ]
  return [...here, ...Object.entries(o).flatMap(([k, v]) => tupleProblems(v, `${path}/${k}`))]
}

describe('tuple outputs read through the SDK client', () => {
  it('slicerx_step_read answers after tools/list on the same connection', async () => {
    const h = await connect()
    try {
      copyFileSync(join(fixtures, 'assembly-colors.step'), join(h.dir, 'assembly-colors.step'))
      const listed = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_step_read')
      expect(listed?.outputSchema).toBeDefined()
      const r = (await h.client.callTool({ name: 'slicerx_step_read', arguments: { model: join(h.dir, 'assembly-colors.step') } })) as CallToolResult
      expect(r.isError).toBeFalsy()
      const info = data<{ bounds: { min: number[]; max: number[] } }>(r)
      expect(info.bounds.min).toHaveLength(3)
      expect(info.bounds.max).toHaveLength(3)
    } finally {
      await h.client.close()
    }
  })

  it('every listed tuple drops items and keeps its length', async () => {
    const h = await connect({ geomEngine: (async () => ({})) as never })
    const { tools } = await h.client.listTools()
    expect(tools.some((t) => t.name === 'slicerx_geom_cut')).toBe(true)
    const bad = tools.flatMap((t) => [
      ...tupleProblems(t.inputSchema).map((p) => `${t.name} input ${p}`),
      ...tupleProblems(t.outputSchema).map((p) => `${t.name} output ${p}`),
    ])
    expect(bad).toEqual([])
    const step = tools.find((t) => t.name === 'slicerx_step_read')!
    const box = JSON.stringify(step.outputSchema)
    expect(box).toContain('"prefixItems":[{"type":"number"},{"type":"number"},{"type":"number"}],"minItems":3,"maxItems":3')
  })
})
