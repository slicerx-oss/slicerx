// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The menu bar from the first frame, so the window does not shift when the page loads. Its structure is
//! menu.json, written from the app's menu model (packages/app/test/menu.test.ts keeps the two in step).
//! The bar is never replaced: replacing it takes the old menu off the window before the new one goes on,
//! which shows a bar with menus missing, or none, for a frame. The page patches the menus whose items
//! differ (`menu_sync`), greys items in and out (`menu_enable`) and gets the picks of command items as
//! `sx-menu` events. Until the page loads, command items are greyed out and only the window items (quit,
//! full screen) act.
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

#[derive(Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Entry {
    Command {
        id: String,
        label: String,
        accelerator: Option<String>,
    },
    Window {
        action: String,
        label: String,
        accelerator: Option<String>,
    },
    Native {
        item: String,
    },
    Submenu {
        label: String,
        items: Vec<Entry>,
    },
    Separator,
}

#[derive(Deserialize, Clone, PartialEq, Debug)]
pub struct Section {
    pub label: String,
    pub items: Vec<Entry>,
}

#[derive(Deserialize)]
pub struct Menus {
    pub windows: Vec<Section>,
    pub linux: Vec<Section>,
    pub macos: Vec<Section>,
}

/// The sections the bar shows now, so a sync rebuilds only the menus that changed.
pub struct Shown(Mutex<Vec<Section>>);

impl Default for Shown {
    fn default() -> Self {
        Shown(Mutex::new(sections()))
    }
}

/// Menu item id prefix of a command item. Picks of these go to the page.
const COMMAND: &str = "sx-cmd:";

/// The menus with the edition's name where menu.json says `{app}` (About, Quit, the macOS app menu).
pub fn all() -> Menus {
    all_for(&crate::brand::get().name)
}

fn all_for(app: &str) -> Menus {
    fn fill(items: &mut [Entry], app: &str) {
        for e in items {
            match e {
                Entry::Command { label, .. } | Entry::Window { label, .. } => {
                    *label = label.replace("{app}", app)
                }
                Entry::Submenu { label, items } => {
                    *label = label.replace("{app}", app);
                    fill(items, app);
                }
                Entry::Native { .. } | Entry::Separator => {}
            }
        }
    }
    let mut m: Menus = serde_json::from_str(include_str!("../menu.json"))
        .expect("menu.json is written by the app's menu test");
    for s in m
        .windows
        .iter_mut()
        .chain(m.linux.iter_mut())
        .chain(m.macos.iter_mut())
    {
        s.label = s.label.replace("{app}", app);
        fill(&mut s.items, app);
    }
    m
}

fn sections() -> Vec<Section> {
    let all = all();
    if cfg!(target_os = "macos") {
        all.macos
    } else if cfg!(windows) {
        all.windows
    } else {
        all.linux
    }
}

pub fn initial(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for s in sections() {
        menu.append(&submenu(app, &s.label, &s.items)?)?;
    }
    Ok(menu)
}

fn submenu(app: &AppHandle, label: &str, items: &[Entry]) -> tauri::Result<Submenu<Wry>> {
    let sub = Submenu::new(app, label, true)?;
    for e in items {
        append(app, &sub, e)?;
    }
    Ok(sub)
}

fn append(app: &AppHandle, to: &Submenu<Wry>, e: &Entry) -> tauri::Result<()> {
    match e {
        Entry::Separator => to.append(&PredefinedMenuItem::separator(app)?),
        Entry::Native { item } => match native(app, item)? {
            Some(p) => to.append(&p),
            None => Ok(()),
        },
        Entry::Submenu { label, items } => to.append(&submenu(app, label, items)?),
        Entry::Command {
            id,
            label,
            accelerator,
        } => to.append(&MenuItem::with_id(
            app,
            format!("{COMMAND}{id}"),
            label,
            false,
            accelerator.as_deref(),
        )?),
        Entry::Window {
            action,
            label,
            accelerator,
        } => to.append(&MenuItem::with_id(
            app,
            format!("sx-window-{action}"),
            label,
            true,
            accelerator.as_deref(),
        )?),
    }
}

