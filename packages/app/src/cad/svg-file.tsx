// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The SVG file chooser shared by the relief import and the shape tool's SVG outline.
import { Field } from '@slicerx/ui'

/** SVG text past this size is refused before it reaches the engine. */
export const SVG_MAX_BYTES = 4 * 1024 * 1024

/** Reads a chosen SVG file as text, or says why it cannot. */
export async function readSvgFile(f: File): Promise<{ name: string; text: string }> {
  if (f.size > SVG_MAX_BYTES) throw new Error('The SVG is larger than 4 MB. Simplify it in a vector editor first.')
  const text = await f.text().catch(() => {
    throw new Error('The file could not be read.')
  })
  if (!/<svg[\s>]/i.test(text)) throw new Error('That file is not an SVG.')
  return { name: f.name, text }
}

export function SvgFileField({ id, file, onFile, onError }: { id: string; file: { name: string } | null; onFile: (f: { name: string; text: string }) => void; onError: (message: string) => void }) {
  return (
    <Field htmlFor={id} label="SVG file" hint={file ? file.name : undefined}>
      <label className="cad-file">
        <input
          id={id}
          type="file"
          accept=".svg,image/svg+xml"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void readSvgFile(f).then(onFile, (err: unknown) => onError(err instanceof Error ? err.message : String(err)))
          }}
        />
        <span>Choose an SVG</span>
      </label>
    </Field>
  )
}
