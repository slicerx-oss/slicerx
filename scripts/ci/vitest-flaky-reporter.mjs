// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A vitest reporter for runs with --retry. It names each test that failed and then passed on a retry, so a retry
// cannot hide a flaky test: a GitHub annotation, and the name appended to the file in SX_FLAKY_OUT, which
// `flaky-check.sh retried` checks against scripts/ci/flaky.d. It also writes each test that failed on every try to the
// file in SX_FAILED_OUT, for `flaky-check.sh failed`, which lets the run pass only when each of them is quarantined.
// An error outside any test (a file that did not load, a suite or hook error, an unhandled error, an interrupted run)
// is written as a line starting with "!", which no list can excuse. See "Flaky tests" in scripts/ci/README.md.
//   pnpm exec vitest run --retry=1 --reporter=default --reporter=<this file> (scripts/ci/pr-test.sh does it per package)
import { appendFileSync } from 'node:fs'
import { relative, sep } from 'node:path'

const fileOf = (testModule, cwd) => relative(cwd, testModule.moduleId).split(sep).join('/')
const firstLine = (error) => String(error?.message ?? error ?? 'unknown error').split('\n')[0].slice(0, 200)

/**
 * The failures of a finished run, one line each: "<file> > <suite> > <test>" for a test that failed on every try, and
 * "!<what>" for an error that no list can excuse.
 */
export function failures(testModules, unhandledErrors = [], reason = 'failed', cwd = process.cwd()) {
  const out = []
  for (const testModule of testModules) {
    const file = fileOf(testModule, cwd)
    const before = out.length
    for (const error of testModule.errors()) out.push(`!${file}: ${firstLine(error)}`)
    for (const suite of testModule.children.allSuites()) {
      for (const error of suite.errors()) out.push(`!${file} > ${suite.fullName}: ${firstLine(error)}`)
    }
    for (const testCase of testModule.children.allTests('failed')) out.push(`${file} > ${testCase.fullName}`)
    if (out.length === before && testModule.state() === 'failed') out.push(`!${file}: failed without a failed test`)
  }
  for (const error of unhandledErrors) out.push(`!unhandled error: ${firstLine(error)}`)
  if (reason === 'interrupted') out.push('!the run was interrupted')
  return out
}

export default class FlakyReporter {
  #flaky = []

  onTestCaseResult(testCase) {
    const diagnostic = testCase.diagnostic()
    if (testCase.result().state === 'passed' && diagnostic && diagnostic.retryCount > 0) {
      this.#flaky.push(`${fileOf(testCase.module, process.cwd())} > ${testCase.fullName}`)
    }
  }

  onTestRunEnd(testModules = [], unhandledErrors = [], reason = 'failed') {
    const file = process.env.SX_FLAKY_OUT
    for (const name of this.#flaky) {
      console.log(`::warning title=Flaky test (passed on retry)::${name}`)
      if (file) appendFileSync(file, `${name}\n`)
    }
    const failedOut = process.env.SX_FAILED_OUT
    const failed = failures(testModules, unhandledErrors, reason)
    if (failedOut && failed.length) appendFileSync(failedOut, failed.map((line) => `${line}\n`).join(''))
  }
}
