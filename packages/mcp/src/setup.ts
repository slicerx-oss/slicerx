// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// First-run printer setup for MCP clients: finding a printer model and scanning the network.
// Searching the catalog works everywhere; scanning needs a running sx-link (--printers link).
// Testing a connection and adding a printer are for the SlicerX app only: this server pairs with
// sx-link as an agent, and the hub refuses printers.add and printers.test from agents (a test
// would send a stored printer key to an address the caller picks). The skill then tells the
// person where to do it. `withAdd` keeps them for a host that is allowed to add printers.
// Testing and adding verify a single-use approval token here as well as asking through the gate.
// No secret passes through MCP: an access code or key is set in the SlicerX app or through
// sx-link's own secret store, never in a tool call.
import type { ApprovalToken, ApprovalVerifier } from '@slicerx/contracts'
import { hashParams } from '@slicerx/contracts'
import { createPrinterSetup, type SetupLink } from '@slicerx/connect'
import type { SetupHost } from '@slicerx/pilot'
import { brandById, PRINTER_MODELS } from '@slicerx/printer-catalog'

async function verified(approvals: ApprovalVerifier, token: ApprovalToken, target: string, params: unknown): Promise<void> {
  const check = await approvals.verify(token, 'printer.config', target, await hashParams({ printerId: target, changes: params }))
  if (!check.ok) throw Object.assign(new Error(`Printer setup refused: ${check.reason}`), { code: 'approval_invalid' })
}

/** Models whose brand or name contain every word of the query, best matches first. */
export function searchModels(query: string): { id: string; vendor: string; model: string; nozzles: number[] }[] {
  const words = query.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)
  if (words.length === 0) return []
  return PRINTER_MODELS.map((m) => {
    const vendor = brandById(m.brand)?.name ?? m.brand
    const hay = `${vendor} ${m.name} ${m.id}`.toLowerCase()
    return { m, vendor, hit: words.every((w) => hay.includes(w)), exact: `${vendor} ${m.name}`.toLowerCase() === words.join(' ') }
  })
    .filter((x) => x.hit)
    .sort((a, b) => Number(b.exact) - Number(a.exact))
    .map(({ m, vendor }) => ({ id: m.id, vendor, model: m.name, nozzles: m.nozzles }))
}

/** `link` is the sx-link host in link mode; without it only the catalog search is offered. */
export function createMcpSetupHost(link: SetupLink | undefined, approvals: ApprovalVerifier, opts: { withAdd?: boolean } = {}): SetupHost {
  const setup = link ? createPrinterSetup(link) : undefined
  return {
    searchProfiles: async (query) => searchModels(query),
    ...(setup ? { discover: (o?: { timeoutMs?: number; signal?: AbortSignal }) => setup.discover(o) } : {}),
    ...(setup && opts.withAdd
      ? {
          async testConnection(connection, token) {
            await verified(approvals, token, `probe:${connection.address}`, { probe: connection })
            return setup.testConnection(connection)
          },
          async addPrinter(input, token) {
            await verified(approvals, token, `new:${input.profileId}`, { add: input })
            return setup.addPrinter(input)
          },
        }
      : {}),
  }
}
