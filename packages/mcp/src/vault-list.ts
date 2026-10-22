// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Vault designs as the open app's Vault lists them, over the app link (`vault.list`). The app reads them with its own
// store client and the person's session, so a client sees what the person would: the catalog signed in or out, and the
// person's Saved list and own uploads only while they are signed in. This server holds no account key or session of
// its own, and nothing here downloads, likes, saves or changes a design.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

export const VAULT_LISTS = ['all', 'saved', 'mine'] as const
export type VaultList = (typeof VAULT_LISTS)[number]

/** One design as the app answers it (packages/app app-link/vault.ts). */
export interface VaultDesign {
  id: string
  slug: string
  title: string
  creator: { handle: string; displayName: string }
  license: string
  tags: string[]
  status: string
  publishedAt: string | null
  version: {
    version: string
    format: string
    colors: { hex: string; name: string | null }[]
    sizeMm: [number, number, number] | null
    print: { printer: string; timeS: number | null; grams: number | null } | null
  } | null
  stats: { downloads: number; makes: number; likes: number } | null
  liked: boolean | null
  saved: boolean | null
}

export interface VaultPage {
  list: VaultList
  signedIn: boolean
  items: VaultDesign[]
  next: string | null
}

const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']
const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', signed_out: 'signed_out', not_ready: 'not_configured', not_found: 'not_supported', refused: 'service_error', busy: 'busy', read_only: 'not_supported', denied: 'not_supported' }

async function call(link: AppLinkCaller | undefined, appName: string, args: Record<string, unknown>): Promise<VaultPage> {
  if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
  try {
    return await link.call<VaultPage>('vault.list', args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it, so its Vault cannot be read.`, 'not_configured', { appLink: code })
    throw new ToolInputError(message, CODES[code] ?? 'service_error', code ? { appLink: code } : undefined)
  }
}

const where = (list: VaultList, appName: string): string => (list === 'all' ? `in the ${appName} Vault` : list === 'saved' ? `on the Saved list in ${appName}` : `uploaded by the person in ${appName}`)
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function summary(p: VaultPage, appName: string): string {
  const sized = p.items.filter((d) => d.version?.sizeMm).length
  const head = p.items.length ? `${plural(p.items.length, 'design')} ${where(p.list, appName)}` : `No designs ${where(p.list, appName)}${p.next ? ' on this page' : ''}`
  const sizes = p.items.length ? `, ${sized} with a size` : ''
  const more = p.next ? `; more with cursor ${p.next}` : ''
  return `${head}${sizes}${more}${p.signedIn ? '' : ' (signed out)'}.`
}

const defined = (i: Record<string, unknown>) => Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined))

export function appVaultTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const list = defineTool({
    name: 'vault.list',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `List Vault designs in ${appName} as its Vault shows them, read by the open app with its own store and the person's session: list is all (the approved catalog, signed in or out), saved (the person's Saved list) or mine (the person's own uploads in every status, with their review status); saved and mine answer signed_out while nobody is signed in. Each design has id, slug, title, creator (handle and displayName), license, tags, status, publishedAt, version (version, format, colors with hex and name, sizeMm as x, y and z in mm from the upload scan or null when the scan could not vouch for one, and print: the creator's first tested printer with timeS and grams), stats (downloads, makes, likes) and, signed in, liked and saved. query and tag filter as the Vault's search and category do, sort (new or popular) orders the catalog, and limit (1 to 50, default 24) with cursor (the next value of an earlier page) pages through. Never a file, a download link or a token, and nothing here downloads, likes or saves a design. Reads through the app link; the app must be open with the link on.`,
    input: z
      .object({
        list: z.enum(VAULT_LISTS).optional().describe('all (the catalog, default), saved (the Saved list) or mine (the person\'s uploads); saved and mine need the person signed in'),
        query: z.string().trim().min(1).max(100).optional().describe('Words that match a title, a tag or the creator, as the Vault search does'),
        tag: z.string().trim().min(1).max(40).optional().describe('Only designs with this tag, such as functional or toys'),
        sort: z.enum(['new', 'popular']).optional().describe('With list all: new (default) or popular'),
        cursor: z.string().regex(/^\d{1,6}$/, 'cursor is the next value of an earlier page').optional().describe('next from the page before, to read the page after it'),
        limit: z.number().int().min(1).max(50).optional().describe('Designs per page, 1 to 50 (default 24)'),
      })
      .refine((i) => i.sort === undefined || (i.list ?? 'all') === 'all', { message: 'sort goes with list all; the saved and mine lists keep their own order.' }),
    async run(i) {
      const out = await call(link, appName, defined(i))
      return { summary: summary(out, appName), output: out }
    },
  })
  return [list] as PilotTool<never>[]
}
