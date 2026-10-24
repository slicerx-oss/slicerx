// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer's keep-out areas (`bed_exclude_area`, and the nozzle wrap check corner of the A1 family) as polygons for
// the viewport. The reading is shared with arrange and the MCP server's arrange (@slicerx/settings/arrange-room).
export { excludedPolygons, keepOutPolygons } from '@slicerx/settings/arrange-room'
