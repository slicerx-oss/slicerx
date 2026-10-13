// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Text people read names the app through productName() or app_name(), so a white-label edition shows its own name.
// Usage: node --test scripts/check-brand-strings.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { check, scan } from './check-brand-strings.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('no hard-coded SlicerX in the app, settings, desktop shell, MCP server, mimir, embed, viewport, link client, hub, printer drivers, CAD history or engine text', () => {
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
  // the printer drivers, mimir's ChatGPT sign-in and the CAD history reader are in scope
  assert.equal(scan('packages/connect/src/drivers/ultimaker/mod.rs', '                .form(&[("application", "SlicerX"), ("user", "SlicerX")]),').length, 1)
  assert.equal(scan('packages/pilot/llm/src/chatgpt.rs', '                "Signed in. You can close this tab and go back to SlicerX.",').length, 1)
  assert.equal(scan('packages/cad-history/src/read.ts', "      return `saved by a newer SlicerX (history version ${v})`").length, 1)
  // make_model's brand colors come from the edition; only the X mark keeps the name
  assert.equal(scan('packages/pilot/skills/make_model/colors.ts', "  'slicerx black': { hex: '#17181f', label: 'SlicerX black' },").length, 1)
  assert.equal(scan('packages/pilot/skills/make_model/index.ts', "    mark: z.enum(['slicerx-x', 'svg']).describe('slicerx-x is the SlicerX X. svg needs the svg field'),").length, 0)
  // the app, the settings notes and the desktop shell are in scope
  assert.equal(scan('packages/app/src/shell/boundary.tsx', '      <p>The connection dropped while SlicerX was loading.</p>').length, 1)
  assert.equal(scan('packages/settings/src/validate.rs', '        "is not supported by the SlicerX engine yet",').length, 1)
  assert.equal(scan('apps/desktop/src-tauri/src/menu.rs', '    item("About SlicerX")').length, 1)
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
    '      {/* SlicerX in a JSX comment */}',
    "      <p>{appName()} is ready</p> {/* not SlicerX */}",
  ].join('\n')
  assert.deepEqual(scan('packages/mcp/src/design.ts', ts), [])
  const rs = ['/// SlicerX in a doc comment', 'let s = format!("{} walls", app_name());', '#[cfg(test)]', 'mod tests {', '    assert!(s.contains("SlicerX"));', '}'].join('\n')
  assert.deepEqual(scan('packages/core/src/api.rs', rs), [])
  // a kept text is kept only in its own file
  assert.equal(scan('packages/mcp/src/other.ts', '  data: `<metadata name="Application">SlicerX</metadata>`').length, 1)
})
