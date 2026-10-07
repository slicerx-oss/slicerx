# First-run flow

Runs once on first launch of the desktop and web app, again from Settings > Look and feel ("Run setup again", "Add a printer with guided setup"), and again by itself when a release changes onboarding (see Onboarding version). The screens are the theme, the printer, the slicer the person uses now, what the plate tab opens in (editions with the modeling tools) and an optional one for mimir when the edition has mimir and it is not connected yet. Each is skippable. Nothing is sent anywhere by this flow except the network scan and the connection test to the printer the person picks, and what the person starts on the mimir screen. Copy is sentence case, units shown, standard slicer terms.

Frame: full window, a 52 px header with the mark, "Set up SlicerX", a "Skip, use defaults" ghost button and "Step 1 of 5" in mono, a 2 px gradient progress rail under it that fills one step at a time, content on a 1040 to 1100 px column, a footer with Back (ghost), Skip (text) and one gradient primary. Escape asks "Leave setup? You can finish it later from Settings." with Leave and Stay. Settings resumes at the screen the person left.

Code: `packages/app/src/first-run/`. `onboarding.ts` holds the steps and the onboarding version with no dependencies, so the shell can read them at launch. `model.ts` is the flow as a pure state machine (steps `theme`, `printer`, `look`, `open` and `mimir` where offered; old stored step names open the first screen, and a run left on `mimir` is stored as the step before it), `theme-step.tsx` the theme screen, `printer-step.tsx` the printer screen and `known-printer.tsx` its short form for someone who has one, `slicer-step.tsx` the slicer screen, `setup-host.ts` the scan and test host, `preset-import.ts` the preset import. The assistant has no panel here; its printer_setup skill still reaches the form through `skill-pilot.ts` when it is used from the docked panel.

## Pre-alpha agreement

In a pre-alpha build (`release.stage: 'pre-alpha'` in the edition config) the agreement comes first and covers the window until it is accepted: heavy testing is still needed, watch the printer on the first prints, report bugs in the Discord bug-reports channel, and crash reports stay on, with what is sent and what is removed. Accepting stores `agreement: { version, acceptedAt }` in prefs. Raising `AGREEMENT_VERSION` in `packages/contracts/src/agreement.ts` shows it again to everyone, in the app and in apps that embed SlicerX (`@slicerx/embed` uses the same version). Embedded hosts skip it, and so does a build for the end-to-end tests (`SLICERX_E2E=1` at build time sets `host.build.e2e`; `apps/web/playwright.config.ts` sets it). A browser driven by automation in a normal build still sees it.

## Screen 1: Pick a theme

`theme-step.tsx`, built from the same picker as Settings > Look and feel (`shell/theme-settings.tsx`). Title "Pick a theme", one line that every theme has a light and a dark mode and that Settings changes it later. On the left the mode (System, Light, Dark) and one card per theme with its light and dark modes side by side; the mode showing now is outlined on the picked card. Catppuccin is one card, its dark flavor (Mocha, Macchiato, Frappe) picked under the cards, Latte its light mode. On the right a small workspace drawn from the tokens, so it follows the pick, and "Easier to read": text size, color vision and reduce motion, with a line that the rest is in Settings. Every pick applies at once, so the rest of setup shows in it, and stays when setup is left. Phone width: one column, two cards a row, no workspace drawing.

## Screen 2: Find your printer

Someone who already has a printer (setup run again, from Settings or by a changed onboarding) sees "Your printer" instead: their printers, the one Slice uses first, kept with Next, and "Add another printer" for the scan below. "Add a printer with guided setup" always opens the scan. When the stored printer is gone, the scan opens.

The scan starts by itself when the screen opens (`AppSetupHost.discover`). It reads what each printer announces without signing in: model, address, serial number and firmware (Bambu Lab answers an SSDP search with them), nozzle diameter when the printer reports it, filament unit and slot count, and state. When nothing answers, Enter IP instead asks that one address (`AppSetupHost.probe`); a Bambu Lab printer answers with its model and serial number, anything else opens the hand-made form with the address filled in.

