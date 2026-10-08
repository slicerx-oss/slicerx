// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// b. Opening a Vault design, signed out and signed in: the download shows its progress, the design lands alone on the
// plate (on the example plate, and on a plate that was cleared), and a plate with changes asks Save project, Don't
// save or Cancel first. Cancel keeps the plate; Don't save opens the design alone. Save project is never pressed.
import { waitUntil } from '../lib/util.mjs'

/** Opens a design through its sheet while sampling the download status; returns the answer and what was seen. */
export async function openWithProgress(s, id) {
  const marker = await s.marker()
  const started = Date.now()
  let done = false
  const opening = s.call('app_open_vault_design', { id, timeoutMs: 120_000 }).finally(() => (done = true))
  const seen = []
  while (!done) {
    for (const m of await s.element('vault-download-status')) {
      const line = `${m.data?.state ?? '?'}: ${m.text}`
      if (seen.at(-1) !== line) seen.push(line)
    }
    await s.sleep(100)
  }
  const r = await opening
  const ms = Date.now() - started
  const toasts = ((await s.call('app_toasts', { since: marker })).data?.entries ?? []).map((t) => `[${t.tone}] ${t.text}`)
  return { r, ms, seen, toasts }
}

const alone = (state, listing) => {
  const objs = state?.plate?.objects ?? []
  return objs.length > 0 && objs.every((o) => o.vaultListing === listing)
}

/** One open with its checks: progress (or a download too quick to sample), and the design alone on the plate. */
async function openAlone(s, id, label) {
  const { r, ms, seen, toasts } = await openWithProgress(s, id)
  if (r.error) s.stop(`${label}: ${id} opens`, r.error)
  const listing = r.data.listing
  const progress = seen.some((l) => l.startsWith('downloading'))
  s.check(`${label}: progress shows while ${listing.title} downloads`, progress || ms < 1500, { took: `${ms} ms`, seen, toasts })
  const st = await s.state()
  s.check(`${label}: ${listing.title} lands alone on the plate`, alone(st, listing.id), st.plate.objects.map((o) => `${o.name} (${o.vaultListing ?? 'not from the Vault'})`))
  return { listing, state: st }
}

/** Signed out: on the example plate, on a cleared plate, and the save question on a changed plate. */
export async function openSignedOut(s) {
  const who = await s.user()
  if (who.signedIn) {
    // A profile used before (macOS keeps one): sign out from the account menu first.
    await s.feed()
    await s.click('account-menu')
    if (await s.waitFor('account-sign-out', 'visible', 10_000)) await s.click('account-sign-out')
    const out = await waitUntil(async () => ((await s.user()).signedIn ? null : true), { timeoutMs: 15_000, everyMs: 500 })
    if (out.timedOut) s.stop('signed out before the signed-out checks', `still signed in as ${who.email}`)
    s.info(`signed out ${who.email} first`)
  }
  s.check('signed out', true)
  const before = await s.state()
  s.info('the plate before the first open', before.plate.objects.map((o) => o.name))
  await openAlone(s, 'temperature-tower', 'on the plate as it starts')
  await s.shot('opened-first', 'Signed out: Temperature tower opened on the starting plate')

  s.check('Clear the plate empties it', await s.clearPlate())
  const second = await openAlone(s, 'cable-clip', 'on a cleared plate')
  s.check('no example comes back with it', second.state.plate.objects.length >= 1 && !second.state.plate.objects.some((o) => !o.vaultListing))
  await s.shot('opened-cleared', 'Signed out: Cable clip opened on a cleared plate')

  // A change: leave the object out of the print. Then another design asks first.
  await s.click('object-printable')
  const changed = await waitUntil(async () => ((await s.state()).plate.objects[0]?.printable === false ? true : null), { timeoutMs: 5000, everyMs: 200 })
  s.check('changed the plate (left the object out of the print)', !changed.timedOut)
  const asked = await s.call('app_open_vault_design', { id: 'wall-hook', timeoutMs: 60_000 })
  s.check('opening another design on a changed plate asks first', /asks whether to save/.test(asked.error ?? ''), asked.error ?? 'it opened without asking')
  s.check('Save changes first? shows', await s.waitFor('unsaved-dialog', 'visible', 10_000), (await s.one('unsaved-dialog'))?.text)
  const buttons = await Promise.all(['unsaved-save', 'unsaved-discard', 'unsaved-cancel'].map(async (b) => [b, (await s.one(b))?.visible === true]))
  s.check('the question offers Save project, Don\'t save and Cancel', buttons.every(([, v]) => v), Object.fromEntries(buttons))
  await s.shot('save-question', 'Save changes first? on a changed plate')
  await s.click('unsaved-cancel')
  await s.waitFor('unsaved-dialog', 'absent', 10_000)
  const kept = await s.state()
  s.check('Cancel keeps the plate as it was', kept.plate.objects.length === second.state.plate.objects.length && kept.plate.objects[0]?.printable === false && alone(kept, second.listing.id))

  const again = s.call('app_open_vault_design', { id: 'wall-hook', timeoutMs: 60_000 })
  if (!(await s.waitFor('unsaved-dialog', 'visible', 30_000))) s.stop('the question shows again', (await again).error ?? 'no question')
  await s.click('unsaved-discard')
  await again
  const opened = await waitUntil(async () => {
    const st = await s.state()
    return !st.plate.loading && st.plate.objects.length > 0 && st.plate.objects.every((o) => o.vaultListing && o.vaultListing !== second.listing.id) ? st : null
  }, { timeoutMs: 120_000, everyMs: 500 })
  s.check('Don\'t save opens the new design alone', !opened.timedOut, opened.value?.plate.objects.map((o) => o.name))
  await s.shot('dont-save', 'After Don\'t save: Wall hook alone')
}

/** Signed in: the same open on a cleared plate, with progress, through the account's session. */
export async function openSignedIn(s) {
  const who = await s.user()
  if (!who.signedIn) s.stop('signed in (after scenario c)', 'not signed in; run c first or sign in')
  s.check(`signed in as ${who.email}`, true)
  s.check('Clear the plate empties it', await s.clearPlate())
  await openAlone(s, 'calibration-cube-20mm', 'signed in, on a cleared plate')
  await s.shot('opened-signed-in', 'Signed in: 20 mm calibration cube opened')
}
