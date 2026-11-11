// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Turns a fixture of recorded engine replies that was written whole into the packed form the recorder writes now
// (geom-replies-pack.ts): the same replies, each long number array stored once as binary. It checks the packed file
// unpacks to the whole text byte for byte before it writes, and leaves a fixture that is packed already as it is.
//   packages/mcp: ./node_modules/.bin/tsx test/pack-geom-replies.ts test/fixtures/<name>.json.gz
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { PACKED_FORMAT, packReplies, sha256, unpackReplies, wholeText, type Recorded } from './geom-replies-pack'

for (const file of process.argv.slice(2)) {
  const before = readFileSync(file)
  const text = gunzipSync(before).toString('utf8')
  const parsed = JSON.parse(text) as { format?: unknown }
  if (parsed.format === PACKED_FORMAT) {
    console.log(`${file}: packed already`)
    continue
  }
  const recorded = parsed as Record<string, Recorded[]>
  // the recorder wrote the whole form as one line of JSON; anything else would not come back byte for byte
  if (wholeText(recorded) !== text) throw new Error(`${file}: not a fixture the recorder wrote whole`)
  const packed = packReplies(recorded)
  const out = `${JSON.stringify(packed)}\n`
  const back = wholeText(unpackReplies(JSON.parse(out)))
  if (back !== text || sha256(back) !== packed.source) throw new Error(`${file}: the packed form does not unpack to the same replies`)
  const gz = gzipSync(out, { level: 9 })
  writeFileSync(file, gz)
  console.log(`${file}: ${text.length} to ${out.length} bytes raw, ${before.length} to ${gz.length} gzipped, ${Object.keys(packed.arrays).length} arrays`)
}
