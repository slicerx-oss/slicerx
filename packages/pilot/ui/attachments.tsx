// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Files on a message: photos of what a part must fit, sketches, and PDF drawings. They go to the model with the
// message; the chip shows a thumbnail (an icon for a PDF), the name and, while the message is still being written, a
// remove button. A big picture is scaled down to what the model reads anyway before it is sent.
import type { PilotAttachment } from '@slicerx/contracts'
import { Icon, tipAttrs } from '@slicerx/ui'
import { FILE_LIMITS } from '../src/attach'

/** What a message may carry: pictures and PDFs up to 10 MB each, four at most. */
export const ATTACH_LIMITS = { types: FILE_LIMITS.types, maxBytes: FILE_LIMITS.maxBytes, maxCount: FILE_LIMITS.maxCount } as const

export const ATTACH_ACCEPT = ATTACH_LIMITS.types.join(',')

/** Why a file can't be added, in words for the person, or null when it can. */
export function attachProblem(file: { name: string; type: string; size: number }, count: number): string | null {
  if (count >= ATTACH_LIMITS.maxCount) return `A message holds up to ${ATTACH_LIMITS.maxCount} files.`
  if (!ATTACH_LIMITS.types.includes(file.type)) return `${file.name} isn't an image or a PDF. Add a PNG, JPEG, WebP, GIF or PDF.`
  if (file.size > ATTACH_LIMITS.maxBytes) return `${file.name} is over 10 MB.`
  return null
}

/** The longest side the model reads a picture at; a bigger one is scaled down to it before sending. */
export const MODEL_EDGE = 1568
/** Pictures over this are re-encoded even when small enough in pixels, to stay well under the providers' per-image caps. */
const MODEL_BYTES = 3_750_000

/** A picture scaled down for the model as a JPEG data URL, or null when the original goes as it is (or can't be read here). */
export async function scaledDown(file: Blob): Promise<string | null> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null
  try {
    const bmp = await createImageBitmap(file)
    const long = Math.max(bmp.width, bmp.height)
    if (long <= MODEL_EDGE && file.size <= MODEL_BYTES) {
      bmp.close()
      return null
    }
    const k = Math.min(1, MODEL_EDGE / long)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bmp.width * k))
    canvas.height = Math.max(1, Math.round(bmp.height * k))
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bmp.close()
      return null
    }
    // JPEG has no transparency: a see-through drawing goes on white, as on paper
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    const url = canvas.toDataURL('image/jpeg', 0.9)
    return url.startsWith('data:image/jpeg') ? url : null
  } catch {
    return null
  }
}

function dataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'))
    r.readAsDataURL(file)
  })
}

let seq = 0

/** Reads files into attachments after `have`, keeping the limits; the problems say what was left out. */
export async function readAttachments(files: readonly File[], have: number): Promise<{ added: PilotAttachment[]; problems: string[] }> {
  const added: PilotAttachment[] = []
  const problems: string[] = []
  for (const f of files) {
    const problem = attachProblem(f, have + added.length)
    if (problem) {
      problems.push(problem)
      continue
    }
    try {
      const small = await scaledDown(f)
      added.push({ id: `att${++seq}`, name: f.name, type: small ? 'image/jpeg' : f.type, bytes: f.size, url: small ?? (await dataUrl(f)) })
    } catch {
      problems.push(`Could not read ${f.name}.`)
    }
  }
  return { added, problems }
}

export function fmtBytes(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** One file: thumbnail, name and size; with `onRemove`, a button that takes it off the message. */
export function AttachmentChip({ attachment: a, onRemove }: { attachment: PilotAttachment; onRemove?: () => void }) {
  return (
    <span className="att-chip" data-testid="mimir-attachment" {...tipAttrs({ title: `${a.name}, ${fmtBytes(a.bytes)}` })}>
      {a.type === 'application/pdf' ? (
        <span className="att-thumb att-doc" aria-hidden="true">
          <Icon name="log" />
        </span>
      ) : (
        <img className="att-thumb" src={a.url} alt="" />
      )}
      <span className="att-name">{a.name}</span>
      {onRemove ? (
        <button type="button" className="att-x" aria-label={`Remove ${a.name}`} onClick={onRemove}>
          <Icon name="close" />
        </button>
      ) : null}
    </span>
  )
}