Above the list, a folded card says where a Bambu Lab printer's access code is on its screen for each family (X1, P1, A1, H2), that the code is enough for status, to turn on LAN Only Mode if the printer can't be reached, and what LAN Only Mode changes (Bambu Cloud, Bambu Handy). Developer Mode is under "Direct printing (optional)": without it, prints open in Bambu Connect, where the person presses Print (`packages/connect/docs/bambu-lan.md`). It opens by itself when a Bambu Lab printer is picked, or when one announced cloud mode (`DevConnect: cloud`). A printer that reports Developer Mode off is added as usual; the confirm card says, as a note rather than a warning, that prints go through Bambu Connect and where Developer Mode is for direct printing.

- A status line ("5 printers found on your local network") with Scan again.
- One card per printer: the maker's mark, "Bambu Lab X1 Carbon", a state pill, and mono chips for the printer's name, address, nozzle and "AMS, 4 slots". A printer the catalog does not know gets an orange "Not in the catalog" chip and opens the hand-made fields when picked.
- Picking a card fills the form (`adoptFound`), folds the other cards away ("Choose a different printer" brings them back) and shows the connection's fields below: only what the printer asks for and did not announce (Bambu Lab found by the scan: the access code alone; Moonraker: nothing). As soon as the fields validate the test runs by itself, with the same checklist as before (Reach, Sign in, Read state, Read temperatures). A pass shows what was read ("Reports X1 Carbon, 0.4 mm nozzle, AMS with 4 slots") and one confirm card (`confirm-card.tsx`), each row marked as from the printer or from the catalog: printer, build plate, enclosure and motion system (catalog), firmware, each nozzle with its diameter, material and high flow (an H2D's left and right nozzles), toolhead (catalog), and each AMS unit with the nozzle it feeds and what each slot holds. A nozzle the printer did not report stays a segmented picker. The bridge reads all of it in the same test (`printers.test` returns `hardware`: Bambu Lab from the pushall report, Klipper from `configfile`, OctoPrint from the printer profile, PrusaLink from `/api/v1/info`). A failure names the step and one thing to try; the footer offers Test again and Continue without testing.
- Links under the list: "Not listed? Add it by hand" and "I do not have a printer yet".
- The help pane on the right follows the focused field; with nothing focused it explains the scan and what to check when a printer is missing. On phones it is a bottom sheet.

While Test connection is off, the connection fields list why, field by field, in plain words ("The access code has 8 characters; 6 are entered."), each line a button that moves focus to its field, and the footer repeats the first reason beside the disabled button (`aria-describedby`).

Add it by hand keeps the earlier sections with a mini stepper: Brand (tiles and search), Model, Nozzle (diameter, type, toolhead, filament system), Connection (type, fields, "Find on my network"), Test. "Back to the scan" returns.

Secrets are uncontrolled inputs held in a ref for the length of the screen: never in React state, the store, logs or files. They go to the system keychain through `addPrinter`; in the browser they are used for the test only.

## Screen 3: Which slicer do you use now?

Left column: four radio cards (Bambu Studio, OrcaSlicer, PrusaSlicer, "Something else, or none yet", preselected as the SlicerX defaults). Each card has one line made from its first two preview notes ("Device tab, ⌘G to slice"). The pick is the look choice (`lookAndFeel`), applied live; arrow keys move it, and hovering a card previews it without picking it. A look is a control preset: mouse map, keymap and tab names. Layout and look are the same for everyone and the theme owns color, so the preview shows only those three.

