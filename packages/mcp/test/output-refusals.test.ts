// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { connect, data, sxBin, text } from './helpers'

describe('listed output schemas', () => {
  for (const name of ['slicerx_slice_file', 'slicerx_estimate_file']) {
    it(`${name} returns a missing-file refusal through the SDK client`, async () => {
      const h = await connect({ engine: 'sx', sxBin })
      try {
        const { tools } = await h.client.listTools()
        expect(tools.find(t => t.name === name)?.outputSchema).toBeDefined()
        const result = await h.client.callTool({ name, arguments: { model: join(h.dir, 'missing.stl') } }) as CallToolResult
        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/^Error: file_not_found: /)
        expect(data(result)).toMatchObject({ error: { code: 'file_not_found', message: expect.any(String) } })
      } finally {
        await h.client.close()
        rmSync(h.dir, { recursive: true, force: true })
      }
    })
  }

  it('every advertised output schema accepts structured refusals and permission decisions', async () => {
    const h = await connect()
    try {
      const { tools } = await h.client.listTools()
      const schemas = tools.filter(t => t.outputSchema)
      expect(schemas.length).toBeGreaterThan(0)
      const ajv = new Ajv2020({ strict: false })
      for (const tool of schemas) {
        const validate = ajv.compile(tool.outputSchema!)
        for (const refusal of [
          { error: { code: 'file_not_found', message: 'Missing model', details: { file: 'missing.stl' } } },
          { status: 'off', permission: 'write' },
          { status: 'denied', request_id: 'request-1' },
          { status: 'needs_person', request_id: 'request-1' },
        ]) expect(validate(refusal), `${tool.name}: ${JSON.stringify(validate.errors)}`).toBe(true)
      }
    } finally { await h.client.close(); rmSync(h.dir, { recursive: true, force: true }) }
  })

  it('reports the package version during SDK initialization', async () => {
    const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    const h = await connect()
    try { expect(h.client.getServerVersion()?.version).toBe(expected) }
    finally { await h.client.close(); rmSync(h.dir, { recursive: true, force: true }) }
  })
})
