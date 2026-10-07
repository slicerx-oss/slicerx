// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads the Vault marks (sx:Listing, sx:Creator) from a 3MF model part or Metadata/model_settings.config.
// A small namespace-aware tag reader, not a regex: any quoting, attribute order, prefix bound to the sx
// namespace, entity or position in the file is seen. Mesh tags are skipped without building anything, so a
// model part of tens of megabytes reads in one pass. It errs toward finding a mark: a metadata element of any
// namespace counts, by `name` or `key`, with its value from `value` or its text.
import { SX3MF_NAMESPACE } from './sx3mf'

export interface VaultMark {
  /** sx:Listing, the Vault listing id. */
  listing?: string
  /** sx:Creator, the creator id. */
  creator?: string
}

export interface VaultMarks {
  /** Marks outside any object (or every mark, when not read by object). */
  root: VaultMark
  /** Marks inside an object element, by the object's id. */
  objects: Map<string, VaultMark>
}

/** Thrown for a part that declares a DTD: 3MF packages may not, and its entities could hide a mark. */
export class MarkReadError extends Error {}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all
    }
    return ENTITIES[e] ?? all
  })
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13

interface Open {
  local: string
  /** Namespace bindings this element declared, prefix to uri ('' is the default namespace). */
  ns?: Map<string, string>
  objectId?: string
  meta?: { name: string; value: string; text: string[] }
}

/** Which mark a metadata name (prefix:Local) is, by its prefix's namespace or by the `sx` prefix itself. */
function markKind(name: string, resolve: (prefix: string) => string | undefined): keyof VaultMark | null {
  const colon = name.indexOf(':')
  if (colon < 0) return null
  const prefix = name.slice(0, colon).trim()
  const local = name.slice(colon + 1).trim().toLowerCase()
  const kind = local === 'listing' ? 'listing' : local === 'creator' ? 'creator' : null
  if (!kind) return null
  return prefix.toLowerCase() === 'sx' || resolve(prefix) === SX3MF_NAMESPACE ? kind : null
}

/**
 * The Vault marks in an XML part. With `byObject`, a mark inside an `object` element is filed under that
 * object's id (model_settings.config); otherwise every mark is a root mark (the model part).
 */
export function readVaultMarks(xml: string, byObject = false): VaultMarks {
  const out: VaultMarks = { root: {}, objects: new Map() }
  const stack: Open[] = []
  const resolve = (prefix: string): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const v = stack[i]!.ns?.get(prefix)
      if (v !== undefined) return v
    }
    return undefined
  }
  const file = (el: Open) => {
    const m = el.meta!
    const kind = markKind(m.name, resolve)
    const value = (m.value || m.text.join('')).trim()
    if (!kind || !value) return
    let objectId: string | undefined
    if (byObject) for (let i = stack.length - 1; i >= 0 && objectId === undefined; i--) objectId = stack[i]!.objectId
    let target = out.root
    if (objectId !== undefined) {
      target = out.objects.get(objectId) ?? {}
      out.objects.set(objectId, target)
    }
    target[kind] ??= value
  }
  const capturing = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.meta) return stack[i]!.meta
    return undefined
  }
  const n = xml.length
  let p = 0
  while (p < n) {
    const lt = xml.indexOf('<', p)
    const textEnd = lt < 0 ? n : lt
    if (textEnd > p) {
      const m = capturing()
      if (m) m.text.push(decode(xml.slice(p, textEnd)))
    }
    if (lt < 0) break
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4)
      p = e < 0 ? n : e + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9)
      const m = capturing()
      if (m) m.text.push(xml.slice(lt + 9, e < 0 ? n : e))
      p = e < 0 ? n : e + 3
      continue
    }
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2)
      p = e < 0 ? n : e + 2
      continue
    }
    if (xml.startsWith('<!', lt)) {
      if (/^<!doctype/i.test(xml.slice(lt, lt + 9))) throw new MarkReadError('The 3MF declares a DTD, which is unsafe and not allowed in a 3MF package.')
      const e = xml.indexOf('>', lt + 2)
      p = e < 0 ? n : e + 1
      continue
    }
    const closing = xml.charCodeAt(lt + 1) === 47 // '/'
    let q = closing ? lt + 2 : lt + 1
    const nameStart = q
    while (q < n) {
      const c = xml.charCodeAt(q)
      if (isSpace(c) || c === 62 || c === 47) break // '>' '/'
      q++
    }
    const qname = xml.slice(nameStart, q)
    const local = qname.slice(qname.indexOf(':') + 1)
    if (closing) {
      const e = xml.indexOf('>', q)
      p = e < 0 ? n : e + 1
      // Pops to the matching element; a stray end tag is ignored.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.local !== local) continue
        while (stack.length > i) {
          const el = stack[stack.length - 1]!
          if (el.meta) file(el)
          stack.pop()
        }
        break
      }
      continue
    }
    const lower = local.toLowerCase()
    const wanted = lower === 'metadata' || lower === 'object'
    let attrs: Map<string, string> | undefined
    let ns: Map<string, string> | undefined
    let selfClosing = false
    // Attributes: name, '=', a quoted value in either quote.
    while (q < n) {
      while (q < n && isSpace(xml.charCodeAt(q))) q++
      const c = xml.charCodeAt(q)
      if (c === 62) {
        q++
        break
      }
      if (c === 47 && xml.charCodeAt(q + 1) === 62) {
        selfClosing = true
        q += 2
        break
      }
      const an = q
      while (q < n) {
        const d = xml.charCodeAt(q)
        if (d === 61 || isSpace(d) || d === 62 || d === 47) break
        q++
      }
      const aEnd = q
      while (q < n && isSpace(xml.charCodeAt(q))) q++
      if (xml.charCodeAt(q) !== 61) {
        // Not well formed; step past the character and carry on.
        if (q === an) q++
        continue
      }
      q++
      while (q < n && isSpace(xml.charCodeAt(q))) q++
      const quote = xml.charCodeAt(q)
      if (quote !== 34 && quote !== 39) continue
      const vEnd = xml.indexOf(quote === 34 ? '"' : "'", q + 1)
      const vStart = q + 1
      q = vEnd < 0 ? n : vEnd + 1
      const isNs = xml.startsWith('xmlns', an) && (aEnd === an + 5 || xml.charCodeAt(an + 5) === 58)
      if (!wanted && !isNs) continue
      const aName = xml.slice(an, aEnd)
      const value = decode(xml.slice(vStart, vEnd < 0 ? n : vEnd))
      if (isNs) (ns ??= new Map()).set(aEnd === an + 5 ? '' : aName.slice(6), value)
      else (attrs ??= new Map()).set(aName, value)
    }
    p = q
    const el: Open = { local, ...(ns ? { ns } : {}) }
    if (lower === 'object') el.objectId = attrs?.get('id') ?? ''
    if (lower === 'metadata') {
      const name = attrs?.get('name') ?? attrs?.get('key') ?? ''
      el.meta = { name, value: attrs?.get('value') ?? '', text: [] }
    }
    stack.push(el)
    if (selfClosing) {
      if (el.meta) file(el)
      stack.pop()
    }
  }
  // An unclosed metadata element still counts.
  while (stack.length) {
    const el = stack[stack.length - 1]!
    if (el.meta) file(el)
    stack.pop()
  }
  return out
}

/** True when any mark names a listing. */
export function hasListing(marks: VaultMarks): boolean {
  if (marks.root.listing) return true
  for (const m of marks.objects.values()) if (m.listing) return true
  return false
}