Under the cards:
- Presets: "Bring your Bambu Studio presets". The panel says what comes over (the person's own printer, filament and process presets; the ones the app ships with are already in SlicerX) and that nothing in the other app changes. On a build with a `PresetImportHost` (the desktop app registers one with `registerPresetImport`) the host lists the user presets in the slicer's folder (`PRESET_FOLDERS`), all checked, with "Import N presets". Without one (the browser) the panel says how to get the files: the .json files in the Bambu Studio or OrcaSlicer preset folder, with the path, or File, Export, Export Config Bundle in PrusaSlicer; then "Choose preset files" (read through `host.files`). Results: "3 presets imported, 12 settings not recognized" plus one line per file that failed. Imports go through `importPresetText`, so vendor presets are never copied. "Something else" says there is nothing to bring and points to Settings, Presets.
- The crash reports checkbox with "What is sent", and on web the desktop download line.

Right column, the preview (`layout-preview.tsx`, data from `look-preview.ts`): the SlicerX window in miniature for the shown look. The theme has its own screen, so picking a look never changes it. Everything in it comes from the data the app uses: the real `Tabs` component with `topBarTabs` (the top bar's own order and names), the Prepare sidebar order from the layout, the settings modes, the plate tools (`PLATE_TOOLS`, shared with the toolbar) with their keys from the keymap, the command bar key in the search field, and the slice key by the Print button. The plate is the try-the-mouse box, driven by the shown look's camera map with the person's mouse changes on top.

`lookPreview` picks the two or three notes that matter most, in a fixed order: a renamed tab, the command bar key, the slice and export keys, two-finger scroll, Space to pan, dragging a model, the view keys, the support paint key, the single layer key, what the view turns around, double-click. A note counts when the look differs from the SlicerX defaults; for the defaults, when no other look shares it. Each note is a numbered pin on the window (a ring on its tab, the search field, the toolbar or the slice key; a chip on the plate for mouse notes) and a numbered line under it. Below the notes: the mouse in one line, the other differences after "Also:", and "Mouse buttons" for the dialog (None, Pan, Rotate per button; invert zoom; zoom to cursor; free camera). On phones the window is hidden and the notes stay. In one column the preview follows the cards.

The keys the preview promises work outside the plate too: the global key handler runs the look's slice, export and command bar chords (`controls/global-keys.ts`) next to the fixed ⌘↩, ⌘E and ⌘K. A bare key (Space in the OrcaSlicer style) is left to a focused control and to Preview, where Space plays. The top bar's search field shows the look's command bar key.

Under the grid: the footnote that the other slicers are their makers' products.

Primary: "Open the plate". It records completion, keeps the look and printer, and opens the first tab (Model, Prepare or Plater, by look). With the mimir screen to come, the primary is "Next".

## Set up mimir (optional)

`mimir-step.tsx`. Title "Set up mimir", one line that it answers questions and suggests changes you approve, and that it is optional. One radiogroup of flat cards: Sign in with ChatGPT (only where the shell can sign in), Use an API key, Run a local model (only with the edition's `features.localAi`), Skip for now (picked by default). The picked card opens its panel under the cards: the ChatGPT account card, the key panel without the local tab, or the Set up local AI helper (hardware, one recommendation with its reason, download size and license, a confirm before the download). The download and check run as a job outside the screen (`pilot-connect/local-ai-job.ts`): "Open the plate" never waits for it, and when the check passes mimir switches to the model and a toast says so. Footer: Back, Skip (when a choice other than Skip is picked) and "Open the plate".

## Onboarding version

`ONBOARDING_VERSION` in `first-run/onboarding.ts` goes up with every release that changes onboarding: a new step, or a step that asks something new. `STEP_SINCE` records the version each step arrived in (the theme and open steps arrived in 2). Finishing or leaving setup stores the version in `firstRun.version`; records from before versions count as 1.

At launch, a stored record older than the current version opens setup again (`onboardingRerun`):
- In pre-alpha and alpha (`release.stage`), everyone goes through all of it again. Every screen starts from the person's settings: their theme and reading options, their printer as "Your printer", their look, what the plate opens in, mimir only if it is still not connected. Skip and Skip, use defaults keep all of it.
- From beta on, only the steps newer than the stored version show.

A fresh install has no record and opens setup the usual way. Embedded hosts never show setup.

## Persistence

Writes: `lookAndFeel`, theme and reading options (as they are picked), the printer record (secrets to the keychain), `printerId`, `bed`, `firstRun` with the onboarding version. Leaving before the end writes nothing else except the look when the person had already picked it (applied live, kept). Analytics: none; the crash report checkbox only enables reports.

Accessibility: every control reachable by keyboard; found printers and slicer cards are radiogroups; progress announced ("Step 1 of 5, Theme"); theme cards and the mode are radiogroups; scan and test status use aria-live polite; tokens only, text contrast at least 4.5:1 in both themes. Phone width: single column, help pane as a bottom sheet, the preview window hidden.

## Acceptance

- `apps/web/e2e/first-run.spec.ts`: the theme step, the scan path end to end, the hand-made path with a failed test, Escape and resume from Settings, Skip, use defaults, Settings > Look and feel, and a profile from an earlier onboarding going through it again with its settings kept.
- No secret appears in any state dump, log or screenshot.
- Every screen passes the rubric at 1440 and 390 in both themes (score at least 8.0).
