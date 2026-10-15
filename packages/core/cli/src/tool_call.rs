// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! command-line access to the shared tool runtime.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const PACKAGE_ENTRY: &str = "node_modules/@slicerx/mcp/dist/cli.js";

fn help() -> String {
    let name = sx_core::api::app_name();
    format!(
        "usage: sx call [server options] <tool> [json] [<tool> [json] ...]\n\nRun {name} tools in order, with one JSON result per call. Tool names may omit\nthe slicerx_ prefix. Use --app to edit the open app, or --no-app for server designs.\n\nExamples:\n  sx call --app design_list\n  sx call --app design_steps '{{\"design\":\"obj_1\"}}'\n  sx call --no-app design_new '{{\"name\":\"Bracket\"}}' design_list\n\nRequires Node.js 24+ and @slicerx/mcp installed in this project or beside sx.\nSLICERX_MCP_CLI selects a built cli.js or standalone slicerx-mcp.mjs explicitly.\nSLICERX_NODE_BIN selects Node.js (default: node on PATH).\nServer options, permissions, approvals and read-back are the same as slicerx-mcp call."
    )
}

pub(crate) fn run(args: &[String]) -> crate::Res<ExitCode> {
    if args.is_empty() {
        eprintln!("{}", help());
        return Ok(ExitCode::from(2));
    }
    if args.len() == 1 && matches!(args[0].as_str(), "--help" | "-h") {
        println!("{}", help());
        return Ok(ExitCode::SUCCESS);
    }
    let exe = std::env::current_exe()?;
    let entry = find_entry(
        std::env::var_os("SLICERX_MCP_CLI"),
        &std::env::current_dir()?,
        &exe,
    )?;
    let node = std::env::var_os("SLICERX_NODE_BIN").unwrap_or_else(|| "node".into());
    let mut command = Command::new(&node);
    // pass arguments directly, including json and spaces; never through a shell.
    command.arg(entry).arg("call").args(args);
    if std::env::var_os("SLICERX_SX_BIN").is_none() {
        command.env("SLICERX_SX_BIN", &exe);
    }
    if std::env::var_os("SLICERX_SX_GEOM_BIN").is_none() {
        let geom = exe.with_file_name(if cfg!(windows) { "sx-geom.exe" } else { "sx-geom" });
        if geom.is_file() {
            command.env("SLICERX_SX_GEOM_BIN", geom);
        }
    }
    let status = command.status().map_err(|e| {
        format!(
            "could not run Node.js ({}): {e}; install Node.js 24+ or set SLICERX_NODE_BIN",
            Path::new(&node).display()
        )
    })?;
    Ok(ExitCode::from(
        u8::try_from(status.code().unwrap_or(1)).unwrap_or(1),
    ))
}

fn find_entry(explicit: Option<OsString>, cwd: &Path, exe: &Path) -> crate::Res<PathBuf> {
    if let Some(path) = explicit {
        let path = cwd.join(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!("SLICERX_MCP_CLI is not a file: {}", path.display()).into());
    }
    // use the nearest project install, then the runtime shipped with the executable.
    for root in cwd.ancestors() {
        let path = root.join(PACKAGE_ENTRY);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Some(dir) = exe.parent() {
        let standalone = dir.join("slicerx-mcp.mjs");
        if standalone.is_file() {
            return Ok(standalone);
        }
        for root in dir.ancestors() {
            let path = root.join(PACKAGE_ENTRY);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    Err("sx call needs @slicerx/mcp: install it in this project, place slicerx-mcp.mjs beside sx, or set SLICERX_MCP_CLI to the built runtime".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "sx-call-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "").unwrap();
            path
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn selects_the_nearest_project_install() {
        let dir = Directory::new();
        dir.file(PACKAGE_ENTRY);
        let local = dir.file(&format!("project/{PACKAGE_ENTRY}"));
        let cwd = dir.0.join("project/models");
        assert_eq!(find_entry(None, &cwd, &dir.0.join("bin/sx")).unwrap(), local);
    }

    #[test]
    fn finds_a_runtime_beside_the_executable_from_another_directory() {
        let dir = Directory::new();
        let runtime = dir.file("kit/bin/slicerx-mcp.mjs");
        assert_eq!(
            find_entry(None, &dir.0.join("models"), &dir.0.join("kit/bin/sx")).unwrap(),
            runtime
        );
    }

    #[test]
    fn explicit_runtime_wins_and_an_invalid_override_does_not_fall_back() {
        let dir = Directory::new();
        dir.file(PACKAGE_ENTRY);
        let runtime = dir.file("custom runtime/server.mjs");
        let exe = dir.0.join("sx");
        assert_eq!(
            find_entry(Some("custom runtime/server.mjs".into()), &dir.0, &exe).unwrap(),
            runtime
        );
        assert!(find_entry(Some("missing.mjs".into()), &dir.0, &exe).is_err());
    }
}
