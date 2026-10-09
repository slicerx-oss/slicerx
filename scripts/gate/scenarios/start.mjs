// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Start of every run: the app is up, first run is done (the pre-alpha agreement, an update sheet answered Later), and
// the printer is a Bambu Lab A1 with a 0.4 mm nozzle and no connection, added by hand through setup (first run, or
// Printers > Add printer). No network scan runs and nothing reaches a printer.
import { PRINTER } from '../lib/starters.mjs'
import { waitUntil } from '../lib/util.mjs'

/** Waits for the app to come up and render its first controls. */
export async function appUp(s) {
  const health = await waitUntil(async () => {
    const r = await s.call('app_health')
    return !r.error && r.data?.appReady ? r.data : null
  }, { timeoutMs: 90_000, everyMs: 500 })
  if (health.timedOut) s.stop('the app comes up (app_health appReady)', 'not ready after 90 s')
  s.check('the app comes up', true, { app: health.value.app, version: health.value.version, platform: health.value.platform, pid: health.value.pid })
  const drawn = await waitUntil(async () => (Object.keys(await s.ids()).length ? true : null), { timeoutMs: 60_000, everyMs: 500 })
  if (drawn.timedOut) s.stop('the first frame has test ids', 'none after 60 s')
  return health.value
}

/** True when the app's printer is the gate's A1 with a 0.4 mm nozzle. */
export function isGatePrinter(st) {
  return st.printer?.model === PRINTER.name && Number(st.printer?.nozzleMm) === PRINTER.nozzleMm && !st.printer?.noPrinter
}

/** Goes through setup's hand-made printer form: search, the A1, no connection, Continue, then the rest of setup. */
async function setupByHand(s) {
  let picked = false
  let connection = false
  let saved = false
  for (let i = 0; i < 80; i++) {
    const ids = await s.ids()
    if (!ids['setup']) return saved
    const step = (await s.one('setup'))?.data?.step
    if (ids['setup-leave-dialog']) {
      await s.click('setup-stay')
    } else if (step === 'printer' && !saved) {
      if (ids['setup-printer-by-hand'] && !ids['setup-printer-search']) {
        // The network scan view: go to the hand-made form; the scan waits for its own button and never starts here.
        await s.click('setup-printer-by-hand')
      } else if (!picked && ids['setup-printer-search']) {
        await s.fill('setup-printer-search', PRINTER.search)
        if (!(await s.waitFor('setup-printer-hit', 'visible', 10_000))) s.stop(`setup finds the ${PRINTER.name}`, 'no search results')
        const hits = (await s.element('setup-printer-hit')).filter((h) => h.visible)
        const at = hits.findIndex((h) => h.data?.model === PRINTER.model)
        if (at < 0) s.stop(`setup lists the ${PRINTER.model} model`, hits.map((h) => h.data?.model))
        await s.click('setup-printer-hit', at)
        picked = true
      } else if (picked && !connection) {
        if (!(await s.waitFor('setup-connection-export', 'enabled', 10_000))) s.stop('setup offers No connection (export files)', 'the choice did not appear')
        await s.click('setup-connection-export')
        connection = true
      } else if (connection) {
        if (!(await s.waitFor('setup-next', 'enabled', 10_000))) {
          const err = await s.one('setup-printer-error')
          s.stop('setup saves the printer', err?.text ?? 'Continue stayed disabled')
        }
        await s.click('setup-next')
        saved = await waitUntil(async () => ((await s.one('setup'))?.data?.step !== 'printer' || !(await s.ids())['setup'] ? true : null), { timeoutMs: 15_000, everyMs: 300 }).then((r) => !r.timedOut)
        if (!saved) {
          const err = await s.one('setup-printer-error')
          s.stop('setup saves the printer', err?.text ?? 'still on the printer step')
        }
      }
    } else if (step === 'mimir' && ids['setup-skip']) {
      await s.click('setup-skip')
    } else if (ids['setup-next']) {
      // The slicer's look and anything after it: the main button until setup closes.
      await s.click('setup-next')
    }
    await s.sleep(400)
  }
  s.stop('setup closes', 'still open after 80 steps')
}

