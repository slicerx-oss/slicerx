// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Vault end to end against a real stack: sign up by magic link, make a creator page, upload a calibration cube
// in the app, let the scan worker and ClamAV pass it, approve it as the owner, find it in the Vault, download it as
// another member (sealed .sx3mf only), open it (export blocked, slicing works), then like, save and follow.
//
// It needs the stack from e2e/stack/vault-stack.sh and runs with playwright.stack.config.ts:
//   eval "$(e2e/stack/vault-stack.sh start)"   # on the build machine; prints SX_E2E_* values
//   SX_E2E_SUPABASE_URL=... SX_E2E_ANON_KEY=... SX_E2E_SERVICE_KEY=... SX_E2E_MAIL_URL=... \
//     pnpm exec playwright test -c playwright.stack.config.ts
// Without those variables every test is skipped.
import { deflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'

const url = process.env['SX_E2E_SUPABASE_URL'] ?? ''
const anon = process.env['SX_E2E_ANON_KEY'] ?? ''
const service = process.env['SX_E2E_SERVICE_KEY'] ?? ''
const mail = process.env['SX_E2E_MAIL_URL'] ?? ''
const run = Boolean(url && anon && service && mail)
const stamp = Date.now().toString(36)
const title = `E2E calibration cube ${stamp}`

test.describe.configure({ mode: 'serial' })
test.skip(!run, 'needs the stack from e2e/stack/vault-stack.sh')

/** A binary STL of a 20 mm cube standing on the bed. */
function cubeStl(): Buffer {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const tris = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  const b = Buffer.alloc(84 + tris.length * 50)
  b.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => t.forEach((k, j) => v[k]!.forEach((c, n) => b.writeFloatLE(c, 84 + i * 50 + 12 + j * 12 + n * 4))))
  return b
}

/** A one-color PNG, for the banner and logo. */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (d: Buffer) => {
    let c = 0xffffffff
    for (const x of d) c = (table[(c ^ x) & 255] ?? 0) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'ascii')
    data.copy(out, 8)
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}

