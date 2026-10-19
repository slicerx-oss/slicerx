// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The secrets filter for what mimir remembers: keys the edition config refuses (SECRET_PATTERNS), printer access codes
// and serial numbers. Facts read over the app link have them hidden; a fact with one is not kept. One helper, so the
// memory store's own filter can take its place.
import { SECRET_PATTERNS } from '@slicerx/edition-config'

/** What a hidden secret reads as. */
export const HIDDEN = '[hidden]'

/** A whole private key block, so its body goes with the header SECRET_PATTERNS knows. */
const KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
/** A named access code or serial and its value ("access code 12345678", "serial: 01S00C123456789"); the value has a digit. */
const NAMED = /\b((?:dev[_ -]?)?access[_ -]?code|lan[_ -]?code|code|serial(?:[_ -]?(?:number|no))?|s\/?n)(\s*(?:is\s+|[:=]\s*|\s+))["']?(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}["']?/gi
/** Bambu Lab serials, 15 characters, written without a name. */
const SERIAL = /\b0[0-9A-Z]{2}[0-9A-Z]{2}[A-Z][0-9A-Z]{9}\b/g

const everywhere = (re: RegExp): RegExp => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)

/** `text` with every secret hidden, and whether it had one (a fact with one is refused when saved). */
export function redactSecrets(text: string): { text: string; refused: boolean } {
  let out = text.replace(KEY_BLOCK, HIDDEN)
  for (const [re] of SECRET_PATTERNS) out = out.replace(everywhere(re), HIDDEN)
  out = out.replace(NAMED, (_m, name: string, gap: string) => `${name}${gap}${HIDDEN}`).replace(SERIAL, HIDDEN)
  return { text: out, refused: out !== text }
}

/** Data keys whose values are secrets whatever they look like. */
export const SECRET_KEY = /access[_ -]?code|lan[_ -]?code|^code$|serial|^s\/?n$|password|passwd|secret|token|api[_ -]?key|private[_ -]?key/i
