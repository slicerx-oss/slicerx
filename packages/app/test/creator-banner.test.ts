// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Animated creator banners: a GIF banner is uploaded byte for byte, plays on the page, and holds its first frame
// when motion is reduced. Logos stay still images.
import { cleanup, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMotionPreference } from '@slicerx/ui'
import { BannerImage, isGifBytes, isGifUrl } from '../src/features/store/banner-image'
import { imageTypes, prepareImage } from '../src/features/store/creator-editor'
import { CreatorBanner } from '../src/features/store/creator-sheet'

const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x3b])
const file = (bytes: Uint8Array, name: string, type: string) => new File([bytes.slice().buffer], name, { type })

beforeEach(() => {
  URL.createObjectURL = () => 'blob:banner'
  // jsdom draws nothing; the still frame only needs a context to draw into.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => undefined } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  cleanup()
  setMotionPreference('system')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GIF banners', () => {
  it('tells a GIF by its address and by its bytes', () => {
    expect(isGifUrl('https://x.supabase.co/storage/v1/object/public/creator-media/u/banner-1.gif')).toBe(true)
    expect(isGifUrl('https://x.example.com/banner-1.GIF?v=2')).toBe(true)
    expect(isGifUrl('data:image/gif;base64,R0lGODlh')).toBe(true)
    expect(isGifUrl('https://x.example.com/banner-1.webp')).toBe(false)
    expect(isGifUrl('https://x.example.com/gif/banner.png')).toBe(false)
    expect(isGifBytes(GIF)).toBe(true)
    expect(isGifBytes(new TextEncoder().encode('GIF87a'))).toBe(true)
    expect(isGifBytes(new TextEncoder().encode('<svg>'))).toBe(false)
  })

  it('takes a GIF banner as is, and only for the banner', async () => {
    expect(imageTypes('banner')).toContain('image/gif')
    expect(imageTypes('logo')).not.toContain('image/gif')
    const r = await prepareImage(file(GIF, 'ravens.gif', 'image/gif'), 'banner')
    if (typeof r === 'string') throw new Error(r)
    expect(r.contentType).toBe('image/gif')
    expect([...r.bytes]).toEqual([...GIF])
    expect(await prepareImage(file(GIF, 'ravens.gif', 'image/gif'), 'logo')).toBe("A logo can't be animated. Use a PNG, JPEG or WebP image")
    expect(await prepareImage(file(new TextEncoder().encode('<svg/>'), 'x.gif', 'image/gif'), 'banner')).toBe('This file is not a GIF image')
    const big = new Uint8Array(5 * 1024 * 1024 + 1)
    big.set(GIF)
    expect(await prepareImage(file(big, 'big.gif', 'image/gif'), 'banner')).toMatch(/^GIF banners can be at most 5 MB/)
    expect(await prepareImage(file(GIF, 'x.svg', 'image/svg+xml'), 'banner')).toBe('Use a PNG, JPEG, WebP or GIF image')
  })

  it('plays a GIF banner on the page', () => {
    setMotionPreference('full')
    const { container } = render(createElement(CreatorBanner, { url: 'https://x.example.com/banner-1.gif', seed: 'sx' }))
    expect(container.querySelector('.cs-cover img')?.getAttribute('src')).toBe('https://x.example.com/banner-1.gif')
    expect(container.querySelector('.cs-cover canvas')).toBeNull()
  })

  it('holds the first frame when motion is reduced', async () => {
    setMotionPreference('reduced')
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (u: string) => (fetched.push(u), new Response(new Blob([GIF.slice().buffer], { type: 'image/gif' }))))
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', async () => ({ width: 1800, height: 600, close }))
    const { container } = render(createElement(CreatorBanner, { url: 'https://x.example.com/banner-1.gif', seed: 'sx' }))
    expect(container.querySelector('.cs-cover img')).toBeNull()
    const canvas = container.querySelector<HTMLCanvasElement>('.cs-cover canvas')
    await waitFor(() => expect(canvas?.dataset['ready']).toBe(''))
    expect(fetched).toEqual(['https://x.example.com/banner-1.gif'])
    expect([canvas?.width, canvas?.height]).toEqual([1800, 600])
    expect(close).toHaveBeenCalled()
  })

  it('keeps still banners as plain images with motion reduced', () => {
    setMotionPreference('reduced')
    const { container } = render(createElement(BannerImage, { url: 'https://x.example.com/banner-1.webp' }))
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('shows the layered pattern when the first frame cannot be read', async () => {
    setMotionPreference('reduced')
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    const { container } = render(createElement(CreatorBanner, { url: 'https://x.example.com/banner-1.gif', seed: 'sx' }))
    await waitFor(() => expect(container.querySelector('.cs-cover-art')).not.toBeNull())
    expect(container.querySelector('.cs-cover canvas')).toBeNull()
  })

  it('plays a picked GIF in the editor preview by its type, not its blob address', () => {
    setMotionPreference('reduced')
    vi.stubGlobal('fetch', async () => new Response(new Blob([GIF.slice().buffer], { type: 'image/gif' })))
    vi.stubGlobal('createImageBitmap', async () => ({ width: 2, height: 1, close: () => undefined }))
    const { container } = render(createElement(BannerImage, { url: 'blob:banner', animated: true, alt: 'Current banner' }))
    expect(container.querySelector('canvas[role=img]')?.getAttribute('aria-label')).toBe('Current banner')
  })
})
