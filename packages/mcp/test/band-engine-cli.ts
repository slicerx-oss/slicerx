// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// band-engine.ts run as sx-geom is: `<op>` as the argument, the request as JSON on stdin, the answer as JSON on
// stdout, or `{ "error" }` and exit code 1. SX_BAND_NO_IMPRINT=1 is an engine that cannot split faces.
import { bandEngine } from './band-engine'

const op = process.argv[2] ?? ''
let input = ''
process.stdin.setEncoding('utf8').on('data', (d: string) => (input += d))
process.stdin.on('end', () => {
  bandEngine({ imprint: process.env['SX_BAND_NO_IMPRINT'] !== '1' })
    .call(op, input ? JSON.parse(input) : {})
    .then((r) => process.stdout.write(JSON.stringify(r)), (e: Error) => {
      process.stdout.write(JSON.stringify({ error: e.message }))
      process.exitCode = 1
    })
})
