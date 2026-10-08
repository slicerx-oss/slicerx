// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What every gate scenario works with: the bridge's tools as small helpers, PASS and FAIL lines with their evidence,
// screenshots, and the console, network and toast excerpts of the scenario. Everything that reaches the report or the
// terminal goes through mask() first.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mask, sleep, slug, waitUntil } from './util.mjs'

/** Raised to stop a scenario at a step that the rest depends on. */
export class Stop extends Error {}

export function createContext({ bridge, out, opts, tokenFile, log }) {
  const shots = join(out, 'shots')
  mkdirSync(shots, { recursive: true })
  const call = bridge.call

  /** One scenario's record; `run` gives the scenario its helpers and catches a Stop. */
  async function scenario(id, title, body) {
    const rec = { id, title, platform: opts.platform, startedAt: new Date().toISOString(), steps: [], shots: [], console: [], network: [], toasts: [] }
    const marker = (await call('app_state')).data?.marker ?? 0
    log(`\n== ${id}. ${title}`)
    const step = (name, ok, detail) => {
      const d = detail === undefined ? undefined : mask(typeof detail === 'string' ? detail : JSON.stringify(detail))
      rec.steps.push({ name: mask(name), ok, ...(d === undefined ? {} : { detail: d }) })
      log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'info'} ${mask(name)}${d ? `: ${d.length > 400 ? `${d.slice(0, 400)}...` : d}` : ''}`)
      return ok
    }
    const s = {
      ...helpers,
      step,
      check: (name, ok, detail) => step(name, Boolean(ok), detail),
      info: (name, detail) => step(name, null, detail),
      /** Records a failed step and stops the scenario. */
      stop: (name, detail) => {
        step(name, false, detail)
        throw new Stop(name)
      },
      async shot(name, caption) {
        const file = `${id}-${String(rec.shots.length + 1).padStart(2, '0')}-${slug(name)}.png`
        const r = await call('app_screenshot', { path: join(shots, file) })
        if (r.error) step(`screenshot ${name}`, null, r.error)
        else rec.shots.push({ file: `shots/${file}`, caption: mask(caption ?? name) })
        return r
      },
    }
    try {
      await body(s)
    } catch (e) {
      if (!(e instanceof Stop)) step('scenario stopped', false, e instanceof Error ? e.stack ?? e.message : String(e))
    }
    // The excerpts: what went wrong in the console, the backend calls, and the toasts, since the scenario began.
    const con = (await call('app_console', { since: marker, limit: 1000 })).data?.entries ?? []
    rec.console = con.filter((e) => ['error', 'pageerror', 'csp', 'warn'].includes(e.level)).slice(-40).map((e) => mask(`${e.at} [${e.level}] ${e.text}`))
    const net = (await call('app_network', { since: marker, limit: 1000 })).data?.entries ?? []
    rec.network = net
      .filter((e) => !e.ok || /\/(auth|rest|storage|functions)\/v1\//.test(e.url))
      .slice(-60)
      .map((e) => mask(`${e.at} ${e.method} ${e.status ?? (e.error ? 'failed' : '?')} ${e.url}${e.resource ? ` (${e.resource})` : ''}`))
    const toasts = (await call('app_toasts', { since: marker, limit: 200 })).data?.entries ?? []
    rec.toasts = toasts.map((t) => mask(`${t.at} [${t.tone}] ${t.text}`))
    rec.endedAt = new Date().toISOString()
    rec.status = rec.steps.some((x) => x.ok === false) ? 'FAIL' : rec.steps.some((x) => x.ok === true) ? 'PASS' : 'SKIP'
    log(`== ${id}. ${title}: ${rec.status}`)
    return rec
  }

  const helpers = {
    call,
    opts,
    async state() {
      const r = await call('app_state')
      if (r.error) throw new Error(`app_state: ${r.error}`)
      return r.data
    },
    async ids() {
      return (await call('app_testids')).data ?? {}
    },
    async element(testid) {
      return (await call('app_element', { testid })).data?.matches ?? []
    },
    /** The first match on screen, or the first one. */
    async one(testid) {
      const m = await helpers.element(testid)
      return m.find((x) => x.visible) ?? m[0] ?? null
    },
    async click(testid, index) {
      const r = await call('app_click', { testid, ...(index !== undefined ? { index } : {}) })
      if (r.error) throw new Error(`click ${testid}: ${r.error}`)
      return r.data
    },
    async fill(testid, value) {
      const r = await call('app_fill', { testid, value })
      if (r.error) throw new Error(`fill ${testid}: ${r.error}`)
    },
    /** Waits for a control; true when it got there, false when the time ran out. */
    async waitFor(testid, state = 'visible', timeoutMs = 15_000, text) {
      const r = await call('app_wait_for', { testid, state, timeoutMs, ...(text ? { text } : {}) })
      return !r.error
    },
    async user() {
      return (await call('app_user')).data ?? { signedIn: false }
    },
    /** Clears the plate, answering Don't save when the app asks (on the gate's own test profile only). */
    async clearPlate() {
      const r = await call('app_clear_plate')
      if (r.error) throw new Error(`clear the plate: ${r.error}`)
      if (r.data?.asking) {
        await helpers.click('unsaved-discard')
        await waitUntil(async () => ((await helpers.state()).plate.objects.length === 0 ? true : null), { timeoutMs: 15_000, everyMs: 300 })
      }
      return (await helpers.state()).plate.objects.length === 0
    },
    async feed() {
      await helpers.click('tab-feed')
      await helpers.waitFor('vault-feed', 'visible', 15_000)
    },
    /** Network entries and console lines since a marker. */
    async since(marker) {
      const [net, con] = await Promise.all([call('app_network', { since: marker, limit: 1000 }), call('app_console', { since: marker, limit: 1000 })])
      return { network: net.data?.entries ?? [], console: con.data?.entries ?? [] }
    },
    async marker() {
      return (await call('app_state')).data?.marker ?? 0
    },
    /**
     * The operator hook: prints which address a sign-in link was asked for and when, then waits (bounded) until
     * `done()` answers. While it waits, operator.json in the report folder says the same for an operator's script.
     */
    async operatorWait({ account, lines, done, timeoutMs, what }) {
      const file = join(out, 'operator.json')
      const until = new Date(Date.now() + timeoutMs).toISOString()
      writeFileSync(file, `${JSON.stringify({ account, what, lines, tokenFile, waitingUntil: until }, null, 2)}\n`)
      const bar = '-'.repeat(78)
      log(`\n${bar}\nOPERATOR: ${what}\n${lines.map((l) => `  ${l}`).join('\n')}\n  The app's connection file (for app_auth_callback): ${tokenFile}\n  Waiting until ${until} (${Math.round(timeoutMs / 60_000)} min).\n${bar}`)
      let lastNote = 0
      const r = await waitUntil(done, {
        timeoutMs,
        everyMs: 3000,
        onWait: (ms) => {
          if (ms - lastNote >= 60_000) {
            lastNote = ms
            log(`  still waiting for the operator (${Math.round(ms / 60_000)} of ${Math.round(timeoutMs / 60_000)} min): ${what}`)
          }
        },
      })
      rmSync(file, { force: true })
      return r
    },
    sleep,
  }
  return { scenario, helpers }
}
