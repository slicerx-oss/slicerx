// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// a. The Vault: every cover and creator logo on screen loads, no picture fails anywhere, no content security refusal
// in the whole run, the backend answers, and Feed and Saved switch. Read only.
import { waitUntil } from '../lib/util.mjs'

/** The pictures of the Vault's cards, featured design and new creators, each with where it was found. */
async function pictures(s) {
  const out = []
  for (const id of ['vault-featured', 'vault-card', 'vault-creator']) {
    for (const m of await s.element(id)) {
      for (const img of m.images ?? []) out.push({ ...img, in: id, listing: m.data?.listing ?? m.data?.handle ?? '' })
    }
  }
  return out
}

/** A refused eval rather than a refused address (the page side resolves the blocked "eval" against the page). */
export const isEvalProbe = (text) => /^Refused by script-src(-elem)?: (\S*\/)?eval$/.test(text)

const kind = (img) => (/\/logo[^/]*$/i.test(img.url) || img.in === 'vault-creator' ? 'logo' : 'cover')

export async function vault(s) {
  const marker = await s.marker()
  await s.feed()
  if (!(await s.waitFor('vault-card', 'visible', 30_000))) s.stop('the Vault shows design cards', 'no vault-card after 30 s')
  // Give the pictures on screen time to arrive; lazy ones far off screen wait for scrolling and are reported apart.
  await waitUntil(async () => ((await pictures(s)).some((i) => i.inView && i.state === 'pending') ? null : true), { timeoutMs: 20_000, everyMs: 500 })
  const imgs = await pictures(s)
  const count = (k, st) => imgs.filter((i) => kind(i) === k && (!st || i.state === st)).length
  const failed = imgs.filter((i) => i.state === 'failed')
  const stuck = imgs.filter((i) => i.inView && i.state !== 'loaded')
  const cards = await s.element('vault-card')
  s.check(`design cards on screen (${cards.length})`, cards.length > 0)
  s.check(
    `covers loaded: ${count('cover', 'loaded')} of ${count('cover')} (${count('cover', 'pending')} far off screen not started)`,
    count('cover') > 0 && failed.every((i) => kind(i) !== 'cover') && stuck.every((i) => kind(i) !== 'cover'),
    [...failed, ...stuck].filter((i) => kind(i) === 'cover').map((i) => `${i.state} ${i.url}`).slice(0, 10),
  )
  s.check(
    `creator logos loaded: ${count('logo', 'loaded')} of ${count('logo')}`,
    failed.every((i) => kind(i) !== 'logo') && stuck.every((i) => kind(i) !== 'logo'),
    [...failed, ...stuck].filter((i) => kind(i) === 'logo').map((i) => `${i.state} ${i.url}`).slice(0, 10),
  )
  s.info('picture files seen', [...new Set(imgs.filter((i) => i.state === 'loaded').map((i) => i.url.replace(/.*\//, '')))].slice(0, 30))
  await s.shot('vault', 'The Vault, Feed')

  const { network, console } = await s.since(marker)
  // A picture that failed to load leaves an entry even when the app hides it (a logo falls back to initials).
  const lost = network.filter((e) => e.resource && !e.ok)
  s.check('no picture failed to load', lost.length === 0, lost.map((e) => e.url).slice(0, 10))
  const refused = network.filter((e) => !e.resource && (e.status === null || e.status >= 400))
  s.check('the backend answered every call', refused.length === 0, refused.map((e) => `${e.method} ${e.status ?? e.error} ${e.url}`).slice(0, 10))
  // Content security refusals over the whole run so far, not only this scenario. A refused eval is a library probing
  // whether eval is allowed (zod does at startup, in a try); nothing fails to load, so it is reported, not failed.
  const csp = ((await s.call('app_console', { since: 0, limit: 1000 })).data?.entries ?? []).filter((e) => e.level === 'csp')
  const probes = csp.filter((e) => isEvalProbe(e.text))
  const blocked = csp.filter((e) => !isEvalProbe(e.text))
  s.check('no content security refusals', blocked.length === 0, blocked.map((e) => e.text).slice(0, 10))
  if (probes.length) s.info(`eval refused ${probes.length} time(s): a script checking whether eval is allowed (zod at startup); nothing was blocked from loading`, probes.map((e) => `${e.at} ${e.text}`))
  const errors = console.filter((e) => e.level === 'error' || e.level === 'pageerror')
  if (errors.length) s.info(`console errors while the Vault loaded (${errors.length})`, errors.map((e) => e.text).slice(0, 5))

  // Feed and Saved.
  await s.click('vault-saved')
  const saved = await waitUntil(async () => ((await s.one('vault-saved'))?.checked ? true : null), { timeoutMs: 10_000, everyMs: 300 })
  s.check('Saved switches on', !saved.timedOut && (await s.one('vault-feed'))?.checked === false)
  await s.shot('saved', 'The Vault, Saved')
  await s.click('vault-feed')
  const feed = await waitUntil(async () => ((await s.one('vault-feed'))?.checked ? true : null), { timeoutMs: 10_000, everyMs: 300 })
  s.check('Feed switches back with its cards', !feed.timedOut && (await s.waitFor('vault-card', 'visible', 15_000)))
}
