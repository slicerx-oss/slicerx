// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The packages a white-label edition ships without packages/app name the app through productName() or app_name().
// Usage: node --test scripts/check-brand-strings.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { check, scan } from './check-brand-strings.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('no hard-coded SlicerX in the MCP server, mimir, embed, viewport, link client, hub or engine text', () => {
  assert.deepEqual(check(root), [])
})

test('catches a new hard-coded name in a message, a tool description, JSX text and a Rust string', () => {
  const ts = [
    "throw new Error('Open the file in SlicerX first.')",
    "  description: 'Slice with SlicerX.',",
    '  `the ${what} SlicerX keeps`,',
  ].join('\n')
  assert.deepEqual(scan('packages/mcp/src/new-tool.ts', ts).map((h) => h.line), [1, 2, 3])
  assert.equal(scan('packages/embed/src/panel.tsx', '      <p>SlicerX could not read this file.</p>').length, 1)
  assert.equal(scan('packages/connect/link/src/hub.rs', '    eprintln!("Open SlicerX and pair again");').length, 1)
  // a template literal over several lines is still text
  assert.equal(scan('packages/mcp/src/x.ts', 'const t = `first line\nsecond line names SlicerX`').length, 1)
})

test('skips comments, identifiers, tests and the kept categories', () => {
  const ts = [
    '// SlicerX keeps this comment',
    '/**',
    ' * SlicerX in a doc comment',
    ' */',
    "const a = 'https://slicerx.app' // SlicerX in a trailing comment",
    'export { defineSlicerXElements } from "./elements"',
    'const SLICERX_APP = 1',
    '// Copyright (C) 2026 The SlicerX contributors',
    "      <metadata name=\"Application\">SlicerX</metadata>",
    `  title: \`\${productName()} print knowledge\`,`,
  ].join('\n')
  assert.deepEqual(scan('packages/mcp/src/design.ts', ts), [])
  const rs = ['/// SlicerX in a doc comment', 'let s = format!("{} walls", app_name());', '#[cfg(test)]', 'mod tests {', '    assert!(s.contains("SlicerX"));', '}'].join('\n')
  assert.deepEqual(scan('packages/core/src/api.rs', rs), [])
  // a kept text is kept only in its own file
  assert.equal(scan('packages/mcp/src/other.ts', '  data: `<metadata name="Application">SlicerX</metadata>`').length, 1)
})
