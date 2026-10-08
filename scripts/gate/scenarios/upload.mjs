// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// d. The creator page and an upload: save the account's creator page, open a fresh two-color coaster made for this
// run, upload it as This project (the swatches derived from its colors, the cover drawn from the model), wait
// (bounded) for the malware scan, then print that it needs review approval and wait (bounded) until the listing is
// live as the uploader sees it in Your uploads. Then it is in the Feed, opens, and offers no mesh export (sealed).
// The banner and logo are file pickers a person sets; the gate leaves them as they are.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { coaster3mf } from '../lib/coaster.mjs'
import { waitUntil } from '../lib/util.mjs'
import { signIn } from './accounts.mjs'

const MESH_EXPORT = /(stl|obj)$/

/** The creator page: made on first use, otherwise its bio updated with this run's date, and saved. */
async function creatorPage(s, account) {
  await s.feed()
  await s.click('account-menu')
  if (!(await s.waitFor('account-creator-page', 'visible', 10_000))) s.stop('the account menu offers Your creator page', 'no account-creator-page')
  await s.click('account-creator-page')
  if (!(await s.waitFor('creator-form', 'visible', 30_000))) s.stop('the creator page editor opens', 'no creator-form after 30 s')
  const name = await s.one('creator-name')
  const handle = await s.one('creator-handle')
  const local = account.split('@')[0]
  const isNew = !name?.value
  if (isNew) {
    await s.fill('creator-name', local.replace(/(^|[-._])(\w)/g, (_, a, b) => `${a ? ' ' : ''}${b.toUpperCase()}`).trim())
    if (handle?.enabled) await s.fill('creator-handle', local.replace(/[^a-z0-9-]/g, '-'))
  }
  await s.fill('creator-bio', `Release gate test account. Last gate run ${new Date().toISOString().slice(0, 10)}.`)
  await s.shot('creator-filled', isNew ? 'Creator page: set up' : 'Creator page: bio updated')
  await s.click('creator-save')
  const saved = await waitUntil(async () => {
    const st = await s.one('creator-state')
    if (st?.data?.error !== undefined) return `error: ${st.text}`
    if (!(await s.ids())['creator-form']) return 'closed'
    return /All changes saved/.test(st?.text ?? '') ? 'saved' : null
  }, { timeoutMs: 30_000, everyMs: 500 })
  s.check(`the creator page saves (${isNew ? 'new' : 'existing'} page)`, saved.value === 'saved' || saved.value === 'closed', saved.value ?? 'no answer in 30 s')
  await s.shot('creator-saved', 'Creator page saved')
  if ((await s.ids())['creator-view-sheet']) {
    await s.click('creator-view-sheet')
    await s.sleep(2500)
    await s.shot('creator-sheet', 'The creator sheet')
    await s.call('app_press_key', { key: 'Escape' })
  } else if ((await s.ids())['creator-discard']) await s.click('creator-discard')
}

/** The newest row of Your uploads with this title, as { listing, stage }. */
async function uploadRow(s, title) {
  const rows = await s.element('uploads-row')
  const stages = await s.element('uploads-stage')
  const at = rows.findIndex((r) => r.text.includes(title))
  if (at < 0) return null
  return { listing: rows[at].data?.listing, stage: stages[at]?.data?.stage, label: stages[at]?.text }
}

/** Keeps Your uploads on screen (it refreshes itself while an upload is on its way). */
async function showUploads(s) {
  if ((await s.ids())['uploads-list']) return
  await s.feed()
  await s.click('account-menu')
  await s.waitFor('account-uploads', 'visible', 10_000)
  await s.click('account-uploads')
  await s.waitFor('uploads-list', 'visible', 15_000)
}

