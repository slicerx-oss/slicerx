# Test ids

`data-testid` values are part of the UI contract. The agent bridge ([agent-bridge.md](agent-bridge.md)) clicks, fills and
reads controls by them, and the release gate's scenarios name them, so a rename breaks a test run the same way a
renamed API breaks a client. The rules:

- Keep a test id when the control moves or its text changes. Rename one only together with every scenario that uses it.
- New screens add test ids to the controls a person uses to get through them, and list them here in the same change.
- Names are lower case words joined by hyphens: the screen or area first, then the control (`vault-detail-open`).
  A row repeated per item keeps one id and carries the item in another attribute (`data-listing`, `data-object-id`).
- A control that prints, sends to a printer, deletes, archives, publishes, installs an update or cancels something
  gets an id starting with `danger-`, or none. The bridge refuses `danger-` controls, and
  `packages/app/test/test-ids.test.ts` fails on an id with one of those words (delete, print, send-to, archive, erase,
  remove-account, publish, update, cancel) named any other way, unless it is listed under
  [Exceptions to the danger- rule](#exceptions-to-the-danger--rule) with the reason. The bridge also refuses everything
  inside the approval dialog, the Print sheet and any element marked `data-agent-refuse`.
- That test also fails when an id in the source is missing from this page.

Ids written with `<...>` stand for a family: `tab-<workspace>` is `tab-prepare`, `tab-feed` and so on.

## App frame

| Test id | Control |
| --- | --- |
| `tab-<workspace>` | A workspace tab in the top bar: `tab-prepare`, `tab-preview`, `tab-printers`, `tab-feed` (the Vault). In an edition with modeling tools the first two tabs are Model and Slice: `tab-model` and `tab-prepare` (Slice). The Model tab also answers to its old id, `tab-design`, through `data-testid-alias`, until scripts move to `tab-model` |
| `tab-overflow` | More, at the end of the tabs on a narrow window, holding the tabs that no longer fit; each item is `tab-overflow-<workspace>` (`tab-overflow-printers` first) |
| `edge-tab-<side>` | The tab on a panel's edge that shuts and reopens it: `edge-tab-left` (the left sidebar), `edge-tab-right` (the right pane), `edge-tab-bottom` (the bottom panel); `aria-expanded` says whether the panel is open, and `data-panel` says which panel: `model-tree`, `model-inspector`, `model-timeline`, `slice-sidebar` or `slice-summary` |
| `model-tree`, `model-inspector`, `slice-sidebar`, `slice-summary` | The body of the side pane with that edge tab: Model's tree and its tool and transform pane, Slice's printer and settings sidebar and its slice summary. It is gone while the pane is shut |
| `toast` | A toast on screen; `data-tone` is ok, info, warn or error |
| `toast-action` | The button on a toast (Undo and the like) |
| `dialog-close` | The close button of a dialog |
| `frame-close` | The close button of a full window frame (creator page editor, upload) |
| `unsaved-dialog` | Save changes first? |
| `unsaved-save`, `unsaved-discard`, `unsaved-cancel` | Its Save project, Don't save and Cancel buttons |
| `projects-dialog` | Restore unsaved work? at startup, or Recent projects (the title says which) |
| `recover-work` | The unsaved work it offers back: name, objects and time |
| `recover-restore` | Restore it |
| `danger-recover-discard` | Discard it (deletes the kept copy; the bridge refuses it, Close keeps the copy for later) |
| `recover-nothing` | There is nothing to restore |
| `recent-project` | A project in Recent projects (opens it) |
| `projects-close` | Close (keeps the unsaved work for next time) |
| `agreement` | The pre-alpha agreement screen |
| `agreement-check`, `agreement-accept` | Its checkbox and Accept and continue |
| `slice-track` | A slice in progress in the Estimate block: its bar and Cancel, in the big button's place |
| `raven-slice-glide` | Muninn riding the Estimate block's slicing bar, for a slice past about 1.2 s |
| `raven-loading` | Huginn and Muninn over the plate while a model loads for more than about 1.2 s |

## Setup (first run and Printers > Add)

| Test id | Control |
| --- | --- |
| `printers-add` | Add printer (or Add one by hand) in Printers: setup on the hand-made form |
| `setup` | The setup window; `data-step` is welcome, look, printer, mimir and so on |
| `setup-skip-all` | Skip, use defaults |
| `setup-back`, `setup-skip`, `setup-secondary`, `setup-next` | The footer: Back, Skip, the second action, and the main one (Next, Save printer, Open the plate) |
| `setup-leave-dialog`, `setup-leave`, `setup-stay` | Leave setup? and its two answers |
| `setup-printer-by-hand` | Not listed? Add it by hand (from the network scan to the hand-made form) |
| `setup-printer-search` | Search brand or model |
| `setup-printer-hit` | A search result; `data-model` is the model id |
| `setup-brand-<brand>` | A brand tile |
| `setup-model-<model>` | A model card; `setup-model-custom` is Not listed, set it up by hand |
| `setup-connection-<method>` | A connection choice; `setup-connection-export` is No connection (export files) |
| `setup-printer-step-<step>` | A step in the printer form's step list |
| `setup-printer-error` | The printer was not saved |
| `setup-mode-<mode>` | The settings mode in setup's slicer step: `setup-mode-simple`, `setup-mode-advanced`, `setup-mode-expert` |
| `theme-<family>` | A theme card in setup's theme step and in Settings, Look and feel: `theme-subban`, `theme-dracula` and so on |

## Slice: sidebar

| Test id | Control |
| --- | --- |
| `slice-machine-card` | The machine card at the top of the Slice sidebar: printer, nozzle, plate type and status |
| `slice-machine-printer` | The printer chip; opens the printer list |
| `slice-machine-printer-option` | A printer in that list, with `data-printer-id` |
| `slice-machine-printer-add` | Add printer, in the list or on the card with no printer |
| `slice-machine-printer-settings` | Printer settings in the list (Advanced and up) |
| `slice-machine-model` | The printer's maker and model, muted after its name on the card |
| `slice-machine-nozzle` | The nozzle chip |
| `slice-machine-nozzle-option` | A nozzle size in its popover, with `data-nozzle` |
| `slice-machine-plate` | The plate type chip: the type the active plate prints on, with `data-bed-type` |
| `slice-machine-plate-option` | A plate type in its popover, with `data-bed-type` (empty for the printer's default) |
| `slice-machine-status` | The printer's status: Ready, Printing, Paused, Error, Offline or Export only |
| `slice-mode-chip` | The settings mode chip in the Slice pane title |
| `slice-mode-chip-<mode>` | An item in its menu: `slice-mode-chip-simple`, `slice-mode-chip-advanced`, `slice-mode-chip-expert`, `slice-mode-chip-developer` |
| `slice-filament-rail` | The filament rail: one ring per slot, grouped by unit |
| `slice-filament-slot` | A slot's ring, with `data-slot`, `data-used` and `data-mismatch`; click edits it, Alt-click selects the objects on it |
| `slice-filament-slot-line` | The line under the rail: the hovered or focused slot, else the first in use |
| `slice-filament-total` | Grams and filament changes from the last slice, in the Filament header |
| `slice-filament-menu` | The Filament options menu |
| `slice-filament-calibrate` | Calibrate, in that menu |
| `slice-filament-flush` | Flush volumes, in that menu (two filaments or more) |
| `slice-filament-reset` | Reset to printer, in that menu (when a slot was edited) |
| `slice-filament-use-printer` | Use printer's filament, for a slot that differs from what the printer holds |
| `slice-goal-<tier>` | A Goal tile in Print settings: `slice-goal-draft`, `slice-goal-standard`, `slice-goal-fine`, `slice-goal-strong` |
| `slice-goal-estimate` | The line under the Goal tiles: about how long and how much from the last slice, or Updating |

## Prepare: the objects list and Export

| Test id | Control |
| --- | --- |
| `objects-list` | The Objects list |
| `objects-search` | Search objects and parts (two or more objects) |
| `object-row` | One object; `data-object-id` is its id |
| `object-select` | The row's button: selects it and opens its details |
| `object-name` | The object's name in the row |
| `object-warning` | A warning on the row (off the bed, a missing filament); `data-kind` names it |
| `object-lock`, `object-printable` | Lock, and leave out of the print |
| `object-rename` | The name field in the details |
| `object-part-slot` | The filament of a part, one per part |
| `objects-add-model` | Add model (opens the system's file dialog) |
| `objects-from-vault` | From the Vault |
| `add-shape` | Add shape |
| `object-menu` | Object (split, merge) |
| `export-menu` | Export |
| `export-save-project`, `export-locked-project`, `export-gcode-3mf`, `export-all-plates` | Its items (each opens the system's save dialog) |

## Opening a project

| Test id | Control |
| --- | --- |
| `project-open-dialog` | Open this project? (another slicer's project added to a plate that has objects) |
| `project-open-as-project`, `project-open-geometry-only` | Its Open as project and Import geometry only |
| `project-gcode-dialog` | Check this project's G-code (an .sx3mf with its own printer G-code) |
| `project-gcode-use-project`, `project-gcode-use-profile` | Its two choices |

## Vault

| Test id | Control |
| --- | --- |
| `vault-feed`, `vault-saved` | Feed and Saved |
| `vault-sign-in` | Sign in (signed out) |
| `vault-upload` | Upload |
| `account-menu` | The account button (signed in) |
| `account-uploads`, `account-creator-page`, `account-review`, `account-settings`, `account-sign-out` | Its items |
| `vault-featured` | The featured design; `data-listing` is its listing id |
| `vault-featured-open` | Its Open in SlicerX |
| `vault-card` | A design card in a row or the grid; `data-listing` is its listing id |
| `vault-card-details`, `vault-card-save` | The card's picture (opens its sheet) and its Save |
| `vault-creator` | A creator in New creators; `data-handle` is the handle |
| `vault-listing-sheet`, `vault-listing-close` | A design's sheet and its close button |
| `vault-detail` | The design in the sheet; `data-listing` is its listing id |
| `vault-detail-open`, `vault-detail-download` | Open in SlicerX and Download .sx3mf |
| `vault-download-status` | Download progress or failure; `data-state` is downloading or error |
| `vault-download-retry` | Try again after a failed download |

## Sign-in

| Test id | Control |
| --- | --- |
| `signin-dialog` | Sign in or create an account |
| `signin-notice` | The sign-in form shown where an action needs a session |
| `signin-form` | The form |
| `signin-email`, `signin-submit` | The address and Email me a link |
| `signin-provider-<provider>` | Continue with a sign-in provider |
| `signin-sent` | We sent a sign-in link |
| `signin-send-again` | Send again (Send a new link after a failed link), with its countdown while disabled |
| `signin-other-address` | Use another address |
| `signin-error` | The error under the form or the sent message |
| `signin-failed` | Sign-in did not finish |

## Upload and your uploads

| Test id | Control |
| --- | --- |
| `upload-dialog` | Upload a design |
| `upload-form` | Its form |
| `upload-source-project`, `upload-source-file` | This project or A file |
| `upload-project-file` | The project's packed file and size |
| `upload-file` | The file picker (a file input; set by a person) |
| `upload-title`, `upload-description`, `upload-tags`, `upload-license` | The fields |
| `upload-tag-<tag>` | A suggested tag |
| `upload-cover` | The cover as it will show; `data-source` is render (drawn from the model), picture or none |
| `upload-cover-file`, `upload-cover-render` | Use a picture, and Use the render |
| `colors-row` | One color of the design (upload and Colors); `data-hex` is the color |
| `upload-include-profile` | Show how it printed on the listing |
| `upload-state` | The status line (Ready to send, Uploading) |
| `raven-upload-carry` | The raven carrying the file, in the status line of an upload past about 1.2 s |
| `upload-cancel`, `upload-publish` | Cancel and Submit for review (sends the design to the Vault, where it waits for review) |
| `upload-your-uploads` | Your uploads |
| `uploads-list` | Your uploads |
| `uploads-new` | Upload a design |
| `uploads-row` | One upload; `data-listing` is its listing id |
| `uploads-stage` | Its stage; `data-stage` is uploading, scanning, review, live and so on |
| `uploads-view` | View, once it is live |

## Creator page editor

| Test id | Control |
| --- | --- |
| `creator-editor` | The editor |
| `creator-form` | Its form |
| `creator-banner-file`, `creator-logo-file` | Upload or change the banner and the logo (file inputs) |
| `creator-banner-remove`, `creator-logo-remove` | Remove them |
| `creator-name`, `creator-handle`, `creator-location`, `creator-bio` | The fields |
| `creator-link-site`, `creator-link-label`, `creator-link-url` | A link's site, label and address, one each per link |
| `creator-add-link` | Add link |
| `creator-state` | The status line (Unsaved changes, All changes saved) |
| `creator-save`, `creator-discard`, `creator-cancel` | Save, Discard (or Close), and Cancel when it opened from Upload |
| `creator-view-sheet` | View my sheet |

## Updates

| Test id | Control |
| --- | --- |
| `update-sheet` | The update sheet |
| `update-body` | Its body; `data-step` is checking, current, available, downloading, ready, installing or error |
| `danger-update-now`, `update-download` | Update now (downloads and installs), or Download for package installs |
| `danger-update-restart` | Restart to update |
| `update-later` | Later (Close after an error) |
| `update-quit` | Quit, when the update is required |
| `update-retry` | Try again |

## Preview

| Test id | Control |
| --- | --- |
| `legend-color-by` | The legend's Color by menu: what the toolpath colors show |
| `legend-color-<mode>` | Its items: `legend-color-feature`, `legend-color-tool` (Filament), `legend-color-speed`, `legend-color-flow`, `legend-color-layer-time` |
| `legend-slot` | A slot's swatch and path length in the Filament colors; `data-slot` is the slot number |

## Settings: Connected apps

| Test id | Control |
| --- | --- |
| `connected-apps` | The Connected apps section (Settings, after Printer bridge) |
| `connected-app-<app>` | An app's card: `connected-app-bambuddy`, `connected-app-spoolman`, `connected-app-home-assistant` |
| `connected-app-bambuddy` | BamBuddy's card |
| `connected-app-bambuddy-address` | BamBuddy's address |
| `connected-app-bambuddy-key` | BamBuddy's API key (kept in the secrets store; empty keeps the saved one) |
| `connected-app-bambuddy-save` | Add BamBuddy, or Save after Edit |
| `connected-app-bambuddy-status` | Connected, Not answering, Testing or Added |
| `connected-app-bambuddy-test` | Test connection |
| `connected-app-bambuddy-edit` | Edit the address or key |
| `connected-app-bambuddy-remove` | Remove BamBuddy and its key |
| `connected-app-spoolman` | Spoolman's card (moved from Printer bridge, unchanged) |
| `connected-app-home-assistant` | Home Assistant's card, shown only while experimental connectors are on; the same `-address`, `-key`, `-save`, `-status`, `-test`, `-edit` and `-remove` ids as BamBuddy's |
| `connected-app-home-assistant-experimental` | The Experimental label on Home Assistant's card |
| `connected-apps-experimental` | Try experimental connectors, at the bottom of Connected apps in Developer mode |

Once BamBuddy is added, printer setup offers `setup-connection-bambuddy` for the models that can use it.

## Exceptions to the danger- rule

These ids carry one of the rule's words but name no destructive act, so they keep their names and the bridge may use
them. `packages/app/test/test-ids.test.ts` keeps this table and its own list the same.

| Test id | Why it is not `danger-` |
| --- | --- |
| `upload-publish` | The release gate publishes its own test design; nothing goes live before a person approves it in review |
| `unsaved-cancel` | Closes Save changes first? and keeps everything as it is |
| `upload-cancel` | Closes the upload form; nothing was sent |
| `creator-cancel` | Closes the creator page editor without saving |
| `update-sheet` | The update sheet itself |
| `update-body` | The sheet body, read for its step |
| `update-download` | Opens the download page for a package install; nothing is installed |
| `update-later` | Closes the sheet without updating |
| `update-quit` | Quits the app when an update is required, without installing anything |
| `update-retry` | Checks for the update again |

## Other

Ids that tests read for their text:

| Test id | Control |
| --- | --- |
| `about-attribution`, `about-step-reader` | About: the engine attribution and the STEP reader line |
| `bug-preview` | Report a bug: what the report sends |
| `step-note`, `step-bind` | A CAD history step's note and binding |
| `model-box-select` | The box while a Shift and left drag selects in Model; `data-dir` is `inside` (left to right) or `touch` (right to left) |
| `model-shelf` | Model's tool shelf |
| `model-shelf-tool` | A tool on the shelf; `data-tool` names it |
| `model-shelf-next` | The shelf's next slot: up to three tools for what is picked; hidden with nothing picked |
| `model-shelf-next-tool` | A tool in the next slot; `data-next-tool` names it |
| `model-select-pill` | Model's selection pill at the top left of the view |
| `model-select-filter` | A pick filter button in the pill; `data-kind` is `object`, `face` or `edge`, and `aria-pressed` says whether it is on |
| `model-select-readout` | What is picked, in words ("1 face on Box") |
| `model-select-clear` | Clears the faces, edges and objects picked |
| `step-sketch` | A step's sketch line in the Model tree, with its loop count; a click opens the sketch |
| `model-tree-object` | An object row in the Model tree; `data-object-id`, and `data-kind` is `body` (has a history) or `mesh` |
| `model-tree-step` | A step row in the Model tree; `data-object-id`, `data-index` and `data-state` (`done`, `broken`, `skipped`, `suppressed`) |
| `model-tree-more` | A step row's More button, which opens the step's menu |
| `model-tree-filter` | The tree's filter field, opened by typing in the tree; Escape shuts it |
| `model-tree-rollback` | The rollback row after the step the part is shown at: drag it, or Up, Down and End with focus |
| `model-tree-rename` | The inline name field of an object or a step being renamed |
| `model-ctx` | An open Model tree menu, from a right click, a long press, Shift+F10 or More; `data-target` is `step` or `object` |
| `model-ctx-edit`, `model-ctx-roll`, `model-ctx-suppress`, `model-ctx-rename`, `model-ctx-earlier`, `model-ctx-later`, `model-ctx-sketch`, `model-ctx-end` | A step menu's items: edit it, roll the part back to it, turn it off or on, rename, move, show its sketch, roll back to the latest |
| `model-ctx-lock`, `model-ctx-printable`, `model-ctx-split-objects`, `model-ctx-split-parts`, `model-ctx-merge`, `model-ctx-duplicate`, `model-ctx-center`, `model-ctx-drop`, `model-ctx-slice` | An object menu's items, with `model-ctx-rename`: lock, printable, split, merge, duplicate, center, drop to the bed, go to Slice |
| `danger-model-ctx-delete` | Delete in a Model tree menu: a step's asks first, an object's removes it as the Delete key does |
| `danger-model-confirm-delete` | Delete in the dialog that asks before a step is deleted |
| `parked-chip` | The chip that says a modeling tool is parked while you work in Slice |
| `hole-size-words`, `thread-words` | The hole and thread tools' size in words |
| `value-<name>` | A named value in the values panel |
| `brim-ear-count` | The number of painted brim ears |
| `cut-conn-tol-source` | Where the cut connector tolerance comes from |
| `pv-change`, `pv-purge` | Preview: the tool change and the purge at the playhead |
| `ph-placeholder` | The phone view's placeholder |
