// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The icons the web shell can draw before its first paint: scripts/gen-icons.mjs puts their markup in
// src/icons/icon-startup.ts, which loads with the shell, and every other icon in a table loaded on first
// use. apps/web/scripts/bundle-size.mjs fails the build when a startup chunk names an icon missing here,
// so an icon added to the rail, the app bar or a startup panel is caught before it pops in.
export const STARTUP_ICONS = [
  'aegis', 'alert', 'approve', 'arrange', 'arrow-down', 'arrow-right', 'atlas', 'brim', 'bug', 'calibration',
  'camera', 'check', 'chevron-down', 'chevron-right', 'clay', 'close', 'color-painting', 'comment', 'copy', 'cube',
  'cut', 'delete', 'desktop', 'download', 'drop', 'duplicate', 'export', 'external', 'extruder', 'feed', 'fit',
  'fleet', 'flush', 'fullscreen', 'glow', 'grid', 'group', 'help', 'hide', 'import', 'info', 'iso-view', 'key',
  'lay-flat', 'layers', 'library', 'license', 'link', 'list', 'log', 'mcp', 'measure', 'mimir', 'mouse', 'move',
  'new-plate', 'nozzle', 'offline', 'overhang', 'paste', 'pause', 'phone', 'pilot', 'plate', 'plates', 'plus',
  'prepare', 'preset-draft', 'preset-fine', 'preset-standard', 'preset-strong', 'preview', 'printer', 'queue',
  'redo', 'report', 'rotate', 'ruler', 'save', 'scale', 'search', 'select-all', 'settings', 'shapes', 'shield', 'show',
  'sleipnir', 'slice', 'slicerx', 'sliders', 'speed', 'stop', 'support', 'sx3mf', 'terminal', 'text', 'thinking',
  'timelapse', 'undo', 'unlock', 'upload', 'version', 'warning', 'weight', 'zoom-in', 'zoom-out',
]
