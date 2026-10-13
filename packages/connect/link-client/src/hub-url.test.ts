// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The hub address a tool uses when it is given none: a test or dev run's SX_TEST_HUB_PORT, else sx-link's default.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_HUB_URL, hubUrlFromEnv } from './index.ts'

test('without a run port the address is sx-link default', () => {
  assert.equal(DEFAULT_HUB_URL, 'ws://127.0.0.1:47615')
  assert.equal(hubUrlFromEnv(undefined), DEFAULT_HUB_URL)
  assert.equal(hubUrlFromEnv({}), DEFAULT_HUB_URL)
})

test('a run port moves the address to that loopback port', () => {
  assert.equal(hubUrlFromEnv({ SX_TEST_HUB_PORT: '48015' }), 'ws://127.0.0.1:48015')
  assert.equal(hubUrlFromEnv({ SX_TEST_HUB_PORT: ' 1024 ' }), 'ws://127.0.0.1:1024')
  assert.equal(hubUrlFromEnv({ SX_TEST_HUB_PORT: '65535' }), 'ws://127.0.0.1:65535')
})

test('anything that is not a port from 1024 up keeps the default', () => {
  for (const v of ['', '0', '80', '1023', '65536', '-1', '4801x', '48015.5', 'ws://10.0.0.5:48015']) {
    assert.equal(hubUrlFromEnv({ SX_TEST_HUB_PORT: v }), DEFAULT_HUB_URL, v)
  }
})
