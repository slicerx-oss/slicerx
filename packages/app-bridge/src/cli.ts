#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx-app-bridge: the running-app MCP server over stdio, for dev and test builds of the desktop app with the agent
// bridge (docs/agent-bridge.md). Run with Node 24+ (type stripping): node packages/app-bridge/src/cli.ts
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createAppClient } from './client.ts'
import { connectionFiles } from './connection.ts'
import { createAppBridgeServer, SERVER_VERSION } from './server.ts'

const HELP = `slicerx-app-bridge ${SERVER_VERSION}: drive a running SlicerX bridge build from an MCP client

Usage: node packages/app-bridge/src/cli.ts [--token-file <path>] [--identifier <app id>]

  --token-file <path>   The connection file the app writes (default: SX_AGENT_BRIDGE_TOKEN_FILE,
                        else agent-bridge.json in the app's data folder)
  --identifier <id>     The app identifier that names its data folder (default: SX_AGENT_BRIDGE_APP_ID,
                        else app.slicerx.desktop). The bridge build's own folder, <id>.agent-bridge,
                        is looked in too, and the connection file written last wins

Start the app with SX_AGENT_BRIDGE_PORT set (0 picks a free port). The file is read on every call,
so this server can start before the app and keeps working across app restarts.
`

const { values } = parseArgs({ options: { 'token-file': { type: 'string' }, identifier: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true })
if (values.help) {
  process.stdout.write(HELP)
} else {
  const files = connectionFiles({ file: values['token-file'], identifier: values.identifier })
  // Logs go to stderr: stdout carries the protocol.
  process.stderr.write(`slicerx-app-bridge ${SERVER_VERSION}: connection file ${files.join(' or ')}\n`)
  await createAppBridgeServer(createAppClient(files)).connect(new StdioServerTransport())
}
