// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A creator banner picture. A GIF banner plays as uploaded; with motion reduced it holds its first frame, drawn
// once to a canvas, so nothing on the page moves.
import { useMotionReduced } from '@slicerx/ui'
import { useEffect, useRef } from 'react'

/** True for a GIF address: a stored .gif file or a GIF data URL. */
export function isGifUrl(url: string): boolean {
  return /^data:image\/gif[;,]/i.test(url) || /\.gif(?:[?#]|$)/i.test(url)
}

/** True when the bytes start with a GIF header (GIF87a or GIF89a). */
export function isGifBytes(b: Uint8Array): boolean {
  return b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
}

/** An image's first frame. createImageBitmap takes the first frame of an animated GIF, never a later one. */
export async function firstFrame(url: string): Promise<ImageBitmap> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`image ${res.status}`)
  return createImageBitmap(await res.blob())
}

interface BannerImageProps {
  url: string
  /** Whether the picture may move. Defaults to whether the address is a GIF; a picked file's blob preview says so itself. */
  animated?: boolean
  alt?: string
  onError?: () => void
}

export function BannerImage({ url, animated = isGifUrl(url), alt = '', onError }: BannerImageProps) {
  const reduced = useMotionReduced()
  if (animated && reduced) return <StillFrame url={url} alt={alt} onError={onError} />
  return <img src={url} alt={alt} onError={onError} />
}

function StillFrame({ url, alt, onError }: { url: string; alt: string; onError?: (() => void) | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const failed = useRef(onError)
  failed.current = onError
  useEffect(() => {
    let live = true
    firstFrame(url).then(
      (bmp) => {
        const c = canvas.current
        if (live && c) {
          c.width = bmp.width
          c.height = bmp.height
          c.getContext('2d')?.drawImage(bmp, 0, 0)
          c.dataset['ready'] = ''
        }
        bmp.close()
      },
      () => {
        if (live) failed.current?.()
      },
    )
    return () => {
      live = false
    }
  }, [url])
  return <canvas ref={canvas} data-still="" {...(alt ? { role: 'img', 'aria-label': alt } : {})} />
}
