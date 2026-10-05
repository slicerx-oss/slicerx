#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scores a finished run again with the current score.mjs:  node scripts/devkit-eval/rescore.mjs <run folder>
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PERSONAS } from './personas.mjs'
import { score } from './score.mjs'

const dir = resolve(process.argv[2] ?? '.')
const prev = JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8'))
const result = score({ app: join(dir, 'app'), clone: prev.clone ?? null, turns: prev.turns, transcript: join(dir, 'transcript.jsonl'), persona: PERSONAS[prev.persona], spawnSync })
writeFileSync(join(dir, 'score.json'), `${JSON.stringify({ ...prev, ...result, turns: prev.turns }, null, 2)}\n`)
console.log(`${result.points} of ${result.max}`)
for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'MISS'} ${c.name}${c.note ? `: ${c.note}` : ''}`)