const rest = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(`${url}${path}`, { ...init, headers: { apikey: init.token ? anon : service, Authorization: `Bearer ${init.token ?? service}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })

/** The newest sign-in link the mail catcher holds for this address. */
async function magicLink(email: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const list = (await (await fetch(`${mail}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages?: { ID: string }[] }
    const id = list.messages?.[0]?.ID
    if (id) {
      const msg = (await (await fetch(`${mail}/api/v1/message/${id}`)).json()) as { Text?: string; HTML?: string }
      const body = `${msg.Text ?? ''} ${msg.HTML ?? ''}`.replaceAll('&amp;', '&')
      const link = /https?:\/\/[^\s"'<>)]+\/auth\/v1\/verify\?[^\s"'<>)]+/.exec(body)?.[0]
      if (link) return link
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`no sign-in mail for ${email}`)
}

/** Signs the page up or in through the app's own sign-in dialog and the emailed link. */
async function signIn(page: Page, email: string): Promise<void> {
  await page.addInitScript(() => {
    // Saves fall back to a plain download, which the test can catch, instead of the native save dialog.
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'feed', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await page.locator('.lib-bar').getByRole('button', { name: 'Sign in' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign in or create an account' })
  await dialog.getByLabel('Email').fill(email)
  await dialog.getByRole('button', { name: 'Email me a link' }).click()
  await expect(dialog.getByText(/We sent a sign-in link to/)).toBeVisible()
  await page.goto(await magicLink(email))
  await expect(page.locator('.lib-bar').getByRole('button', { name: 'Sign in' })).toHaveCount(0, { timeout: 30_000 })
}

/** A session for an account, straight from the admin API: for checks the app does not make itself. */
async function sessionFor(email: string): Promise<string> {
  const link = (await (await rest('/auth/v1/admin/generate_link', { method: 'POST', body: JSON.stringify({ type: 'magiclink', email }) })).json()) as { hashed_token?: string; properties?: { hashed_token?: string } }
  const hash = link.hashed_token ?? link.properties?.hashed_token
  const verified = (await (await fetch(`${url}/auth/v1/verify`, { method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: hash }) })).json()) as { access_token?: string }
  if (!verified.access_token) throw new Error(`no session for ${email}`)
  return verified.access_token
}

let listingId = ''

test('a creator signs up, makes a page and uploads a calibration cube, and the owner approves it', async ({ page, browser }) => {
  await signIn(page, `creator-${stamp}@example.com`)
  await page.locator('.lib-bar').getByRole('button', { name: 'Upload' }).click()
  const editor = page.getByRole('dialog', { name: 'Set up your creator page' })
  await editor.getByLabel('Display name').fill(`E2E Prints ${stamp}`)
  await editor.getByLabel('Handle').fill(`e2e-${stamp}`)
  await editor.getByLabel('Upload banner').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: png(600, 200, [122, 58, 99]) })
  await editor.getByLabel('Upload logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png(256, 256, [255, 121, 198]) })
  await editor.getByRole('button', { name: 'Save and continue' }).click()

  const form = page.getByRole('dialog', { name: 'Upload a design' })
  const choose = form.getByRole('radio', { name: 'A file' })
  if (await choose.count()) await choose.click()
  await form.getByLabel('Pick a model file').setInputFiles({ name: 'calibration-cube.stl', mimeType: 'model/stl', buffer: cubeStl() })
  await form.getByLabel('Title').fill(title)
  await form.getByLabel('Description').fill('A 20 mm cube for checking dimensions.')
  await form.getByLabel(/^Tags/).fill('calibration, desk, functional')
  await form.getByLabel('License').selectOption('cc0')
  await form.getByRole('button', { name: 'Submit for review' }).click()

  const list = page.getByRole('list', { name: 'Your uploads' })
  const row = list.locator('li', { hasText: title })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row.getByText(/Waiting for the scan|In review/)).toBeVisible()
  const found = (await (await rest(`/rest/v1/listings?select=id&title=eq.${encodeURIComponent(title)}`)).json()) as { id: string }[]
  listingId = found[0]?.id ?? ''
  expect(listingId).not.toBe('')

  // The scan worker claims it, ClamAV passes it, and the clean file is stored as an .sx3mf.
  await expect
    .poll(async () => ((await (await rest(`/rest/v1/listing_versions?select=scan_status,storage_path&listing_id=eq.${listingId}`)).json()) as { scan_status: string }[])[0]?.scan_status, { timeout: 300_000, intervals: [3000] })
    .toBe('clean')
  const v = ((await (await rest(`/rest/v1/listing_versions?select=storage_path,format,scan_report&listing_id=eq.${listingId}`)).json()) as { storage_path: string; format: string; scan_report: { verdict?: string } }[])[0]
  expect(v?.storage_path).toMatch(/\.sx3mf$/)
  expect(v?.format).toBe('sx3mf')
  expect(v?.scan_report.verdict).toBe('clean')
  await expect(row.getByText('In review')).toBeVisible({ timeout: 20_000 })

  // The owner approves it from the review queue.
  const ownerContext = await browser.newContext()
  const owner = await ownerContext.newPage()
  await signIn(owner, 'owner@example.com')
  await owner.locator('.lib-bar-tools').getByRole('button').first().click()
  await owner.getByRole('menuitem', { name: 'Review queue' }).click()
  const queued = owner.getByRole('list', { name: 'Waiting for review' }).locator('li', { hasText: title })
  await expect(queued.getByText('Scan passed')).toBeVisible({ timeout: 30_000 })
  await queued.getByRole('button', { name: 'Approve' }).click()
  await expect(queued).toHaveCount(0, { timeout: 20_000 })
  await ownerContext.close()
  await expect(row.getByText('Live')).toBeVisible({ timeout: 20_000 })
})

test('another member finds it, gets only the sealed file, and cannot export it', async ({ page }) => {
  test.skip(!listingId, 'needs the upload from the first test')
  const member = `member-${stamp}@example.com`
  await signIn(page, member)
  await page.reload()
  const recent = page.getByRole('region', { name: 'Recent' })
  await expect(recent.getByText(title)).toBeVisible({ timeout: 30_000 })

  // Download: the file is the sealed .sx3mf.
  await recent.getByRole('button', { name: `${title}, details` }).click()
  const sheet = page.getByRole('dialog', { name: title })
  const [download] = await Promise.all([page.waitForEvent('download'), sheet.getByRole('button', { name: /^Download/ }).click()])
  expect(download.suggestedFilename()).toMatch(/\.sx3mf$/)

  // The raw upload is gone from quarantine, and nothing but the .sx3mf is readable.
  const token = await sessionFor(member)
  const files = (await (await rest(`/rest/v1/listing_versions?select=id,storage_path&listing_id=eq.${listingId}`)).json()) as { id: string; storage_path: string }[]
  const sealed = files[0]!.storage_path
  const raw = sealed.replace(/\.sx3mf$/, '.stl')
  const read = (bucket: string, path: string) => fetch(`${url}/storage/v1/object/authenticated/${bucket}/${path}`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } })
  expect((await read('listing-files', sealed)).status).toBe(200)
  expect((await read('uploads-quarantine', raw)).status).not.toBe(200)
  expect((await read('listing-files', raw)).status).not.toBe(200)

  // Open it: the plate holds it as a Vault design, mesh export is off, and it slices.
  type Sx = { getState(): { plate: { source?: { modelId?: string } }[]; slice: { status: string; stale?: boolean } } }
  // The viewport puts the app state on window once it is up.
  const state = () => page.evaluate(() => { const sx = (window as unknown as { __sx?: Sx }).__sx; if (!sx) return { vault: false, status: 'loading', stale: true }; const s = sx.getState(); return { vault: s.plate.some((p) => Boolean(p.source?.modelId)), status: s.slice.status, stale: s.slice.stale ?? false } })
  await sheet.getByRole('button', { name: /^Open in / }).click()
  await expect.poll(async () => (await state()).vault, { timeout: 60_000 }).toBe(true)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible()
  await page.keyboard.type('Export the plate as STL')
  await expect(page.locator('.sx-palette-item:not([aria-disabled="true"])', { hasText: 'Export the plate as STL' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect.poll(async () => { const s = await state(); return s.status === 'done' && !s.stale }, { timeout: 180_000 }).toBe(true)
})

test('likes, saves and follows show in Saved, Based on your likes and the follower count', async ({ page }) => {
  test.skip(!listingId, 'needs the upload from the first test')
  await signIn(page, `fan-${stamp}@example.com`)
  // It may be the featured design by now (it has downloads this week), or a card in a row.
  await page.getByRole('button', { name: `${title}, details` }).first().click()
  const sheet = page.getByRole('dialog', { name: title })
  await sheet.getByRole('button', { name: 'Like' }).click()
  await expect(sheet.getByRole('button', { name: 'Liked' })).toBeVisible()
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet.getByRole('button', { name: 'Saved' })).toBeVisible()
  await sheet.locator('.lib-who').click()
  const creator = page.getByRole('dialog', { name: /creator page$/ })
  await creator.getByRole('button', { name: 'Follow' }).click()
  await expect(creator.getByText('1 follower')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.reload()
  await expect(page.getByRole('region', { name: 'Based on your likes' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /^Saved/ }).first().click()
  await expect(page.locator('.lib-grid-cards').getByText(title)).toBeVisible()
})
