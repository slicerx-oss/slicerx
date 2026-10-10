// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A vitest reporter for runs with --retry: it names each test that failed and then passed on a retry, so a retry
// cannot hide a flaky test. It prints a GitHub annotation and appends the test's name to the file in SX_FLAKY_OUT,
// which `flaky-check.sh retried` then checks against scripts/ci/flaky.d. See "Flaky tests" in scripts/ci/README.md.
//   pnpm exec vitest run --retry=1 --reporter=default --reporter=<this file> (scripts/ci/pr-test.sh does it per package)
import { appendFileSync } from 'node:fs'
import { relative, sep } from 'node:path'

export default class FlakyReporter {
  #flaky = []

  onTestCaseResult(testCase) {
    const diagnostic = testCase.diagnostic()
    if (testCase.result().state === 'passed' && diagnostic && diagnostic.retryCount > 0) {
      const file = relative(process.cwd(), testCase.module.moduleId).split(sep).join('/')
      this.#flaky.push(`${file} > ${testCase.fullName}`)
    }
  }

  onTestRunEnd() {
    const file = process.env.SX_FLAKY_OUT
    for (const name of this.#flaky) {
      console.log(`::warning title=Flaky test (passed on retry)::${name}`)
      if (file) appendFileSync(file, `${name}\n`)
    }
  }
}
