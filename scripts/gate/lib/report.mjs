// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The gate's HTML report: one page with a table of every scenario on every platform, then each run's build, its
// PASS and FAIL lines with their evidence, every screenshot, and the console, network and toast excerpts. Every text
// is escaped and masked again here, so nothing that looks like a code or token reaches the page.
import { mask } from './util.mjs'

const esc = (t) => mask(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** A run's overall result: FAIL when any scenario failed, PASS when every one that ran passed. */
export function runStatus(run) {
  const st = run.scenarios.map((s) => s.status)
  return st.includes('FAIL') ? 'FAIL' : st.includes('PASS') ? 'PASS' : 'SKIP'
}

const badge = (st) => `<span class="b b-${esc(String(st ?? 'none').toLowerCase())}">${esc(st ?? 'not run')}</span>`
const pre = (title, lines) => (lines?.length ? `<details><summary>${esc(title)} (${lines.length})</summary><pre>${lines.map(esc).join('\n')}</pre></details>` : '')

function stepRow(step) {
  const st = step.ok === true ? 'PASS' : step.ok === false ? 'FAIL' : 'info'
  return `<tr><td>${badge(st)}</td><td>${esc(step.name)}${step.detail ? `<div class="d">${esc(step.detail)}</div>` : ''}</td></tr>`
}

function scenarioBlock(run, sc, prefix) {
  const shots = sc.shots.map((s) => `<figure><a href="${esc(prefix + s.file)}"><img src="${esc(prefix + s.file)}" alt="${esc(s.caption)}" loading="lazy"></a><figcaption>${esc(s.caption)}</figcaption></figure>`).join('')
  return `<section class="sc" id="${esc(`${run.platform}-${sc.id}`)}">
<h3>${badge(sc.status)} ${esc(sc.id)}. ${esc(sc.title)}</h3>
<p class="m">${esc(sc.startedAt ?? '')} to ${esc(sc.endedAt ?? '')}</p>
<table class="steps">${sc.steps.map(stepRow).join('')}</table>
${shots ? `<div class="shots">${shots}</div>` : ''}
${pre('Console (errors, warnings, refusals)', sc.console)}${pre('Backend calls and failed loads', sc.network)}${pre('Toasts', sc.toasts)}
</section>`
}

/**
 * The page for one or more runs (one per platform). `prefix(run)` is where that run's screenshots sit relative to the
 * page ('' when the page sits in the run's own folder).
 */
export function renderReport(runs, { prefix = () => '' } = {}) {
  const ids = [...new Map(runs.flatMap((r) => r.scenarios.map((s) => [s.id, s.title]))).entries()]
  const overall = runs.some((r) => runStatus(r) === 'FAIL') ? 'FAIL' : runs.every((r) => runStatus(r) === 'PASS') ? 'PASS' : 'INCOMPLETE'
  const commits = [...new Set(runs.map((r) => r.commit).filter(Boolean))]
  const head = `<tr><th>Scenario</th>${runs.map((r) => `<th>${esc(r.platform)}</th>`).join('')}</tr>`
  const rows = ids
    .map(([id, title]) => `<tr><td>${esc(id)}. ${esc(title)}</td>${runs.map((r) => {
      const sc = r.scenarios.find((s) => s.id === id)
      return `<td>${sc ? `<a href="#${esc(`${r.platform}-${id}`)}">${badge(sc.status)}</a>` : badge(null)}</td>`
    }).join('')}</tr>`)
    .join('')
  const runBlocks = runs
    .map((r) => `<section class="run">
<h2>${badge(runStatus(r))} ${esc(r.platform)}</h2>
<table class="kv">
<tr><th>Commit</th><td><code>${esc(r.commit ?? 'unknown')}</code></td></tr>
<tr><th>Build</th><td><code>${esc(r.build?.file ?? '')}</code> ${esc(r.build?.version ?? '')}, sha256 <code>${esc(r.build?.sha256 ?? '')}</code>${r.build?.kind ? `, ${esc(r.build.kind)}` : ''}</td></tr>
<tr><th>Account</th><td>${esc(r.account ?? 'none (signed out only)')}</td></tr>
<tr><th>Host</th><td>${esc(r.host ?? '')}</td></tr>
<tr><th>Run</th><td>${esc(r.startedAt)} to ${esc(r.endedAt ?? '')}</td></tr>
${r.notes?.length ? `<tr><th>Notes</th><td>${r.notes.map(esc).join('<br>')}</td></tr>` : ''}
</table>
${r.scenarios.map((sc) => scenarioBlock(r, sc, prefix(r))).join('\n')}
</section>`)
    .join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Release gate ${esc(commits.map((c) => c.slice(0, 10)).join(', '))}</title>
<style>
:root{--bg:#fff;--fg:#1d1f24;--dim:#5d6470;--line:#d9dde3;--pass:#137333;--fail:#b3261e;--info:#5d6470;--chip:#f2f4f7}
@media (prefers-color-scheme:dark){:root{--bg:#16181d;--fg:#e6e8ec;--dim:#9aa1ad;--line:#2c313a;--pass:#5cc58a;--fail:#ff8a80;--info:#9aa1ad;--chip:#22262e}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto}h1{font-size:22px}h2{margin-top:32px;border-top:1px solid var(--line);padding-top:16px}h3{font-size:16px;margin:24px 0 4px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.kv th{width:110px;color:var(--dim);font-weight:500}.m{color:var(--dim);margin:0 0 8px;font-size:12px}
.d{color:var(--dim);font-size:12px;white-space:pre-wrap;word-break:break-word}
.b{display:inline-block;min-width:44px;text-align:center;padding:1px 6px;border-radius:4px;font-size:12px;font-weight:600;background:var(--chip)}
.b-pass{color:var(--pass)}.b-fail{color:var(--fail)}.b-info,.b-skip,.b-none,.b-incomplete{color:var(--info)}
.steps td:first-child{width:60px}.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin:12px 0}
figure{margin:0}figure img{width:100%;border:1px solid var(--line);border-radius:4px}figcaption{font-size:12px;color:var(--dim)}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--chip);padding:8px;border-radius:4px;overflow-x:auto}
summary{cursor:pointer;color:var(--dim);margin:6px 0}code{font-size:12px;word-break:break-all}
</style></head><body><main>
<h1>${badge(overall)} Release gate</h1>
<p class="m">Commit ${esc(commits.join(', ') || 'unknown')}. Generated ${esc(new Date().toISOString())}.</p>
<table class="sum">${head}${rows}</table>
${runBlocks}
</main></body></html>
`
}
