// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The native WebRTC module, loaded only where it exists. react-native-webrtc is a native module,
// so Expo Go, the web build and jest have none; `loadWebRtc()` then returns null and the camera
// seam falls back to sealed JPEG frames through the relay.
import type { ComponentType } from 'react'
import { Platform } from 'react-native'

/** The slice of a peer connection the feed uses. react-native-webrtc's classes satisfy it. */
export interface RtcPeer {
  addTransceiver(kind: 'video', init: { direction: 'recvonly' }): unknown
  createDataChannel(label: string): RtcChannel
  createOffer(): Promise<{ type: string; sdp?: string }>
  setLocalDescription(d: { type: string; sdp?: string }): Promise<void>
  setRemoteDescription(d: { type: 'answer'; sdp: string }): Promise<void>
  readonly localDescription: { sdp?: string } | null
  readonly iceGatheringState: string
  readonly connectionState: string
  addEventListener(type: string, cb: (e: never) => void): void
  close(): void
}

export interface RtcChannel {
  binaryType: string
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void
}

export interface RtcApi {
  RTCPeerConnection: new (config: { iceServers: { urls: string }[] }) => RtcPeer
  /** Draws a received video stream; takes `streamURL`. */
  RTCView?: ComponentType<{ streamURL: string; style?: object; objectFit?: 'cover' | 'contain' }>
}

let loaded: RtcApi | null | undefined

export function loadWebRtc(): RtcApi | null {
  if (loaded !== undefined) return loaded
  loaded = null
  if (Platform.OS === 'web') return loaded
  try {
    // A missing native module throws here, and the camera stays on JPEG frames.
    const m = require('react-native-webrtc') as RtcApi
    if (m.RTCPeerConnection) loaded = m
  } catch {
    loaded = null
  }
  return loaded
}

/** Test hook: replaces what `loadWebRtc` returns. */
export function setWebRtcForTests(api: RtcApi | null | undefined): void {
  loaded = api
}
