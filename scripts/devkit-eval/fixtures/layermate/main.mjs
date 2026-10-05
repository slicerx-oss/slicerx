// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// LayerMate (stand-in): a small host app for a 3D print library. It lists the models in ./models and has
// an "Open in slicer" button that launches the slicer with the model. Run it with `node main.mjs` and
// open http://127.0.0.1:4173.
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configuredCommand, openInEdition } from './open-in-edition.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const models = () => readdirSync(join(here, 'models')).filter((f) => /\.(3mf|stl|obj|step|stp)$/i.test(f))

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/api/models') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(models()))
  } else if (url.pathname === '/api/open' && req.method === 'POST') {
    const name = url.searchParams.get('model') ?? ''
    if (!models().includes(name)) {
      res.statusCode = 404
      res.end('no such model')
      return
    }
    try {
      openInEdition(configuredCommand(), join(here, 'models', name))
      res.end('ok')
    } catch (e) {
      res.statusCode = 500
      res.end(String(e.message ?? e))
    }
  } else {
    res.setHeader('content-type', 'text/html')
    res.end(readFileSync(join(here, 'index.html')))
  }
}).listen(4173, '127.0.0.1', () => console.log('LayerMate (stand-in) on http://127.0.0.1:4173'))