/** First run and the printer. */
export async function start(s) {
  await appUp(s)
  let setupDone = false
  for (let i = 0; i < 60; i++) {
    const ids = await s.ids()
    if (ids['agreement-check']) {
      await s.click('agreement-check')
      await s.click('agreement-accept')
      s.info('accepted the pre-alpha agreement (stored on this test profile only)')
    } else if (ids['update-sheet']) {
      if (ids['update-later']) {
        await s.click('update-later')
        s.info('an update sheet showed at launch; answered Later')
      } else s.stop('no required update blocks the app', (await s.one('update-body'))?.text)
    } else if (ids['projects-dialog'] && ids['projects-close']) {
      // Restore unsaved work? on a reused profile: Close keeps the copy; the gate never discards it.
      await s.click('projects-close')
      s.info('Restore unsaved work? showed at launch; closed it, keeping the copy')
    } else if (ids['setup'] && !setupDone) {
      setupDone = await setupByHand(s)
      s.check(`added the ${PRINTER.name} by hand in first-run setup, no connection`, setupDone)
    } else if (ids['objects-list'] || ids['tab-prepare']) break
    await s.sleep(500)
  }
  let st = await s.state()
  if (!isGatePrinter(st)) {
    // A profile that has been through setup before: add the printer from Printers.
    await s.click('tab-printers')
    if (!(await s.waitFor('printers-add', 'visible', 15_000))) s.stop('Printers offers Add printer', 'no printers-add control')
    await s.click('printers-add')
    if (!(await s.waitFor('setup', 'visible', 15_000))) s.stop('Add printer opens setup', 'setup did not open')
    s.check(`added the ${PRINTER.name} by hand from Printers, no connection`, await setupByHand(s))
    st = await s.state()
  }
  // Slice is tab-prepare in every edition.
  await s.click('tab-prepare')
  const slot = st.filament?.[0]
  s.check(`the printer is the ${PRINTER.name}, ${PRINTER.nozzleMm} mm`, isGatePrinter(st), st.printer)
  s.check(`filament 1 is ${PRINTER.filament}`, slot?.type === PRINTER.filament, slot)
  await s.shot('ready', `Ready: ${st.printer?.vendor ?? ''} ${st.printer?.model ?? ''}, ${st.printer?.nozzleMm ?? '?'} mm, ${slot?.type ?? '?'}`)
  await modelHidesTheSlice(s)
}

// The slice's controls, which only Slice shows: the legend's Color by menu and its filament swatches.
const SLICE_ONLY = ['legend-color-by', 'legend-slot']

/** Model never shows the slice: after a slice, Model has no legend or swatches, and Slice shows them again. */
async function modelHidesTheSlice(s) {
  if (!(await s.ids())['tab-model']) {
    s.info('no Model tab in this edition; the Model and Slice check is skipped')
    return
  }
  const sl = await s.call('app_slice', { timeoutMs: 600_000 })
  if (sl.error || sl.data?.status !== 'done') {
    s.check('the default plate slices before the Model and Slice check', false, sl.error ?? sl.data)
    return
  }
  const shown = async () => Object.keys(await s.ids()).filter((id) => SLICE_ONLY.includes(id))
  const until = async (want) => {
    for (let i = 0; i < 20; i++) {
      const ids = await shown()
      if (want(ids)) return ids
      await s.sleep(250)
    }
    return shown()
  }
  s.check('Slice shows the legend after a slice', (await until((ids) => ids.length > 0)).length > 0)
  await s.click('tab-model')
  const inModel = await until((ids) => ids.length === 0)
  s.check('Model shows no legend or slice swatches after a slice', inModel.length === 0, inModel)
  await s.shot('model-after-slice', 'Model after a slice: no toolpaths, layer slider or legend')
  await s.click('tab-prepare')
  s.check('Slice shows the legend again', (await until((ids) => ids.length > 0)).length > 0)
}
