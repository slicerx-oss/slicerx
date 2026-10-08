// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// c. Accounts against production with a release-gate address (@qa.slicerx.app): ask for a sign-in link in the app and
// wait (bounded) while an operator opens the emailed link and hands its callback to the app. This runner never reads
// mail, fetches a verify address or touches a sign-in code (docs/release-gate.md, "The operator"). Then: sign out from
// the account menu, the form starts over, two links in a row with Send again and its countdown, the older link shows
// the expired copy, and the newer one signs in again.
import { waitUntil } from '../lib/util.mjs'

const EXPIRED = /expired|newer one was sent/i

/** Opens Sign in from the Vault (or uses the form already open) and asks for a link. Returns when it was asked. */
export async function requestLink(s, account) {
  await s.feed()
  const ids = await s.ids()
  if (!ids['signin-email'] && !ids['signin-sent']) {
    if (!ids['vault-sign-in']) s.stop('the Vault offers Sign in', 'no vault-sign-in (already signed in?)')
    await s.click('vault-sign-in')
    // The dialog shows the form, or (opened again after an earlier request) the sent message with its own controls.
    const shown = await waitUntil(async () => {
      const now = await s.ids()
      return now['signin-email'] || now['signin-sent'] ? true : null
    }, { timeoutMs: 15_000, everyMs: 300 })
    if (shown.timedOut) s.stop('Sign in shows the email form', 'neither the form nor the sent message showed')
  }
  if ((await s.ids())['signin-sent']) {
    await s.click('signin-other-address')
    await s.waitFor('signin-email', 'visible', 10_000)
  }
  const marker = await s.marker()
  await s.fill('signin-email', account)
  await s.click('signin-submit')
  const at = new Date().toISOString()
  const sent = await waitUntil(async () => {
    const ids = await s.ids()
    if (ids['signin-sent']) return 'sent'
    if (ids['signin-error']) return `error: ${(await s.one('signin-error'))?.text}`
    return null
  }, { timeoutMs: 30_000, everyMs: 300 })
  const otp = (await s.since(marker)).network.filter((e) => /\/auth\/v1\/otp$/.test(e.url))
  if (sent.value !== 'sent') s.stop(`asked for a sign-in link for ${account}`, sent.value ?? 'no answer in 30 s')
  s.check(`asked for a sign-in link for ${account} at ${at}`, otp.some((e) => e.status === 200), otp.map((e) => `${e.method} ${e.status} ${e.url}`))
  return at
}

/** Waits until the app reports the account signed in. */
async function signedInAs(s, account) {
  const u = await s.user()
  return u.signedIn && String(u.email).toLowerCase() === account ? u : null
}

/** Asks for a link and waits for the operator; the sign-in other scenarios start from when they need a session. */
export async function signIn(s, account, minutes, why = 'Sign in') {
  const already = await signedInAs(s, account)
  if (already) return s.info(`already signed in as ${account}`)
  const at = await requestLink(s, account)
  await s.shot('link-asked', `${why}: link asked for ${account}`)
  const w = await s.operatorWait({
    account,
    what: `${why}: open the newest sign-in link sent to ${account} (asked at ${at}).`,
    lines: [`Address: ${account}`, `Asked at: ${at}`, 'Open the newest email to that address sent after that time, and hand the link\'s callback to this app (docs/release-gate.md).'],
    timeoutMs: minutes * 60_000,
    done: () => signedInAs(s, account),
  })
  if (w.timedOut) s.stop(`signed in as ${account} within ${minutes} min`, `no sign-in after ${Math.round(w.waitedMs / 1000)} s: the operator step was not done`)
  s.check(`signed in as ${account} after ${Math.round(w.waitedMs / 1000)} s`, true)
}

