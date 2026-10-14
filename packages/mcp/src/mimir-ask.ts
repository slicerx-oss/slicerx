// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A message to mimir in the open app, with pictures and PDF drawings from this computer: the files are read here, held
// to the chat's limits (4 files, 10 MB each, PNG, JPEG, WebP, GIF or PDF) and sent over the app link, where the message
// shows in the docked chat as the person's next one. The ask answers at once with the session; mimir_session reads
// back what mimir said and did, with the files each message carried. Offered while the app link is in use.
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { defineTool, FILE_LIMITS, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' }
const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', not_ready: 'not_configured', busy: 'busy', read_only: 'not_supported', denied: 'not_supported' }
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

async function call(link: AppLinkCaller, appName: string, method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await link.call<Record<string, unknown>>(method, args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it`, 'not_configured', { appLink: code })
    throw new ToolInputError(message, CODES[code] ?? 'internal_error')
  }
}

/** One file from disk, checked against the chat's limits before anything is sent. */
async function readOne(path: string): Promise<{ name: string; type: string; data: string }> {
  const name = basename(path)
  const type = TYPES[extname(path).toLowerCase()]
  if (!type) throw new ToolInputError(`${name} isn't an image or a PDF. Add a PNG, JPEG, WebP, GIF or PDF.`, 'unsupported_format')
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new ToolInputError(`no file at ${path}`, 'file_not_found')
  if (info.size > FILE_LIMITS.maxBytes) throw new ToolInputError(`${name} is over 10 MB.`, 'invalid_input')
  return { name, type, data: (await readFile(path)).toString('base64') }
}

export function mimirAskTools(link: AppLinkCaller, appName: string): PilotTool<never>[] {
  const ask = defineTool({
    name: 'mimir.ask',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Send mimir a message in the open ${appName} app, with up to 4 pictures or PDF drawings from this computer (PNG, JPEG, WebP, GIF or PDF, 10 MB each), for example a photo of what a part must fit or a dimensioned drawing. It shows in the docked chat as the person's next message, and mimir reads the files with it. Answers at once with the session id and the files as sent (a big picture is scaled down to 1568 px); read mimir's reply with slicerx_mimir_session. Refused while mimir is still answering.`,
    input: z.object({
      message: z.string().max(4000).default('').describe('What to ask mimir, as the person would type it'),
      files: z.array(z.string().min(1)).max(FILE_LIMITS.maxCount).default([]).describe('Paths of pictures or PDFs on this computer to attach'),
    }),
    async run(i) {
      if (!i.message.trim() && i.files.length === 0) throw new ToolInputError('send a message, files, or both', 'invalid_input')
      const files = []
      for (const p of i.files) files.push(await readOne(p))
      const out = await call(link, appName, 'mimir.ask', { message: i.message, files })
      const sent = (out['attachments'] as { name: string }[] | undefined) ?? []
      return { summary: `Sent to mimir in ${appName}${sent.length ? ` with ${sent.map((f) => f.name).join(', ')}` : ''}; read the reply with slicerx_mimir_session (session ${String(out['sessionId'])}).`, output: out }
    },
  })
  const session = defineTool({
    name: 'mimir.session',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read back a mimir conversation in the open ${appName} app, turn by turn: what was said and the files on each message, what mimir said, the tools it ran and how each ended, its questions and lookups. Without an id, the newest conversation.`,
    input: z.object({ id: z.string().min(1).max(200).optional().describe('A session id from slicerx_mimir_ask; the newest when left out') }),
    async run(i) {
      let id = i.id
      if (!id) {
        const list = (await call(link, appName, 'mimir.sessions', {}))['sessions'] as { id: string }[] | undefined
        id = list?.[0]?.id
        if (!id) throw new ToolInputError(`no mimir conversation in ${appName} yet`, 'not_found')
      }
      const out = await call(link, appName, 'mimir.session', { id })
      const turns = (out['turns'] as unknown[] | undefined)?.length ?? 0
      return { summary: `mimir session ${id}: ${turns} turn${turns === 1 ? '' : 's'}.`, output: out }
    },
  })
  return [ask, session] as PilotTool<never>[]
}
