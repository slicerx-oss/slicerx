// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Gets a fresh profile through first run, the way a person who wants the defaults does: accept the agreement, Skip,
// use defaults, and Leave when setup asks whether to, then open the right pane, where the objects list is (it starts shut).
// Shared by the bridge scripts (e2e.mjs, frames.mjs) so they agree
// on the steps and the test ids (docs/test-ids.md).

/**
 * Clicks through first run until the objects list shows with no setup dialog over it. `testids` returns the test ids on
 * screen; `click` clicks one (a miss is fine: the next round looks again). Resolves to whether the plate came up, and the
 * test ids seen last, for a report when it did not.
 */
export async function finishFirstRun({ testids, click, sleep, tries = 120 }) {
  let ids = {}
  let paneOpened = false
  for (let i = 0; i < tries; i++) {
    ids = (await testids().catch(() => ({}))) ?? {}
    if (ids['objects-list'] && !ids['setup-leave-dialog']) return { done: true, ids }
    if (ids['setup-leave']) await click('setup-leave')
    else if (ids['agreement-check']) {
      await click('agreement-check')
      await click('agreement-accept')
    } else if (ids['setup-skip-all']) await click('setup-skip-all')
    // The right pane never opens by itself (docs/direction.md): open it once, the way a person pulls it out. Its edge
    // tab toggles, so it is pressed only once.
    else if (!ids['setup'] && ids['edge-tab-right'] && !paneOpened) {
      paneOpened = true
      await click('edge-tab-right')
    }
    await sleep(500)
  }
  return { done: false, ids }
}
