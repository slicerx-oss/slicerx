// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// served-engine.ts run as sx-geom: `serve` (or `--sx-geom-engine`, as the desktop app's binary takes it) speaks frames
// until stdin closes; any other argument is one call, its request as JSON on stdin and its answer as JSON on stdout.
// SX_STANDIN_NO_SERVE=1 is an sx-geom with no serve mode: `serve` is then an operation like any other, read from
// stdin, which the per-call run would wait on. `test.late` dies mid-answer and leaves the rest of its answer, and an
// answer of its own, to come after it has ended (SX_STANDIN_LATE_MS later, 1.5 s by default).
// SX_STANDIN_SLOW=<file>: while the file names an operation, that operation's next call removes the file, logs
// `{"pid", "slow"}` at once and answers 5 s later, so a test can end the process while the call runs. SX_STANDIN_PANIC=<op>
// answers each call of that operation with a panic, as the engine answers one it catches.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { decodeFrame, encodeFrame, HELLO, takeFrame } from '@slicerx/cad-history/served'
import { standInKernel } from './served-engine'

const kernel = standInKernel()
const op = process.argv[2] ?? ''
// SX_STANDIN_SERVE_ONCE=<file>: serves for the look at whether it serves and for the first start (it counts them in the
// file); later starts never say HELLO, as a binary that cannot start again would
const once = process.env['SX_STANDIN_SERVE_ONCE']
const served = (op === 'serve' || op === '--sx-geom-engine') && process.env['SX_STANDIN_NO_SERVE'] !== '1'
const starts = once && existsSync(once) ? Number(readFileSync(once, 'utf8')) : 0
if (served && once && starts >= 2) {
  setTimeout(() => process.exit(4), 60_000)
} else if (served) {
  if (once) writeFileSync(once, String(starts + 1))
  process.stdout.write(HELLO)
  let pending: Uint8Array = new Uint8Array(0)
  process.stdin.on('data', (d: Buffer) => {
    const next = new Uint8Array(pending.length + d.length)
    next.set(pending)
    next.set(d, pending.length)
    pending = next
    for (let f = takeFrame(pending); f; f = takeFrame(pending)) {
      pending = f.rest.slice()
      const { answer: call } = decodeFrame(f.frame)
      // dies mid-answer: half its answer now, and the rest, then a whole answer of its own, from a process it leaves
      // holding its output, after it has ended (the late bytes of a killed process)
      if (call['op'] === 'test.late') {
        const frame = encodeFrame(JSON.stringify({ id: call['id'], result: { body: 999 } }), [])
        const half = Math.floor(frame.length / 2)
        process.stdout.write(frame.subarray(0, half), () => {
          const late = Buffer.concat([Buffer.from(frame.subarray(half)), Buffer.from(encodeFrame(JSON.stringify({ id: 0, result: { body: 998 } }), []))]).toString('base64')
          spawn(process.execPath, ['-e', `setTimeout(() => process.stdout.write(Buffer.from('${late}', 'base64')), ${process.env['SX_STANDIN_LATE_MS'] ?? '1500'})`], { stdio: ['ignore', 'inherit', 'ignore'], detached: true }).unref()
          process.exit(3)
        })
        return
      }
      const log = process.env['SX_STANDIN_LOG']
      if (call['op'] === process.env['SX_STANDIN_PANIC']) {
        if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, op: call['op'], panic: true })}\n`)
        process.stdout.write(encodeFrame(JSON.stringify({ id: call['id'], panic: 'boom at kernel.rs:1:1' }), []))
        continue
      }
      const slow = process.env['SX_STANDIN_SLOW']
      const late = slow !== undefined && existsSync(slow) && readFileSync(slow, 'utf8').trim() === call['op']
      if (late) {
        rmSync(slow, { force: true })
        if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, slow: call['op'] })}\n`)
      }
      let reply: Record<string, unknown>
      try {
        reply = { id: call['id'], result: kernel.call(call['op'] as string, (call['request'] ?? {}) as Record<string, unknown>) }
      } catch (e) {
        reply = { id: call['id'], error: (e as Error).message }
      }
      const frame = encodeFrame(JSON.stringify(reply), [])
      if (late) setTimeout(() => process.stdout.write(frame), 5000)
      else process.stdout.write(frame)
    }
  })
} else {
  let input = ''
  process.stdin.setEncoding('utf8').on('data', (d: string) => (input += d))
  process.stdin.on('end', () => {
    try {
      process.stdout.write(JSON.stringify(kernel.call(op, input ? JSON.parse(input) : {})))
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: (e as Error).message }))
      process.exitCode = 1
    }
  })
}
