// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// ort-prefetch.sh with a stub curl: the cache key, a version it does not pin, a folder already in place, a download
// that keeps failing, a cached archive that fails its check, and a download with the wrong sha256. It never exits
// non-zero.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const linux = 'x86_64-unknown-linux-gnu'
const sha = 'e454f710f8a49f53aa5b4ff51e3454ae1835777e431c6c35c5255ce6f205fd68'

// A copy of the script in a repo of its own (its Cargo.lock), a stub curl that logs each call and writes "bad"
// (or fails with STUB_CURL_FAIL), and an empty cache.
function setup(version = '2.0.0-rc.13') {
  const dir = mkdtempSync(join(tmpdir(), 'ort-prefetch-'))
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true })
  copyFileSync(join(here, 'ort-prefetch.sh'), join(dir, 'scripts/ci/ort-prefetch.sh'))
  writeFileSync(join(dir, 'Cargo.lock'), `[[package]]\nname = "ort"\nversion = "${version}"\n\n[[package]]\nname = "ort-sys"\nversion = "${version}"\n`)
  mkdirSync(join(dir, 'bin'))
  const curl = join(dir, 'bin/curl')
  writeFileSync(curl, `#!/usr/bin/env bash\necho "$*" >> "${join(dir, 'curl.log')}"\n[ -n "\${STUB_CURL_FAIL:-}" ] && exit 7\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { printf bad > "$2"; exit 0; }; shift; done\n`)
  chmodSync(curl, 0o755)
  return dir
}

function run(dir, args, env = {}) {
  const r = spawnSync('bash', [join(dir, 'scripts/ci/ort-prefetch.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, ORT_CACHE_DIR: join(dir, 'cache'), SX_ORT_RETRY_DELAY: '0', ...env },
  })
  const log = join(dir, 'curl.log')
  return { ...r, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0 }
}

test('the cache key names the version, each target with a prebuilt build and its sha256', () => {
  const dir = setup()
  const r = run(dir, ['--key', 'aarch64-apple-darwin', 'x86_64-apple-darwin', linux])
  assert.equal(r.status, 0)
  assert.equal(r.stdout, `key=ort-sys-2.0.0-rc.13-aarch64-apple-darwin-6934874e2e95-${linux}-e454f710f8a4\n`)
  assert.equal(run(dir, ['--key', 'x86_64-apple-darwin']).stdout, '')
})

test('another ort-sys version in Cargo.lock: a warning, no key, no download', () => {
  const dir = setup('2.0.0-rc.14')
  const r = run(dir, [linux])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /::warning title=ONNX Runtime prefetch::Cargo.lock has ort-sys 2.0.0-rc.14/)
  assert.equal(r.calls, 0)
  const k = run(dir, ['--key', linux])
  assert.equal(k.stdout, '')
})

test('a folder already in place with its library: nothing downloaded', () => {
  const dir = setup()
  const dest = join(dir, 'cache/dfbin', linux, sha)
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'libonnxruntime.a'), 'lib')
  const r = run(dir, [linux])
  assert.equal(r.status, 0)
  assert.match(r.stderr, /already in/)
  assert.equal(r.calls, 0)
})

test('a download that keeps failing: every try, then a warning and exit 0, nothing in place', () => {
  const dir = setup()
  const r = run(dir, [linux], { STUB_CURL_FAIL: '1', SX_ORT_TRIES: '3' })
  assert.equal(r.status, 0)
  assert.equal(r.calls, 3)
  assert.match(r.stdout, /::warning title=ONNX Runtime prefetch::could not download .* after 3 tries/)
  assert.equal(existsSync(join(dir, 'cache/dfbin', linux, sha)), false)
})

test('a cached archive that fails its check is deleted and downloaded again; a wrong download is never kept', () => {
  const dir = setup()
  const archives = join(dir, 'archives')
  mkdirSync(archives)
  writeFileSync(join(archives, `${linux}.tar.lzma2`), 'corrupt')
  const r = run(dir, [linux], { SX_ORT_ARCHIVES: archives, SX_ORT_TRIES: '2' })
  assert.equal(r.status, 0)
  assert.match(r.stderr, /fails its sha256 check/)
  assert.match(r.stderr, /the download's sha256 is [0-9a-f]{64}, not e454f7/)
  assert.equal(r.calls, 2)
  assert.equal(existsSync(join(archives, `${linux}.tar.lzma2`)), false)
  assert.equal(existsSync(join(dir, 'cache/dfbin', linux, sha)), false)
})
