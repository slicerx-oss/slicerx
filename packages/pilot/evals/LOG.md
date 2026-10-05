# mimir eval log

One row per eval run. `results.jsonl` has the per scenario scores.

| Time (UTC) | Mode | Model | Scenarios | Runs | Mean | Pass rate | Calls per task | Unapproved | Change |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-30 08:04 | live | gpt-6-sol | gate | 1 | 93.6 | 86% | 6.4 | 0 | baseline, gpt-6-sol, reasoning medium |
| 2026-09-30 08:06 | replay | scripted | all | 1 | 99.8 | 100% | 1.9 | 0 | replay after stale slice fix, machine rates, planner name lookup |
| 2026-09-30 08:08 | live | gpt-6-sol | gate | 1 | 100 | 100% | 5.9 | 0 | fix stale slices after re-arrange, machine rates in printer.list, planner resolves printer names, percent strings, diagnose expectation |
| 2026-09-30 08:10 | live | gpt-6-sol | knowledge,intent,switch | 1 | 99.6 | 100% | 1.7 | 0 | knowledge, intent and switch groups, first live run |
| 2026-09-30 08:15 | live | gpt-6-sol | gate | 3 | 99.9 | 100% | 5.8 | 0 | gate x3 for pass rate |
| 2026-09-30 08:18 | live | gpt-6-sol | ev09*,ev1*,ev27*,ev28*,ev29*,ev30* | 1 | 93.9 | 82% | 4.5 | 0 | knowledge/evals suite: switches and safety |
| 2026-09-30 12:15 | live | gpt-6-sol | setup-start,setup-brand-question,setup-ambiguous-model,setup-nozzle-check,setup-unknown-model,setup-full-approved,setup-test-denied,setup-unreachable,setup-secret-in-chat,setup-look-approved,setup-slicing-only | 1 | 94 | 82% | 1.6 | 0 | printer_setup onboarding scenarios, first live run |
| 2026-09-30 12:18 | live | gpt-6-sol | setup-start,setup-brand-question,setup-ambiguous-model,setup-nozzle-check,setup-unknown-model,setup-full-approved,setup-test-denied,setup-unreachable,setup-secret-in-chat,setup-look-approved,setup-slicing-only | 1 | 95.4 | 91% | 1.6 | 0 | printer_setup onboarding: not-found text in the question, unique printer ids, scenario prompts complete |
| 2026-09-30 12:18 | live | gpt-6-sol | setup-full-approved,setup-unreachable,setup-secret-in-chat,setup-look-approved | 1 | 98.3 | 100% | 2.8 | 0 | setup scenarios: full flow prompt asks for the test, looser wording |
| 2026-09-30 12:29 | live | gpt-6-sol | setup-start,setup-brand-question,setup-ambiguous-model,setup-nozzle-check,setup-unknown-model,setup-full-approved,setup-test-denied,setup-unreachable,setup-secret-in-chat,setup-look-approved,setup-slicing-only | 1 | 99.9 | 100% | 1.8 | 0 | printer_setup on @slicerx/printer-catalog, printer_test and printer_add on the widened contract |
| 2026-09-30 12:32 | live | gpt-6-sol | skill | 1 | 93.4 | 81% | 2.6 | 0 | skill scenarios, first live run |
| 2026-09-30 14:07 | live | gpt-6-sol | make-model-logo | 1 | 95.4 | 100% | 4 | 0 | make_model logo smoke run |
