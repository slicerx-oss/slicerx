#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads a Playwright JSON report (reporter json) and writes, one name per line, the tests that passed only on a
// retry to <retried file> and the tests that failed on every try to <failed file>, for flaky-check.sh (see
// "Flaky tests" in scripts/ci/README.md). A name is "<spec file> > <describe> > <title> [<project>]", so a
// flaky.txt or quarantine.txt entry that is a Playwright title matches it.
//
//   node scripts/ci/playwright-results.mjs <report.json> <retried file> <failed file>
//
// Exits 1 when the report is missing or unreadable, or the run had errors outside any test (a web server that did
// not start, a spec that did not load): those are real failures that no list can excuse.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The retried and failed test names in a parsed report, and the run's own errors. */
export function results(report) {
  const retried = []
  const failed = []
  const walk = (suite, titles) => {
    // The top suite of a file is titled with the file; only describe blocks add to the name.
    const path = suite.title && suite.title !== suite.file ? [...titles, suite.title] : titles
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const name = `${spec.file} > ${[...path, spec.title].join(' > ')} [${test.projectName}]`
        if (test.status === 'flaky') retried.push(name)
        else if (test.status === 'unexpected') failed.push(name)
      }
    }
    for (const child of suite.suites ?? []) walk(child, path)
  }
  for (const suite of report.suites ?? []) walk(suite, [])
  const errors = (report.errors ?? []).map((e) => (e.message ?? String(e)).split('\n')[0])
  return { retried, failed, errors }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, retriedOut, failedOut] = process.argv.slice(2)
  if (!file || !retriedOut || !failedOut) {
    console.error('usage: playwright-results.mjs <report.json> <retried file> <failed file>')
    process.exit(2)
  }
  let report
  try {
    report = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`playwright-results: no readable report at ${file}: ${e.message}`)
    process.exit(1)
  }
  const { retried, failed, errors } = results(report)
  const lines = (names) => (names.length ? `${names.join('\n')}\n` : '')
  writeFileSync(retriedOut, lines(retried))
  writeFileSync(failedOut, lines(failed))
  const s = report.stats ?? {}
  console.log(`playwright-results: ${s.expected ?? 0} passed, ${retried.length} passed only on a retry, ${failed.length} failed, ${s.skipped ?? 0} skipped`)
  for (const e of errors) console.error(`playwright-results: run error: ${e}`)
  process.exit(errors.length ? 1 : 0)
}
