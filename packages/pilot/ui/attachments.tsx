// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Files on a message: photos of what a part must fit. They stay on this machine; the chip shows a thumbnail, the name
// and, while the message is still being written, a remove button.
import type { PilotAttachment } from '@slicerx/contracts'
import { Icon, tipAttrs } from '@slicerx/ui'

/** What a message may carry: images up to 10 MB each, four at most. */
export const ATTACH_LIMITS = { types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], maxBytes: 10 * 1024 * 1024, maxCount: 4 } as const

export const ATTACH_ACCEPT = ATTACH_LIMITS.types.join(',')

/** Why a file can't be added, in words for the person, or null when it can. */
export function attachProblem(file: { name: string; type: string; size: number }, count: number): string | null {
  if (count >= ATTACH_LIMITS.maxCount) return `A message holds up to ${ATTACH_LIMITS.maxCount} files.`
  if (!(ATTACH_LIMITS.types as readonly string[]).includes(file.type)) return `${file.name} isn't an image. Add a PNG, JPEG, WebP or GIF.`
  if (file.size > ATTACH_LIMITS.maxBytes) return `${file.name} is over 10 MB.`
  return null
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
      added.push({ id: `att${++seq}`, name: f.name, type: f.type, bytes: f.size, url: await dataUrl(f) })
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
      <img className="att-thumb" src={a.url} alt="" />
      <span className="att-name">{a.name}</span>
      {onRemove ? (
        <button type="button" className="att-x" aria-label={`Remove ${a.name}`} onClick={onRemove}>
          <Icon name="close" />
        </button>
      ) : null}
    </span>
  )
}
