// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Set up local AI: what this computer has, the model that fits, the local model app that runs it,
// a confirmed download, a tool call and speed check, then mimir switches to it. Nothing installs
// without a click, and nothing leaves this computer. The download and check run as a job outside
// the card (local-ai-job.ts), so leaving the screen does not stop them.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Chip, Icon, Select } from '@slicerx/ui'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useEdition } from '../edition'
import { openLink } from '../lib/links'
import { allowedModels, detectRunners, formatGb, installedName, licenseOf, nextModelUp, OLLAMA_DOWNLOAD, recommend, shortGpuName, useLocalAi, type Hardware, type LocalModel, type Runner } from './local-ai'
import { cancelLocalAi, resetLocalAi, startLocalAi, useLocalAiJob } from './local-ai-job'
import './connect.css'

function gbText(mb: number | null | undefined): string {
  return mb ? `${Math.round(mb / 1024)} GB` : 'unknown'
}

function Facts({ hw }: { hw: Hardware }) {
  return (
    <dl className="la-facts">
      <div>
        <dt>Graphics</dt>
        <dd>{hw.gpu ? `${shortGpuName(hw.gpu.name)}${hw.gpu.vramMb ? `, ${gbText(hw.gpu.vramMb)}${hw.gpu.unified ? ' for models' : ''}` : ''}` : hw.source === 'browser' ? 'not visible in the browser' : 'none found'}</dd>
      </div>
      <div>
        <dt>Memory</dt>
        <dd>{hw.ramMb ? `${hw.source === 'browser' ? 'at least ' : ''}${gbText(hw.ramMb)}` : 'unknown'}</dd>
      </div>
      <div>
        <dt>Processor</dt>
        <dd>{hw.cores ? `${hw.cores} cores` : 'unknown'}</dd>
      </div>
    </dl>
  )
}

/**
 * The whole helper. `background` is for first-run setup: the download keeps going after the
 * screen closes, and the card says so.
 */
export function LocalAiCard({ background = false }: { background?: boolean }) {
  // An edition can leave the helper out (edition config features.localAi).
  return useEdition().features.localAi ? <Helper background={background} /> : null
}

