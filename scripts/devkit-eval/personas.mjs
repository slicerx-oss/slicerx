// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scripted developers for the eval. Each sends the same messages whatever the agent says: an opening
// request, then answers to the interview questions the kit tells the agent to ask, then a go-ahead.
// `expect` is what the score checks the finished app against. `path: 'A'` personas make their own edition
// in a clone of the repository instead of embedding parts, and are scored on the edition (score.mjs).

export const PERSONAS = {
  whitelabel: {
    path: 'A',
    expect: { id: 'fernleaf', name: 'Fernleaf Slicer', identifier: 'com.fernleaf.slicer', accent: '#b8f34a', font: 'Fernleaf Sans' },
    // Copied into the app folder before the first turn: the brand files the developer already has.
    assets: { 'brand/fernleaf-mark.svg': 'packages/edition-config/fixtures/acme/mark.svg', 'brand/fernleaf-icon.png': 'packages/edition-config/fixtures/acme/icon.png', 'brand/fonts/FernleafSans.woff2': 'packages/app/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2' },
    turns: ({ clone, kit }) => [
      `I make Fernleaf, an Electron app for managing a 3D print library, and I want a slicer inside it with my own branding. The SlicerX dev kit is in ./${kit}, and I already cloned SlicerX to ${clone}. My brand files are in ./brand. What do you need from me?`,
      [
        'Answers:',
        '- A separate slicer app that Fernleaf launches with a file is fine. Call it Fernleaf Slicer, short name Fernleaf, id fernleaf.',
        '- App identifier com.fernleaf.slicer, link scheme fernleaf-slicer. macOS first.',
        '- Brand: accent #b8f34a on dark surfaces (#111318 and #1a1d23), the logo is ./brand/fernleaf-mark.svg, the app icon ./brand/fernleaf-icon.png, and our font is Fernleaf Sans in ./brand/fonts/FernleafSans.woff2 (a variable font, weights 100 to 900, licensed for apps).',
        '- Support page https://fernleaf.example/support. The source will be published at https://git.fernleaf.example/slicer/tree/{commit}.',
        '- Local only: no accounts, no cloud, no store. Turn the assistant on with a local model through Ollama.',
        '- Do not sign or ship anything yet; build it so I can try it.',
        'If your plan matches this, go ahead and build it.',
      ].join('\n'),
      'Yes, go ahead. When you are done, make sure the edition builds and tell me what still says SlicerX.',
    ],
  },
  // Chris: a developer with a desktop app, who wants "a slicer in my LayerMate" and does not know the paths.
  // The kit asks Path A or B; Chris answers "I'm not sure" and then follows the recommendation.
  layermate: {
    path: 'A',
    host: 'layermate',
    expect: { id: 'layerslice', name: 'LayerSlice', identifier: 'com.layermate.layerslice', accent: '#ff7a29', font: 'Layer Sans' },
    // The stand-in host app (a folder) and the brand files the developer already has.
    assets: { layermate: 'scripts/devkit-eval/fixtures/layermate', 'brand/layerslice-mark.svg': 'packages/edition-config/fixtures/acme/mark.svg', 'brand/layerslice-icon.png': 'packages/edition-config/fixtures/acme/icon.png', 'brand/fonts/LayerSans.woff2': 'packages/app/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2' },
    turns: ({ clone, kit }) => [
      `Make me a slicer in my LayerMate. LayerMate is our desktop app for a 3D print library, a stand-in copy of it is in ./layermate. The SlicerX dev kit is in ./${kit} and I already cloned SlicerX to ${clone}. My brand files are in ./brand.`,
      "I'm not sure, what do you recommend?",
      [
        'Okay, that works for me. Answers:',
        '- Call it LayerSlice, short name LayerSlice, id layerslice.',
        '- App identifier com.layermate.layerslice, link scheme layerslice. macOS first.',
        '- Brand: accent #ff7a29 on dark surfaces (#15161a and #1e2026), the logo is ./brand/layerslice-mark.svg, the app icon ./brand/layerslice-icon.png, and our font is Layer Sans in ./brand/fonts/LayerSans.woff2 (a variable font, weights 100 to 900, licensed for apps).',
        '- Support page https://layermate.example/support. The source will be published at https://git.layermate.example/layerslice/tree/{commit}.',
        '- Local only: no accounts, no cloud, no store. Turn the assistant on with a local model through Ollama.',
        '- Do not sign or ship anything yet; build it so I can try it. Make the Open in slicer button in LayerMate open a model in it.',
        'If your plan matches this, go ahead and build it.',
      ].join('\n'),
      'Yes, go ahead. When you are done, make sure the edition builds and tell me what still says SlicerX.',
    ],
  },
  // Path B with the engine: places parts in the viewport and slices with sx itself, no MCP server for slicing.
  engine: {
    path: 'B-engine',
    expect: { parts: ['viewport', 'slicing'], accent: '#e8590c', scheme: 'dark' },
    assets: { 'data/models/x-mark.stl': 'packages/core/bench/models/x-mark.stl' },
    turns: ({ sxBin, kit }) => [
      `I make Printbay, a print queue app, and I want a Prepare step in it: people put their models on a plate in the SlicerX 3D viewport, move and turn them, then slice. We want to run the sx engine ourselves for the slice, not through an MCP server. The SlicerX dev kit is in ./${kit}. There is no app yet, so start one here in this folder. What do you need from me?`,
      [
        'Answers:',
        '- Parts: the viewport with its Prepare tools, and slicing with the sx engine directly. Show the toolpath preview and the print time and grams after a slice. No printers, no settings panel and no locked projects for now.',
        '- Stack: React with Vite and TypeScript for the window, plus a small Node server (Express) that runs sx. npm.',
        '- Brand: accent #e8590c on dark surfaces (#14110f and #1d1916), system font, dark only.',
        '- Models: STL files in ./data/models (there is one there to try). Bambu Lab A1 with a 0.4 mm nozzle and Bambu PLA Basic; a hard-coded config of OrcaSlicer keys is fine for now.',
        `- The sx engine is at ${sxBin}. I have no SlicerX account token.`,
        '- Set things up for this project only. Do not change my global settings.',
        'If your plan matches this, go ahead and build it.',
      ].join('\n'),
      'Yes, go ahead. When you are done, make sure npm run build passes, slice the model in ./data/models once through your server to check it, and tell me what is left.',
    ],
  },
  tracker: {
    expect: { parts: ['viewport', 'slicing'], accent: '#2fbf71', scheme: 'dark' },
    turns: ({ sxBin, kit }) => [
      `I make a filament tracker in React and I want to add SlicerX slicing and the 3D viewport to it. My brand is green and dark. The SlicerX dev kit is in ./${kit}. There is no app yet, so start one here in this folder. What do you need from me?`,
      [
        'Answers:',
        '- Parts: slicing and the viewport. Nothing else for now (no printers, no locked projects).',
        '- Stack: React with Vite and TypeScript for the window, plus a small Node server for anything that cannot run in the browser. npm.',
        '- Brand: accent #2fbf71, background #0d1310, Inter font, dark only.',
        '- Models: users upload STL or 3MF files; keep them in ./data/models.',
        `- The sx engine is at ${sxBin}. I have no SlicerX account token.`,
        '- Set things up for this project only. Do not change my global settings.',
        'If your plan matches this, go ahead and build it.',
      ].join('\n'),
      'Yes, go ahead. When you are done, make sure npm run build passes and tell me what is left.',
    ],
  },
  queue: {
    expect: { parts: ['settings', 'locked', 'slicing'], accent: '#2f6df6', scheme: 'light' },
    turns: ({ sxBin, kit }) => [
      `We run a print farm and our job queue is a Vue 3 web app. Customers send us locked SlicerX projects, and we want to open those, let staff tweak print settings with the SlicerX settings panel, and slice. Our brand is blue and light. The SlicerX dev kit is in ./${kit}. There is no app yet, so start a small one here. What do you need from me?`,
      [
        'Answers:',
        '- Parts: locked projects, the settings panel, and slicing. No 3D viewport and no printers for now.',
        '- Stack: Vue 3 with Vite and TypeScript for the web app, and a small Node server (Express) for slicing and opening locked files. npm.',
        '- Brand: accent #2f6df6, white background, system font, light only.',
        '- Files: customers upload .sxlock and 3MF files; keep them in ./data/jobs.',
        `- The sx engine is at ${sxBin}. Our SlicerX account token goes in an environment variable; I will set it myself, do not ask me for it.`,
        '- Set things up for this project only. Do not change my global settings.',
        'If your plan matches this, go ahead and build it.',
      ].join('\n'),
      'Yes, go ahead. When you are done, make sure npm run build passes and tell me what is left.',
    ],
  },
}
