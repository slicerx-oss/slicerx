// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand-in engine for both geometry workers: a fit check runs synchronously for minGapMm seconds, as a big one does
// in the real engine, and never reads a message meanwhile; any other call answers at once.
import { parentPort } from 'node:worker_threads'

parentPort.on('message', (m) => {
  if ('start' in m || 'keep' in m || 'cancel' in m) return
  if (m.op === undefined || m.op === 'fit.check') {
    parentPort.postMessage({ started: true })
    const until = Date.now() + (m.request?.minGapMm ?? 0) * 1000
    while (Date.now() < until) {
      // busy, as the engine is
    }
    parentPort.postMessage({ id: m.id, result: { parts: [], gaps: [], limitMm: 0, verticalLimitMm: 0, pieces: 0, warnings: [] }, memoryBytes: 0 })
    return
  }
  parentPort.postMessage({ id: m.id, result: { op: m.op }, memoryBytes: 0 })
})
