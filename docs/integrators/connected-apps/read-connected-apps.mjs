// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads the user's connected apps (Spoolman and Home Assistant) through SlicerX's MCP server, and asks to switch a
// plug the way an agent should: it raises the card and leaves the answer to a person in SlicerX.
//
//   npm install @modelcontextprotocol/sdk
//   node read-connected-apps.mjs                       (slicerx-mcp on PATH, sx-link running on this computer)
//   SLICERX_MCP=/path/to/slicerx-mcp node read-connected-apps.mjs
//
// Add the apps in SlicerX first (Settings, Connected apps). The script needs no key of its own: slicerx-mcp
// reads the bridge's agent code from its state folder, and the apps' keys stay in the keychain behind sx-link.

/** What one MCP tool call gave back: its structured data, or the error text. */
function out(r) {
  if (r.isError) return { error: r.content?.[0]?.text ?? 'error' }
  return r.structuredContent ?? {}
}

/**
 * Lists PLA spools and the switches, then asks to turn the first switch off. `call(name, args)` is an MCP
 * `tools/call`; `names` are the tools the server lists. Returns what it found, for a person or a test to read.
 */
export async function readConnectedApps(call, names) {
  const has = (n) => names.includes(n)
  const result = { spools: null, switches: null, plugCard: null }

  // Connected app tools are named slicerx_<app>_<tool>; an app that isn't added has no tools.
  if (has('slicerx_spoolman_list_spools')) {
    const r = out(await call('slicerx_spoolman_list_spools', { material: 'PLA' }))
    result.spools = r.error ? r : (r.output ?? [])
  }
  if (has('slicerx_home_assistant_list_entities')) {
    const r = out(await call('slicerx_home_assistant_list_entities', { domain: 'switch' }))
    result.switches = r.error ? r : (r.output ?? [])
  }

  // Switching a device is never the agent's to approve: the server answers needs_person and a card
  // waits in SlicerX and on the user's phone. Don't call slicerx_approve for it; it is refused.
  const plug = Array.isArray(result.switches) ? result.switches[0] : null
  if (plug && has('slicerx_home_assistant_call_service')) {
    const r = out(await call('slicerx_home_assistant_call_service', { domain: 'switch', service: 'turn_off', entityId: plug.entityId }))
    result.plugCard = { entityId: plug.entityId, status: r.status ?? null, requestId: r.request_id ?? null, error: r.error ?? null }
  }
  return result
}

async function main() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const transport = new StdioClientTransport({ command: process.env.SLICERX_MCP || 'slicerx-mcp', args: ['--printers', 'link'] })
  const client = new Client({ name: 'read-connected-apps', version: '1.0.0' })
  await client.connect(transport)
  try {
    const names = (await client.listTools()).tools.map((t) => t.name)
    const r = await readConnectedApps((name, args) => client.callTool({ name, arguments: args }), names)
    if (r.spools === null) console.log('Spoolman: not added in SlicerX')
    else if (r.spools.error) console.log(`Spoolman: ${r.spools.error}`)
    else for (const s of r.spools) console.log(`Spool ${s.id}: ${s.vendor ?? ''} ${s.name ?? ''}, ${s.remainingG ?? '?'} g left`)
    if (r.switches === null) console.log('Home Assistant: not added in SlicerX')
    else if (r.switches.error) console.log(`Home Assistant: ${r.switches.error}`)
    else for (const e of r.switches) console.log(`${e.entityId} is ${e.state}`)
    if (r.plugCard?.status === 'needs_person') console.log(`Asked to turn ${r.plugCard.entityId} off. A person answers that in SlicerX or on their phone.`)
  } finally {
    await client.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
