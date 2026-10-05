// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The main process side of Spoolhouse: starts the SlicerX MCP server and slices through it.
// In an Electron app this file runs in the main process; here it runs in plain Node.
// It follows docs/integrators/quickstart.md step for step.
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export interface SlicerXOptions {
  /** The sx slicing engine you ship with your app. */
  sxBin: string
  /** The folders the user picked for models and presets. */
  libraryDirs: string[]
  /** Where G-code, .gcode.3mf files and previews go. */
  outDir: string
}

export interface SliceResult {
  time_s: number
  time_text: string
  filament_g: number
  filaments: { slot: number; filament_g: number; filament_mm: number }[]
  layer_count: number
  plate?: number
  gcode_path: string
  gcode_3mf_path?: string
  preview_path?: string
  applied: string[]
  warnings: string[]
}

export interface ProjectInfo {
  plates: { index: number; name?: string; objects: number }[]
  filaments: { slot: number; type?: string; color?: string; preset?: string }[]
  has_settings: boolean
}

/** A refused call: branch on `code`, show `message`. */
export class SlicerXError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function unwrap<T>(result: CallToolResult): T {
  if (result.isError) {
    const { code, message } = (result.structuredContent as { error: { code: string; message: string } }).error
    throw new SlicerXError(code, message)
  }
  return result.structuredContent as T
}

export interface SlicerX {
  inspect(file: string): Promise<ProjectInfo>
  slice(args: Record<string, unknown>, onProgress?: (progress: number, message: string) => void): Promise<SliceResult>
  close(): Promise<void>
}

export async function startSlicerX(o: SlicerXOptions): Promise<SlicerX> {
  // The server script inside the installed package.
  const cli = createRequire(import.meta.url).resolve('@slicerx/mcp/cli')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, '--engine', 'sx', '--sx-bin', o.sxBin, ...o.libraryDirs.flatMap((d) => ['--allow-dir', d]), '--out-dir', o.outDir, '--printers', 'off', '--no-urls'],
    stderr: 'pipe',
  })
  const client = new Client({ name: 'spoolhouse', version: '0.1.0' })
  await client.connect(transport)

  return {
    async inspect(file) {
      const result = await client.callTool({ name: 'slicerx_inspect_project', arguments: { file } }, CallToolResultSchema)
      return unwrap<ProjectInfo>(result as CallToolResult)
    },
    async slice(args, onProgress) {
      const result = await client.callTool({ name: 'slicerx_slice_file', arguments: args }, CallToolResultSchema, {
        onprogress: (p) => onProgress?.(p.progress, p.message ?? ''),
        timeout: 10 * 60_000,
      })
      return unwrap<SliceResult>(result as CallToolResult)
    },
    close: () => client.close(),
  }
}
