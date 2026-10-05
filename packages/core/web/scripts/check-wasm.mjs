// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// WASM against native: slices request files (the CLI's request format, with a
// `meshes` map) through pkg/sx_wasm.wasm in several shard counts and through
// the native `sx` binary, and checks the G-code bytes are identical.
//
//   node packages/core/web/scripts/check-wasm.mjs <request.json>... [--shards 1,3]
//
// Build both first: pnpm --filter @slicerx/slicer build:wasm && cargo build --release -p sx-cli
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..', '..', '..')
const args = process.argv.slice(2)
const si = args.indexOf('--shards')
const shardCounts = (si >= 0 ? args[si + 1] : '1,3').split(',').map(Number)
const files = args.filter((a, i) => !a.startsWith('--') && (si < 0 || i !== si + 1))
if (files.length === 0) throw new Error('usage: check-wasm.mjs <request.json>... [--shards 1,3]')

const module = await WebAssembly.compile(readFileSync(join(here, '..', 'pkg', 'sx_wasm.wasm')))
const sha = (b) => createHash('sha256').update(b).digest('hex')
let failed = 0

for (const file of files) {
  const req = JSON.parse(readFileSync(file, 'utf8'))
  const native = JSON.parse(
    execFileSync(process.env.SX_BIN ?? join(root, 'target', 'release', 'sx'), ['slice', '--request', file, '--out-dir', mkdtempSync(join(tmpdir(), 'sx-wasm-'))], {
      maxBuffer: 1 << 28,
    }).toString(),
  )
  for (const shards of shardCounts) {
    const { exports: x } = await WebAssembly.instantiate(module, {})
    const put = (b) => {
      const p = x.sx_input(b.length)
      new Uint8Array(x.memory.buffer, p, b.length).set(b)
    }
    const out = (w) => new Uint8Array(x.memory.buffer, x.sx_out_ptr(w), x.sx_out_len(w)).slice()
    const fail = () => new Error(new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.sx_error_ptr(), x.sx_error_len())))
    const ids = {}
    for (const [ref, path] of Object.entries(req.meshes ?? {})) {
      const name = new TextEncoder().encode(basename(path))
      const data = readFileSync(resolve(dirname(file), path))
      const buf = new Uint8Array(name.length + 1 + data.length)
      buf.set(name)
      buf.set(data, name.length + 1)
      put(buf)
      ids[ref] = x.sx_load_mesh()
      if (ids[ref] === 0) throw fail()
    }
    const wasmReq = JSON.parse(JSON.stringify(req))
    delete wasmReq.meshes
    for (const o of wasmReq.plate.objects) o.mesh = ids[o.mesh] ?? o.mesh
    const body = new TextEncoder().encode(JSON.stringify(wasmReq))
    const chunks = []
    for (let s = 0; s < shards; s++) {
      put(body)
      if (x.sx_slice_shard(s, shards) !== 0) throw fail()
      chunks.push(out(0))
    }
    // The shards carry markers; joined, the module writes progress and the totals.
    put(Buffer.concat(chunks))
    // The request's settings tell the module whether to write binary G-code.
    put(body)
    if (x.sx_set_request() !== 0) throw fail()
    put(Buffer.concat(chunks))
    if (x.sx_finalize() !== 0) throw fail()
    const all = Buffer.from(out(0))
    // The file name from filename_format, which both builds read from the finished file.
    const fileName = JSON.parse(new TextDecoder().decode(out(2))).fileName ?? undefined
    // Without an image from the host the module writes no thumbnails, where the native build draws its own:
    // when only the native file has them, the two are compared without the thumbnail blocks.
    const nativeText = readFileSync(native.files.gcode)
    const thumbs = /; THUMBNAIL_BLOCK_START\n[\s\S]*?; THUMBNAIL_BLOCK_END\n\n?/g
    const strip = (b) => Buffer.from(b.toString('latin1').replace(thumbs, ''), 'latin1')
    const onlyNative = thumbs.test(nativeText.toString('latin1')) && !all.toString('latin1').includes('; THUMBNAIL_BLOCK_START')
    thumbs.lastIndex = 0
    const sameName = fileName === native.fileName
    const ok = (onlyNative ? sha(strip(all)) === sha(strip(nativeText)) : sha(all) === native.gcodeSha256) && sameName
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${basename(file)} shards=${shards} ${all.length} bytes (native ${native.gcodeBytes})${sameName ? '' : ` file name ${fileName} (native ${native.fileName})`}`)
  }
}
process.exit(failed ? 1 : 0)