export async function accounts(s, { account, waitSignin }) {
  // 1. Sign up or sign in.
  const first = await s.user()
  if (first.signedIn) s.info(`the app starts signed in as ${first.email}; signing out first`)
  else await signIn(s, account, waitSignin, 'Sign up or sign in')
  await s.shot('signed-in', 'Signed in')

  // 2. Sign out from the account menu; the form starts over.
  await s.feed()
  await s.click('account-menu')
  if (!(await s.waitFor('account-sign-out', 'visible', 10_000))) s.stop('the account menu offers Sign out', 'no account-sign-out')
  const items = (await s.ids())
  s.info('account menu', Object.keys(items).filter((k) => k.startsWith('account-')))
  await s.shot('account-menu', 'The account menu')
  await s.click('account-sign-out')
  const out = await waitUntil(async () => ((await s.user()).signedIn ? null : true), { timeoutMs: 15_000, everyMs: 500 })
  s.check('Sign out from the account menu signs out', !out.timedOut)
  await s.click('vault-sign-in')
  const fresh = await s.waitFor('signin-email', 'visible', 10_000)
  s.check('Sign in starts over at the email field', fresh && !(await s.ids())['signin-sent'])
  await s.shot('signed-out', 'Signed out: the sign-in form starts over')

  // 3. Two links: the first, then Send again once its countdown ends.
  const older = await requestLink(s, account)
  const samples = []
  const ready = await waitUntil(async () => {
    const b = await s.one('signin-send-again')
    if (!b) return null
    const line = `${b.enabled ? 'enabled' : 'disabled'}: ${b.text}`
    if (samples.at(-1)?.line !== line) samples.push({ at: new Date().toISOString(), line })
    return b.enabled ? true : null
  }, { timeoutMs: 90_000, everyMs: 1000 })
  const counted = samples.filter((x) => /in \d+ s/.test(x.line))
  s.check('Send again counts down while disabled, then turns on', !ready.timedOut && counted.length >= 3 && counted.every((x) => x.line.startsWith('disabled')), [samples[0], ...samples.slice(-3)])
  await s.shot('send-again-ready', 'Send again, ready')
  const marker = await s.marker()
  await s.click('signin-send-again')
  const newer = new Date().toISOString()
  await s.sleep(3000)
  const resent = (await s.since(marker)).network.filter((e) => /\/auth\/v1\/otp$/.test(e.url))
  const after = await s.one('signin-send-again')
  s.check(`Send again asked for a second link at ${newer}, and the countdown starts over`, resent.some((e) => e.status === 200) && /in \d+ s/.test(after?.text ?? '') && !after?.enabled, { otp: resent.map((e) => e.status), button: after?.text })
  await s.shot('send-again-sent', 'Send again: second link asked')

  // 4. The older link first: the expired copy. Then the newer one signs in.
  const old = await s.operatorWait({
    account,
    what: `Old link: open the OLDER of the two links sent to ${account} (asked at ${older}), not the newer one.`,
    lines: [`Address: ${account}`, `Older link asked at: ${older}`, `Newer link asked at: ${newer} (keep it for the next step)`],
    timeoutMs: waitSignin * 60_000,
    done: async () => {
      const f = await s.one('signin-failed')
      if (f?.visible) return f.text
      return (await s.user()).signedIn ? 'signed in' : null
    },
  })
  if (old.timedOut) s.stop('the older link shows the expired copy', 'no answer from the app: the operator step was not done')
  s.check('the older link shows "expired, or a newer one was sent"', EXPIRED.test(old.value) && old.value !== 'signed in', old.value)
  await s.shot('old-link', 'The older link: sign-in did not finish')
  await s.operatorWait({
    account,
    what: `Newer link: now open the NEWER link sent to ${account} (asked at ${newer}).`,
    lines: [`Address: ${account}`, `Newer link asked at: ${newer}`],
    timeoutMs: waitSignin * 60_000,
    done: () => signedInAs(s, account),
  }).then((w) => {
    if (w.timedOut) s.stop('the newer link signs in again', 'no sign-in: the operator step was not done')
    s.check(`the newer link signs in again as ${account}`, true)
  })
  await s.shot('signed-in-again', 'Signed in again with the newer link')
}