export async function upload(s, { account, out, waitSignin, waitScan, waitReview, platform }) {
  await signIn(s, account, waitSignin, 'Sign in for the upload')
  await creatorPage(s, account)

  // A fresh model for this run.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
  const title = `QA gate coaster ${platform} ${stamp}`
  const model = coaster3mf({ title })
  const file = join(out, `qa-gate-coaster-${stamp}.3mf`)
  writeFileSync(file, model.bytes)
  s.info('made a fresh two-color coaster', { file: file.replace(/.*[\\/]/, ''), colors: model.colors, ringInnerMm: model.ringInnerMm })
  s.check('Clear the plate empties it', await s.clearPlate())
  const opened = await s.call('app_open_file', { path: file, timeoutMs: 60_000 })
  if (opened.error) s.stop('the coaster opens', opened.error)
  const objs = opened.data.state.plate.objects
  s.check('the coaster opens with its two parts', objs.length === 1 && objs[0].parts.length === 2, objs.map((o) => ({ name: o.name, parts: o.parts })))

  // Upload it as This project.
  await s.feed()
  await s.click('vault-upload')
  if (!(await s.waitFor('upload-form', 'visible', 30_000))) s.stop('Upload opens its form', 'no upload-form (no creator page?)')
  if ((await s.ids())['upload-source-project']) await s.click('upload-source-project')
  const packed = await waitUntil(async () => (/Every plate as/.test((await s.one('upload-project-file'))?.text ?? '') ? true : null), { timeoutMs: 60_000, everyMs: 500 })
  s.check('the project is packed for the upload', !packed.timedOut, (await s.one('upload-project-file'))?.text)
  const swatches = await waitUntil(async () => {
    const rows = await s.element('colors-row')
    return rows.length >= 2 ? rows.map((r) => String(r.data?.hex ?? '').toLowerCase()) : null
  }, { timeoutMs: 20_000, everyMs: 500 })
  const want = model.colors.map((c) => c.toLowerCase())
  s.check(`the swatches are derived from the model: ${want.join(', ')}`, !swatches.timedOut && want.every((c) => swatches.value.includes(c)), swatches.value)
  const cover = await waitUntil(async () => {
    const c = await s.one('upload-cover')
    return c?.data?.source === 'render' && c.images?.[0]?.state === 'loaded' ? c : null
  }, { timeoutMs: 30_000, everyMs: 500 })
  s.check('the cover is drawn from the model', !cover.timedOut, cover.value?.images ?? (await s.one('upload-cover')))
  await s.fill('upload-title', title)
  await s.fill('upload-description', `An original two-color test model made by the release gate on ${platform}. Not for printing.`)
  await s.fill('upload-tags', 'test, coaster')
  await s.shot('upload-filled', 'Upload: derived swatches and the drawn cover')
  const marker = await s.marker()
  await s.click('upload-submit')
  const sent = await waitUntil(async () => {
    const t = ((await s.call('app_toasts', { since: marker })).data?.entries ?? []).find((x) => x.tone === 'error' || /waiting for review/.test(x.text))
    if (t) return t
    return (await s.ids())['uploads-list'] ? { tone: 'ok', text: 'Your uploads' } : null
  }, { timeoutMs: 180_000, everyMs: 1000 })
  if (sent.timedOut || sent.value.tone === 'error') s.stop('the upload is sent', sent.value?.text ?? 'no answer in 3 min')
  s.check('the upload is sent and waits for review', true, sent.value.text)
  await showUploads(s)
  const row = await waitUntil(() => uploadRow(s, title), { timeoutMs: 30_000, everyMs: 1000 })
  if (row.timedOut) s.stop('Your uploads lists it', 'no row with its title')
  const listing = row.value.listing
  s.info('the listing', { listing, stage: row.value.stage })
  await s.shot('uploads', 'Your uploads, right after the upload')

  // The scan.
  const scanned = await waitUntil(async () => {
    await showUploads(s)
    const r = await uploadRow(s, title)
    return r && !['uploading', 'scanning'].includes(r.stage) ? r : null
  }, { timeoutMs: waitScan * 60_000, everyMs: 5000 })
  if (scanned.timedOut) s.stop(`the scan finishes within ${waitScan} min`, `still ${(await uploadRow(s, title))?.label ?? 'not listed'}`)
  if (scanned.value.stage === 'rejected') s.stop('the scan passes', scanned.value.label)
  s.check(`the malware scan passed (${scanned.value.label})`, true)

  // Review: a person approves it; the gate waits for the listing to go live.
  const review = await s.operatorWait({
    account,
    what: `NEEDS REVIEW APPROVAL: listing ${listing} "${title}" by ${account} is in review. Approve it in the review queue.`,
    lines: [`Listing: ${listing}`, `Title: ${title}`, `Uploaded by: ${account}`],
    timeoutMs: waitReview * 60_000,
    done: async () => {
      await showUploads(s)
      const r = await uploadRow(s, title)
      return r && ['live', 'rejected'].includes(r.stage) ? r : null
    },
  })
  if (review.timedOut) s.stop(`approved within ${waitReview} min`, 'still in review: the approval was not given')
  if (review.value.stage !== 'live') s.stop('the review approves it', review.value.label)
  s.check('approved: the listing is live', true, review.value.label)
  await s.shot('live', 'Your uploads: live')
  await s.call('app_press_key', { key: 'Escape' })

  // In the Feed, opens, sealed.
  await s.feed()
  const inFeed = await waitUntil(async () => ((await s.element('vault-card')).some((c) => c.data?.listing === listing) ? true : null), { timeoutMs: 60_000, everyMs: 2000 })
  s.check('it shows in the Feed', !inFeed.timedOut)
  s.check('Clear the plate empties it', await s.clearPlate())
  const open = await s.call('app_open_vault_design', { id: listing, timeoutMs: 120_000 })
  if (open.error) s.stop('it opens from the Vault', open.error)
  s.check('it opens from the Vault', (open.data.state.plate.objects ?? []).every((o) => o.vaultListing === listing))
  await s.click('tab-prepare')
  await s.click('export-menu')
  await s.waitFor('export-save-project', 'visible', 5000)
  const items = Object.keys(await s.ids()).filter((k) => k.startsWith('export-') && k !== 'export-menu')
  const texts = await Promise.all(items.map(async (k) => (await s.one(k))?.text ?? ''))
  const meshItem = texts.filter((t) => /\b(stl|obj)\b|\.3mf\b(?!.*gcode)/i.test(t) && !/gcode/i.test(t))
  await s.shot('export-menu', 'Export menu on the opened upload')
  await s.call('app_press_key', { key: 'Escape' })
  const commands = (await s.state()).exports ?? {}
  const meshOn = Object.entries(commands).filter(([id, on]) => on && MESH_EXPORT.test(id))
  s.check('sealed: the Export menu offers no mesh export', meshItem.length === 0, texts)
  s.check('sealed: no mesh export command is on (File menu, command palette)', Object.keys(commands).length > 0 && meshOn.length === 0, commands)
}
