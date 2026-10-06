// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Opens links and files with the system's own handler, never through a shell. On Windows the app
//! opened them with `cmd /C start "" <link>`, and cmd reads `&`, `|`, `^`, `<` and `>` in an unquoted
//! argument as its own syntax: `https://example.com/?a=1&calc` started calc as a second command (seen
//! on Windows 11 with `echo` in place of `start`). ShellExecute, through `tauri_plugin_opener` (the
//! `open` crate's `ShellExecuteExW` on Windows, `open` on macOS, `xdg-open` on Linux), takes the link as
//! one string.

/// Opens `url` with the system's handler for its scheme.
pub fn open_url(url: &str) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Opens `path` with the system's handler for its type.
pub fn open_path(path: &std::path::Path) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// Hands `url` to `open` when it is an https link; nothing else may reach the system's handler.
pub fn open_https_with(url: &str, open: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https links open in the browser".into());
    }
    open(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_in_the_shell_opens_a_link_through_cmd() {
        // Built from parts so this test does not find itself.
        let pattern = ["\"/", "C\", \"st", "art\""].concat();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found = Vec::new();
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
            let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
            let into = ["\"/C\".into(), \"st", "art\".into()"].concat();
            if flat.contains(&pattern) || flat.contains(&pattern.replace(", ", ",")) || flat.contains(&into) {
                found.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        found.sort();
        assert!(found.is_empty(), "cmd /C start in {found:?}");
    }

    #[test]
    fn a_link_reaches_the_opener_as_one_string() {
        let mut got = Vec::new();
        let url = "https://example.com/?a=1&calc|x^y";
        open_https_with(url, |u| {
            got.push(u.to_owned());
            Ok(())
        })
        .unwrap();
        assert_eq!(got, [url]);
        assert!(open_https_with("file:///C:/Windows/System32/calc.exe", |_| Ok(())).is_err());
        assert!(open_https_with("javascript:alert(1)", |_| Ok(())).is_err());
    }
}
