// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The bridge's font check (app_fonts): loads every font face the page declares and says how each one ended. A browser
// fetches a face with a unicode-range only when text needs a glyph in that range, so a face the content security policy
// refuses can sit unloaded on an English page and never be reported. load() fetches it regardless.

/** One font face and how its load ended: loaded, error (refused or broken), or loading when it did not end in time. */
export interface FaceReport {
  family: string
  weight: string
  style: string
  unicodeRange: string
  status: string
  error?: string
}

const bare = (family: string) => family.replace(/^["']|["']$/g, '')

/** Loads each face of `fonts` (only those of `families` when given) and reports it, waiting at most `timeoutMs` for each. */
export async function loadFaces(fonts: Iterable<FontFace>, families: readonly string[] | null, timeoutMs = 15_000): Promise<FaceReport[]> {
  const faces = [...fonts].filter((f) => !families || families.includes(bare(f.family)))
  return Promise.all(
    faces.map(async (f) => {
      let error: string | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([f.load(), new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))])
      } catch (e) {
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      } finally {
        clearTimeout(timer)
      }
      return { family: bare(f.family), weight: f.weight, style: f.style, unicodeRange: f.unicodeRange, status: f.status, ...(error ? { error } : {}) }
    }),
  )
}