fn native(app: &AppHandle, item: &str) -> tauri::Result<Option<PredefinedMenuItem<Wry>>> {
    Ok(Some(match item {
        "cut" => PredefinedMenuItem::cut(app, None)?,
        "copy" => PredefinedMenuItem::copy(app, None)?,
        "paste" => PredefinedMenuItem::paste(app, None)?,
        "hide" => PredefinedMenuItem::hide(app, None)?,
        "hideOthers" => PredefinedMenuItem::hide_others(app, None)?,
        "showAll" => PredefinedMenuItem::show_all(app, None)?,
        "fullscreen" => PredefinedMenuItem::fullscreen(app, None)?,
        "minimize" => PredefinedMenuItem::minimize(app, None)?,
        "maximize" => PredefinedMenuItem::maximize(app, None)?,
        _ => return Ok(None),
    }))
}

/// One change a sync makes: rename a menu, refill its items, or add or drop a menu at the end of the bar.
#[derive(Debug, PartialEq)]
pub enum Patch {
    Rename(usize),
    Refill(usize),
    Append(usize),
    Drop(usize),
}

/// The changes that turn the menus in `shown` into `want`. Menus that match are left alone.
pub fn plan(shown: &[Section], want: &[Section]) -> Vec<Patch> {
    let mut out = Vec::new();
    for (i, w) in want.iter().enumerate() {
        match shown.get(i) {
            None => out.push(Patch::Append(i)),
            Some(s) => {
                if s.label != w.label {
                    out.push(Patch::Rename(i));
                }
                if s.items != w.items {
                    out.push(Patch::Refill(i));
                }
            }
        }
    }
    for i in (want.len()..shown.len()).rev() {
        out.push(Patch::Drop(i));
    }
    out
}

/// Brings the bar in line with the page's menu model. The bar stays on the window throughout.
#[tauri::command]
pub fn menu_sync(app: AppHandle, shown: State<'_, Shown>, sections: Vec<Section>) -> Result<(), String> {
    let menu = app.menu().ok_or("the window has no menu bar")?;
    let mut was = shown.0.lock().map_err(|e| e.to_string())?;
    let apply = || -> tauri::Result<()> {
        let bar = menu.items()?;
        for p in plan(&was, &sections) {
            match p {
                Patch::Rename(i) => {
                    if let Some(s) = bar.get(i).and_then(MenuItemKind::as_submenu) {
                        s.set_text(&sections[i].label)?;
                    }
                }
                Patch::Refill(i) => {
                    if let Some(s) = bar.get(i).and_then(MenuItemKind::as_submenu) {
                        for item in s.items()? {
                            s.remove(&item)?;
                        }
                        for e in &sections[i].items {
                            append(&app, s, e)?;
                        }
                    }
                }
                Patch::Append(i) => menu.append(&submenu(&app, &sections[i].label, &sections[i].items)?)?,
                Patch::Drop(i) => {
                    if let Some(item) = bar.get(i) {
                        menu.remove(item as &dyn IsMenuItem<Wry>)?;
                    }
                }
            }
        }
        Ok(())
    };
    apply().map_err(|e| e.to_string())?;
    *was = sections;
    Ok(())
}

/// Greys a command's items in or out.
#[tauri::command]
pub fn menu_enable(app: AppHandle, id: String, on: bool) {
    fn walk(items: Vec<MenuItemKind<Wry>>, id: &str, on: bool) {
        for item in items {
            match &item {
                MenuItemKind::MenuItem(m) if m.id().0 == id => {
                    let _ = m.set_enabled(on);
                }
                MenuItemKind::Submenu(s) => walk(s.items().unwrap_or_default(), id, on),
                _ => {}
            }
        }
    }
    if let Some(menu) = app.menu() {
        walk(menu.items().unwrap_or_default(), &format!("{COMMAND}{id}"), on);
    }
}

/// Quit closes the window, so unsaved changes are asked about; full screen toggles it. A command item
/// goes to the page, which runs the command (or a text field's own edit).
pub fn on_event(app: &AppHandle, event: MenuEvent) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    match event.id().as_ref() {
        "sx-window-quit" => {
            let _ = w.close();
        }
        "sx-window-fullscreen" => {
            let _ = w.set_fullscreen(!w.is_fullscreen().unwrap_or(false));
        }
        id => {
            if let Some(command) = id.strip_prefix(COMMAND) {
                let _ = w.emit("sx-menu", command);
            }
        }
    }
}