function Helper({ background }: { background: boolean }) {
  const edition = useEdition()
  const local = useLocalAi()
  const job = useLocalAiJob()
  const models = useMemo(() => allowedModels(edition.ai.allowedLocalModels), [edition.ai.allowedLocalModels])
  const [hw, setHw] = useState<Hardware | null>(null)
  const [runners, setRunners] = useState<Runner[] | null>(null)
  const [chosen, setChosen] = useState<LocalModel | null>(null)
  const [picked, setPicked] = useState('')
  const [confirm, setConfirm] = useState(false)

  const detect = useCallback(async () => {
    setRunners(null)
    setRunners(await detectRunners(local.net))
  }, [local])

  useEffect(() => {
    let live = true
    local.hardware().then(
      (h) => live && setHw(h),
      () => live && setHw({ gpu: null, ramMb: null, cores: null, source: 'desktop' }),
    )
    void detect()
    return () => {
      live = false
    }
  }, [local, detect])

  const rec = hw ? recommend(hw, models) : null
  const model = chosen ?? (rec?.kind === 'model' ? rec.model : null)
  const runner = runners?.[0] ?? null
  const have = runner && model ? installedName(runner, model) : null
  // LM Studio downloads in its own window, and the browser cannot size a model: pick from what the runner has.
  const choose = runner && !have && (runner.kind === 'lmstudio' || !model) && runner.models.length > 0
  const target = have ?? (choose ? picked || runner?.models[0] || '' : '')
  const license = model ? licenseOf(model) : null
  const busy = job.at === 'pulling' || job.at === 'checking'
  const next = model && hw ? nextModelUp(model, hw, models) : null
  const pct = job.at === 'pulling' && job.progress?.totalBytes ? Math.min(100, Math.floor((job.progress.completedBytes / job.progress.totalBytes) * 100)) : 0

  const test = (name: string) => {
    if (runner) void startLocalAi(local.net, runner, { tag: name, name: model && name === have ? model.name : name, pull: false })
  }
  const download = () => {
    setConfirm(false)
    if (runner && model) void startLocalAi(local.net, runner, { tag: model.ollama, name: model.name, pull: true }).then(() => detect())
  }

  if (!hw) {
    return (
      <div className="la">
        <Head />
        <p className="la-note">Reading this computer&apos;s hardware.</p>
      </div>
    )
  }

  return (
    <div className="la">
      <Head />
      <Facts hw={hw} />
      {rec?.kind === 'too-weak' || rec?.kind === 'unknown' ? <p className="la-note">{rec.reason}</p> : null}
      {model && rec?.kind === 'model' ? (
        <div className="la-rec">
          <b>{model.name}</b>
          <p>{chosen ? `Next up from ${rec.model.name}.` : rec.reason}</p>
          <div className="la-chips">
            <Chip>{formatGb(model.downloadGb)} download</Chip>
            <Chip tone={model.tools === 'basic' ? 'orange' : 'green'}>Tool use: {model.tools}</Chip>
            {model.provisional ? <Chip tone="neutral">Estimated figures</Chip> : null}
          </div>
          {license ? (
            <p className="la-license">
              <Icon name="license" size={16} /> {license.name}. {license.plain}
            </p>
          ) : null}
        </div>
      ) : null}

      {rec?.kind !== 'too-weak' ? (
        runners === null ? (
          <p className="la-note">Looking for Ollama or LM Studio on this computer.</p>
        ) : runner ? (
          <p className="la-found">
            <Icon name="check" size={16} /> {runner.label} is running.
          </p>
        ) : (
          <div className="la-act">
            <span className="la-what">A free model app runs the model. Ollama is the simplest; its installer opens in your browser.</span>
            <Button icon="external" onClick={() => void openLink(OLLAMA_DOWNLOAD)}>
              Get Ollama
            </Button>
            <Button variant="ghost" icon="refresh" onClick={() => void detect()}>
              Check again
            </Button>
          </div>
        )
      ) : null}

      {runner && choose && !busy ? (
        <label className="la-pick">
          <span>Model</span>
          <Select id="la-model" size="sm" value={target} onChange={(e) => setPicked(e.target.value)}>
            {runner.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </label>
      ) : null}

      {runner && job.at === 'idle' && !confirm ? (
        <div className="la-act">
          {target ? (
            <Button variant="primary" icon="check" onClick={() => test(target)}>
              Test and use
            </Button>
          ) : runner.kind === 'ollama' && model ? (
            <Button variant="primary" icon="download" onClick={() => setConfirm(true)}>
              Download {formatGb(model.downloadGb)}
            </Button>
          ) : runner.kind === 'lmstudio' ? (
            <span className="la-what">Download a model in LM Studio, then check again.</span>
          ) : null}
        </div>
      ) : null}

      {confirm && model && license && job.at === 'idle' ? (
        <div className="la-confirm" role="group" aria-label="Confirm download">
          <p>
            Download {model.name} ({formatGb(model.downloadGb)}) with Ollama? It is saved on this computer and works offline. License: {license.name}.
          </p>
          <div className="la-act">
            <Button variant="primary" icon="download" onClick={download}>
              Download
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {job.at === 'pulling' ? (
        <div className="la-pull">
          <div className="la-bar" role="progressbar" aria-label={`Downloading ${job.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="la-act">
            <span className="la-what" aria-live="polite">
              {job.progress?.totalBytes ? `${formatGb(job.progress.completedBytes, 'bytes')} of ${formatGb(job.progress.totalBytes, 'bytes')}, ${pct}%` : 'Starting the download'}
              {background ? `. You can go on; ${ASSISTANT_NAME} switches when it is ready.` : ''}
            </span>
            <Button variant="ghost" icon="stop" onClick={cancelLocalAi}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {job.at === 'checking' ? (
        <div className="la-act">
          <span className="la-what" aria-live="polite">
            Checking a tool call and the speed.
          </span>
          <Button variant="ghost" icon="stop" onClick={cancelLocalAi}>
            Cancel
          </Button>
        </div>
      ) : null}

      {job.at === 'done' ? (
        <p className="pc-result ok" role="status">
          <Icon name="check" size={16} /> {ASSISTANT_NAME} now uses {job.tag} on this computer. {job.result.message}
        </p>
      ) : null}

      {job.at === 'failed' ? (
        <div className="la-fail" role="alert">
          <p>
            <Icon name="alert" size={16} /> {job.message}
          </p>
          {next && runner?.kind === 'ollama' ? (
            <Button
              onClick={() => {
                setChosen(next)
                resetLocalAi()
              }}
            >
              Try {next.name}
            </Button>
          ) : (
            <p className="la-note">Use a cloud model or sign in with ChatGPT instead.</p>
          )}
          <Button variant="ghost" icon="refresh" onClick={resetLocalAi}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function Head() {
  return (
    <div className="la-head">
      <Icon name="desktop" size={26} />
      <div className="min0">
        <b>Run a model on this computer</b>
        <small>Free and private: questions never leave this computer.</small>
      </div>
    </div>
  )
}
