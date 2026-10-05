// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/pair: pairing phones with SlicerX and sending them print jobs. See README.md.
export { createPairClient, type DeviceJoinRequest, type HostConnection, type PairedCamera, type PairedCameraFrame, type PairedCameraStats, type PairedPush, type PairClient, type PairClientOptions, type PairedHost, type PairingFlow, type PairingOutcome, type UploadFile } from './client'
export {
  createPairHost,
  DEFAULT_LIMITS,
  type ApprovalAudit,
  type ApprovalFeed,
  type HostJoinRequest,
  type HostLimits,
  type HostOffer,
  type HostPairingAttempt,
  type HostServices,
  type PairedDevice,
  type PairHost,
  type PairHostOptions,
  type PairPushHub,
  type PairSlicer,
  type SlicedFile,
} from './host'
export {
  ALL_RIGHTS,
  createIdentity,
  ensureIdentity,
  loadIdentity,
  memoryIdentityStore,
  memoryPairingStore,
  NO_RIGHTS,
  PairingRecord,
  StoredIdentity,
  storeIdentity,
  type DeviceIdentity,
  type IdentityStore,
  type PairingStore,
} from './identity'
export { createShortCode, DEFAULT_LINK_BASES, isLocalUrl, normalizeShortCode, OFFER_TTL_MS, parsePairingInput } from './offer'
export { createCameraRelay, PHONE_FPS, type CameraRelay, type PairCameraHandle, type PairCameraSource } from './camera-relay'
export { ExpoToken, PairError, PushPrefs, RemoteQuota, WorkSummary, type ApprovalView, type CameraQuality, type HostInfo, type JobState, type JobTarget, type JobUpdate, type LibraryEntry, type RpcErrorCode, type SliceOptions, type SliceSource, type SliceSummary, type SliceWhere } from './rpc'
export type { DevicePlatform, DeviceGrant, Endpoints, PublicIdentity, Rights } from './schema'
export { connectRelay, memoryPipePair, openSocket, pipeFromSocket, relayPipe, type Pipe, type RelayClientOptions, type RelayConnection, type SocketFactory, type SocketLike } from './transport'
export { defaultEnv, type PairEnv } from './crypto'
export { fromB64url, toB64url } from './bytes'
export { requestHash, signDecision, verifyDecision } from './approval'
export { createPairedPrinterHost, PairedPrinterError, type PairedPrinterHost, type PairedPrinterHostOptions } from './printer-host'
export { serveLanThroughBridge, type LanBridge, type LanService } from './lan-bridge'
export { relayAudience, relayTokenSource, type RelayTokenBackend, type RelayTokenSourceOptions } from './relay-token'
