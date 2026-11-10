// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The ways mimir gets a model here, as the connect card offers them (mimir-setup.tsx), and the line that names them
// where the card is not shown: the command bar's mimir row before a model is connected.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import type { IconName } from '@slicerx/ui'
import { useContext, useSyncExternalStore } from 'react'
import type { Host } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { useEdition } from '../edition'
import { HostContext } from '../host'
import { useChatGpt } from './chatgpt'
import { useMimirCloudHost, type MimirCloudHost } from './cloud'
import { cloudOffered, cloudReady } from './cloud-edition'
import { PROVIDERS } from './keys'
import { onLocalAiChange, registeredLocalAi } from './local-ai-host'

export type MimirChoice = 'cloud' | 'chatgpt' | 'key' | 'local' | 'skip'
/** mimir cloud here: ready to use, offered once the person signs in (the browser), or not offered. */
export type CloudOffer = 'ready' | 'sign-in' | 'none'

export interface MimirOption {
  id: MimirChoice
  icon: IconName
  name: string
  sum: string
}

/** Whether this build offers mimir cloud: the edition has it and the shell carries its host; a host that needs a
 * signed-in person (the browser) offers it as a sign-in until then. */
export function cloudOffer(edition: EditionConfig, h: MimirCloudHost | null): CloudOffer {
  if (!cloudOffered(edition, h)) return 'none'
  return cloudReady(edition, h) ? 'ready' : 'sign-in'
}

/**
 * The choices, in order: mimir cloud where offered, sign-in only where the shell can do it, your own key, local only
 * where the edition keeps it and the shell can run one (a browser cannot download or start a model), Skip in first-run.
 */
export function mimirChoices(opts: { cloud?: CloudOffer; signIn: boolean; localAi: boolean; skip?: boolean }): MimirOption[] {
  const out: MimirOption[] = []
  if (opts.cloud === 'ready') out.push({ id: 'cloud', icon: 'cloud', name: `Use ${ASSISTANT_NAME} free`, sum: PROVIDERS['mimir-cloud'].where })
  if (opts.cloud === 'sign-in') out.push({ id: 'cloud', icon: 'cloud', name: `Sign in to use ${ASSISTANT_NAME} free`, sum: `Free daily use with your ${ASSISTANT_NAME} account. No key.` })
  if (opts.signIn) out.push({ id: 'chatgpt', icon: 'creator', name: 'Sign in with ChatGPT', sum: 'Answers with your ChatGPT plan. Nothing to paste.' })
  out.push({ id: 'key', icon: 'key', name: 'Use your own API key', sum: 'An OpenAI or Anthropic key. You pick the model.' })
  if (opts.localAi) out.push({ id: 'local', icon: 'desktop', name: 'Run a local model', sum: 'Free and private. Downloads once, then works offline.' })
  if (opts.skip ?? true) out.push({ id: 'skip', icon: 'close', name: 'Skip for now', sum: 'Connect it later in Settings.' })
  return out
}

/** Whether this shell can run a local model: the edition keeps it and the shell registered one. */
export function useLocalRuns(): boolean {
  const edition = useEdition()
  const f = useSyncExternalStore(onLocalAiChange, registeredLocalAi, () => null)
  return edition.features.localAi && f !== null
}

/**
 * The choices the connect card offers here (no Skip): the same inputs as the card. The command bar can show before the
 * app's host is there (a test, the first frame); with none, ChatGPT sign-in is not counted, as no shell offers it yet.
 */
export function useMimirChoices(): MimirOption[] {
  const host = useContext(HostContext)
  const edition = useEdition()
  // a ChatGPT sign-in is made for a host only once the shell registered one, and every shell that does mounts with its host
  const signIn = useChatGpt(host as Host) !== null && host !== null
  const cloud = cloudOffer(edition, useMimirCloudHost())
  const localAi = useLocalRuns()
  return mimirChoices({ cloud, signIn, localAi, skip: false })
}

/** Each choice as the hint names it, in the card's order. */
const HINT_WORDS: Record<Exclude<MimirChoice, 'skip'>, string> = {
  cloud: `${ASSISTANT_NAME} free`,
  chatgpt: 'ChatGPT',
  key: 'your own API key (OpenAI or Anthropic)',
  local: 'a local model',
}

const either = (w: string[]): string => (w.length < 2 ? (w[0] ?? 'a model') : `${w.slice(0, -1).join(', ')} or ${w.at(-1)}`)

/**
 * What to connect before mimir answers, naming only what the card offers: "Connect ChatGPT or your own API key (OpenAI
 * or Anthropic) first". mimir free that needs a sign-in first leads: "Sign in for mimir free, or connect ... first".
 */
export function connectHint(options: readonly MimirOption[]): string {
  const ids = options.map((o) => o.id).filter((id): id is Exclude<MimirChoice, 'skip'> => id !== 'skip')
  const signIn = options.some((o) => o.id === 'cloud' && o.name.startsWith('Sign in'))
  const rest = ids.filter((id) => !(signIn && id === 'cloud')).map((id) => HINT_WORDS[id])
  return signIn ? `Sign in for ${ASSISTANT_NAME} free, or connect ${either(rest)} first` : `Connect ${either(rest)} first`
}