/// Opens the menu whose access key is `key`. On Windows an Alt+letter chord pressed in the page goes to
/// the page and never reaches the menu bar, so the page hands the letter over and the window opens the
/// menu the way Windows does for a window without a webview.
#[tauri::command]
pub fn menu_key(window: tauri::Window, key: char) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, SC_KEYMENU, WM_SYSCOMMAND};
        if let Ok(hwnd) = window.hwnd() {
            // SAFETY: posts a message to this app's own window; nothing is borrowed across the call.
            let _ = unsafe {
                PostMessageW(
                    Some(hwnd),
                    WM_SYSCOMMAND,
                    WPARAM(SC_KEYMENU as usize),
                    LPARAM(key as isize),
                )
            };
        }
    }
    #[cfg(not(windows))]
    let _ = (window, key);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(s: &[Section]) -> Vec<&str> {
        s.iter().map(|s| s.label.as_str()).collect()
    }

    #[test]
    fn every_platform_has_the_same_menus() {
        let m = all();
        assert_eq!(labels(&m.windows), ["&File", "&Edit", "&View", "&Help"]);
        assert_eq!(labels(&m.linux), ["&File", "&Edit", "&View", "&Help"]);
        assert_eq!(
            labels(&m.macos),
            ["SlicerX", "&File", "&Edit", "&View", "Window", "&Help"]
        );
    }

    #[test]
    fn a_white_label_build_names_itself_in_the_menus() {
        let m = all_for(&crate::brand::tests::acme().name);
        assert_eq!(m.macos[0].label, "Acme Slicer");
        let text = format!("{:?}", (&m.windows, &m.linux, &m.macos));
        assert!(text.contains("Quit Acme Slicer") && text.contains("&About Acme Slicer"));
        assert!(!text.contains("SlicerX") && !text.contains("{app}"));
    }

    #[test]
    fn native_items_are_ones_this_shell_knows() {
        fn walk(items: &[Entry], out: &mut Vec<String>) {
            for e in items {
                match e {
                    Entry::Native { item } => out.push(item.clone()),
                    Entry::Submenu { items, .. } => walk(items, out),
                    _ => {}
                }
            }
        }
        let m = all();
        let mut items = Vec::new();
        for s in m.windows.iter().chain(&m.linux).chain(&m.macos) {
            walk(&s.items, &mut items);
        }
        let known = [
            "cut",
            "copy",
            "paste",
            "hide",
            "hideOthers",
            "showAll",
            "fullscreen",
            "minimize",
            "maximize",
        ];
        assert!(items.iter().all(|i| known.contains(&i.as_str())), "{items:?}");
    }

    #[test]
    fn a_sync_touches_only_the_menus_that_changed() {
        let m = all();
        for shown in [&m.windows, &m.linux, &m.macos] {
            assert_eq!(plan(shown, shown), []);
        }
        // The page's View menu lists the look's tabs, which the startup menu cannot know.
        let mut want = m.windows.clone();
        let Entry::Command { label, .. } = &mut want[2].items[0] else {
            panic!("View starts with a tab")
        };
        *label = "Model".into();
        assert_eq!(plan(&m.windows, &want), [Patch::Refill(2)]);
        want[3].label = "&Hilfe".into();
        assert_eq!(plan(&m.windows, &want), [Patch::Refill(2), Patch::Rename(3)]);
        assert_eq!(plan(&m.windows, &m.windows[..3]), [Patch::Drop(3)]);
        assert_eq!(plan(&m.windows[..3], &m.windows), [Patch::Append(3)]);
    }

    #[test]
    fn the_page_model_reads_with_its_extra_fields() {
        // The page sends its model as is; fields the shell does not use (a text field's own edit) are ignored.
        let s: Vec<Section> = serde_json::from_str(r#"[{"label":"&Edit","items":[{"kind":"command","id":"undo","label":"&Undo","accelerator":"CmdOrCtrl+Z","text":"undo"}]}]"#).unwrap();
        assert_eq!(
            s[0].items[0],
            Entry::Command {
                id: "undo".into(),
                label: "&Undo".into(),
                accelerator: Some("CmdOrCtrl+Z".into())
            }
        );
    }
}
