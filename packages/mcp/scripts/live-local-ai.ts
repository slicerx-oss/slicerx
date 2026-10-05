// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A manual check of Set up local AI against a real Ollama on this computer, not part of the tests:
// reads the hardware, prints the recommendation, checks every installed model (tool call, loaded
// context, speed), downloads llama3.2:3b with a cancel at 300 MB and a resume, then gives it
// mimir's context and checks it again. It downloads about 2 GB the first time. Run from
// packages/mcp with Ollama running:
//   pnpm exec tsx scripts/live-local-ai.ts
import { checkModel, detectRunners, ensureContext, fetchNet, pullModel, recommend } from '@slicerx/pilot/local-ai'
import { nodeHardware } from '../src/localai'

const TAG = 'llama3.2:3b'
const net = fetchNet()
const hw = await nodeHardware()
console.log('hardware', JSON.stringify(hw))
console.log('recommend', recommend(hw))
const ollama = (await detectRunners(net)).find((r) => r.kind === 'ollama')
if (!ollama) throw new Error('Ollama is not running on 127.0.0.1:11434')
console.log('installed', ollama.models)
for (const tag of ollama.models) console.log('check', tag, JSON.stringify(await checkModel(net, ollama.base, tag)))

const ctl = new AbortController()
let n = 0
await pullModel(
  net,
  TAG,
  (p) => {
    if (++n % 25 === 0) console.log('pull', p.completedBytes, p.totalBytes)
    if (p.completedBytes > 300e6) ctl.abort()
  },
  ctl.signal,
).catch((e: unknown) => console.log('cancel ->', e instanceof Error ? e.name : String(e)))
await pullModel(net, TAG, (p) => {
  if (++n % 100 === 0) console.log('pull', p.completedBytes, p.totalBytes)
})
console.log('check', TAG, JSON.stringify(await checkModel(net, ollama.base, TAG)))
const fixed = await ensureContext(net, TAG)
console.log('ensureContext ->', fixed)
console.log('check', fixed, JSON.stringify(await checkModel(net, ollama.base, fixed)))
