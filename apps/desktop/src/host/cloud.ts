// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cloud slicing on the desktop: the app's slicer with the edition's cloud service behind the "Slice in the cloud"
// choice. Every model the app loads (an opened project's objects, a painted object's copy) goes through the cloud
// slicer, which loads it in the native engine and keeps its bytes for the upload.
import { type CloudClient, cloudRoutedSlicer, createCloudSlicer } from '@slicerx/cloud'
import type { SlicerHost } from '@slicerx/contracts'
import { resolveAuto } from '@slicerx/settings'
import { encodeParts } from '@slicerx/slicer'

export function withCloudSlicing(local: SlicerHost, client: CloudClient, enabled: () => boolean): { slicer: SlicerHost; cloud: SlicerHost } {
  // The native engine's own parts encoder, so the cloud gets the mesh the engine here loads, paint included.
  const cloud = createCloudSlicer({ client, local, encodeParts })
  // The cloud reads settings as they are written; the native engine resolves the automatic ones itself.
  const slicer = cloudRoutedSlicer({ local, cloud, enabled, prepare: (req) => ({ ...req, config: resolveAuto(req.config) }) })
  return { slicer, cloud }
}
