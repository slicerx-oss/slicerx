#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// For the gate's operator, not the gate: hands one sign-in callback to a running bridge build through its
// app_auth_callback tool. A bridge build's slicerx:// handler is not registered with the system, so a callback that
// a browser or an operator's script got from the emailed link reaches the app this way. The callback is read from
// standard input (never an argument, so it stays out of process lists and shell history), checked to be a
// <scheme>://auth/callback link, passed on and never printed or written anywhere.
//   <the operator's own step that yields the callback> | node scripts/gate/hand-callback.mjs --token-file <file>
// The token file is the one the gate prints while it waits. See docs/release-gate.md, "The operator".
import { parseArgs } from 'node:util'
import { createAppClient } from '../../packages/app-bridge/src/client.ts'

const { values } = parseArgs({ options: { 'token-file': { type: 'string' } }, strict: true })
if (!values['token-file']) {
  process.stderr.write('usage: ... | node scripts/gate/hand-callback.mjs --token-file <the file the gate printed>\n')
  process.exit(2)
}
let input = ''
for await (const chunk of process.stdin) input += chunk
const url = input.trim()
input = ''
if (!/^[a-z][\w+.-]*:\/\/auth\/callback[?#]/i.test(url)) {
  process.stderr.write('refusing: standard input is not a sign-in callback (<scheme>://auth/callback?...)\n')
  process.exit(1)
}
try {
  await createAppClient(values['token-file']).call('auth_callback', { url })
  process.stdout.write('handed the callback to the app\n')
} catch (e) {
  process.stderr.write(`the app did not take it: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
}
