// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The person's files reach the model on every provider path: a message with a picture and a PDF, sent the way the
// chat sends it, goes out in the provider request as an image and a document. A local server reads no PDFs, so that
// path says so in words and makes no call.
import { DEFAULT_POLICY, type ApprovalHost, type LlmHttpRequest, type LlmTransport, type PilotAttachment, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createPilot, DEFAULT_CONFIG, FILE_LIMITS, modelFiles } from '../src/index'

// a 1 by 1 PNG and a tiny one page PDF
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF').toString('base64')

const picture: PilotAttachment = { id: 'a1', name: 'sketch.png', type: 'image/png', bytes: 70, url: `data:image/png;base64,${PNG}` }
const drawing: PilotAttachment = { id: 'a2', name: 'bracket.pdf', type: 'application/pdf', bytes: 200, url: `data:application/pdf;base64,${PDF}` }

const CLOUD = 'https://abcdefghijklmnop.supabase.co/functions/v1/mimir'

function setup(provider: string, baseUrl?: string) {
  const sent: LlmHttpRequest[] = []
  const llm: LlmTransport = {
    available: async () => true,
    // eslint-disable-next-line require-yield
    async *stream(req) {
      sent.push(req)
    },
  }
  const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm }
  const pilot = createPilot({ host, config: { ...DEFAULT_CONFIG, provider, model: provider === 'openai' ? 'gpt-5.6-luna' : 'claude-haiku-5-5', ...(baseUrl ? { baseUrl } : {}) }, policy: DEFAULT_POLICY, builtins: false, tools: [] })
  return { sent, pilot }
}

async function send(pilot: ReturnType<typeof createPilot>, files: PilotAttachment[]): Promise<PilotEvent[]> {
  const out: PilotEvent[] = []
  for await (const e of pilot.run('s1', 'Make a bracket that fits this.', { attachments: files })) out.push(e)
  return out
}

const userMessages = (req: LlmHttpRequest): Record<string, unknown>[] => {
  const body = JSON.parse(req.body) as { messages?: Record<string, unknown>[]; input?: Record<string, unknown>[] }
  return (body.messages ?? body.input ?? []).filter((m) => m['role'] === 'user')
}

describe('attachments reach the model', () => {
  for (const [provider, baseUrl] of [['anthropic', undefined], ['mimir-cloud', CLOUD]] as const) {
    it(`${provider}: a picture as an image block and a PDF as a document block`, async () => {
      const { sent, pilot } = setup(provider, baseUrl)
      await send(pilot, [picture, drawing])
      expect(sent.length).toBeGreaterThan(0)
      const content = userMessages(sent[0]!).at(-1)!['content'] as Record<string, unknown>[]
      expect(content).toContainEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'bracket.pdf' })
      expect(content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } })
      const text = content.find((b) => b['type'] === 'text')!['text'] as string
      expect(text).toContain('Make a bracket that fits this.')
      expect(text).toContain('Attached: sketch.png (picture), bracket.pdf (PDF)')
    })
  }

  it('openai: a picture as an input image and a PDF as an input file', async () => {
    const { sent, pilot } = setup('openai')
    await send(pilot, [picture, drawing])
    const content = userMessages(sent[0]!).at(-1)!['content'] as Record<string, unknown>[]
    expect(content).toContainEqual({ type: 'input_file', filename: 'bracket.pdf', file_data: `data:application/pdf;base64,${PDF}` })
    expect(content).toContainEqual({ type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'high' })
    expect(content.some((b) => b['type'] === 'input_text' && String(b['text']).includes('Make a bracket'))).toBe(true)
  })

  it('openai-compatible: a picture goes as an image part', async () => {
    const { sent, pilot } = setup('openai-compatible', 'http://127.0.0.1:11434/v1')
    await send(pilot, [picture])
    const content = userMessages(sent[0]!).at(-1)!['content'] as Record<string, unknown>[]
    expect(content).toContainEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } })
  })

  it('openai-compatible: a PDF is refused in words and nothing is sent', async () => {
    const { sent, pilot } = setup('openai-compatible', 'http://127.0.0.1:11434/v1')
    const events = await send(pilot, [picture, drawing])
    expect(sent).toHaveLength(0)
    const said = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
    expect(said).toMatch(/can't read PDFs, so bracket\.pdf wasn't sent/)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
  })

  it('files stay on the conversation for the next message', async () => {
    const { sent, pilot } = setup('anthropic')
    await send(pilot, [drawing])
    for await (const _ of pilot.run('s1', 'Make it 2 mm thicker.')) void _
    const users = userMessages(sent.at(-1)!)
    expect(JSON.stringify(users)).toContain(PDF)
  })
})

describe('file limits', () => {
  const big = (n: number): PilotAttachment => ({ ...drawing, url: `data:application/pdf;base64,${'A'.repeat(Math.ceil((n * 4) / 3))}` })

  it('keeps four files and 10 MB each', () => {
    expect(modelFiles([picture, picture, picture, picture, picture], 'anthropic')).toEqual({ problem: 'A message holds up to 4 files.' })
    expect(modelFiles([big(FILE_LIMITS.maxBytes + 10)], 'anthropic')).toEqual({ problem: 'bracket.pdf is over 10 MB.' })
    expect(modelFiles([{ ...picture, name: 'a.txt', type: 'text/plain', url: 'data:text/plain;base64,aGk=' }], 'anthropic')).toMatchObject({ problem: expect.stringMatching(/isn't an image or a PDF/) })
  })

  it('caps what one conversation carries', () => {
    expect(modelFiles([big(9 * 1024 * 1024)], 'anthropic', 7 * 1024 * 1024)).toMatchObject({ problem: expect.stringMatching(/Start a new conversation/) })
    expect(modelFiles([big(9 * 1024 * 1024)], 'anthropic', 0)).toMatchObject({ documents: [expect.objectContaining({ name: 'bracket.pdf' })] })
  })
})
