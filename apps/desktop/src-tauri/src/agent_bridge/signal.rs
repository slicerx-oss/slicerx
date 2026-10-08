// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The connection file goes away when a signal ends the app on macOS and Linux (`kill <pid>`, Ctrl+C, a closed
//! terminal), not only on a normal quit (`stop`), so no stale token file is left for the next run's client. The
//! handler then lets the signal end the app as it would have. On Windows a forced stop cannot be caught; closing the
//! window (or `taskkill /PID <pid>` without `/F`) goes through the normal quit, which removes the file.

use std::ffi::{CStr, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::OnceLock;

/// The connection file, and the token that marks it as this run's.
static ARMED: OnceLock<(CString, Vec<u8>)> = OnceLock::new();

/// Signals that end the app and now remove the connection file first.
pub const SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];

/// Removes `path` when one of `SIGNALS` arrives, if it still holds `token`. Once per run; later calls do nothing.
pub fn remove_on_signal(path: &Path, token: &str) {
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else {
        return;
    };
    if token.is_empty() || ARMED.set((c, token.as_bytes().to_vec())).is_err() {
        return;
    }
    for sig in SIGNALS {
        // SAFETY: a zeroed sigaction is a valid starting value; the handler only makes async-signal-safe calls, and
        // SA_RESETHAND puts the default action back as it runs, so the raise in it ends the app as the signal would.
        unsafe {
            let mut sa: libc::sigaction = std::mem::zeroed();
            sa.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
            sa.sa_flags = libc::SA_RESETHAND;
            libc::sigemptyset(&raw mut sa.sa_mask);
            libc::sigaction(sig, &raw const sa, std::ptr::null_mut());
        }
    }
}

extern "C" fn on_signal(sig: libc::c_int) {
    if let Some((path, token)) = ARMED.get()
        && holds(path, token)
    {
        // SAFETY: unlink is async-signal-safe and path is a valid C string for the life of the process.
        unsafe { libc::unlink(path.as_ptr()) };
    }
    // SAFETY: raise is async-signal-safe; the default action is back (SA_RESETHAND), so this ends the process once
    // the handler returns, with the signal as its cause.
    unsafe { libc::raise(sig) };
}

/// Whether the file at `path` holds `token`, read with open, read and close only (all async-signal-safe), without
/// following a link. The connection file is small; only its first 4 KiB are read.
fn holds(path: &CStr, token: &[u8]) -> bool {
    let mut buf = [0u8; 4096];
    // SAFETY: path is a valid C string; the descriptor is closed below.
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 {
        return false;
    }
    let mut n = 0;
    while n < buf.len() {
        // SAFETY: the read stays inside buf.
        let r = unsafe { libc::read(fd, buf[n..].as_mut_ptr().cast(), buf.len() - n) };
        if r <= 0 {
            break;
        }
        n += r.unsigned_abs();
    }
    // SAFETY: fd was opened above and is closed once.
    unsafe { libc::close(fd) };
    !token.is_empty() && buf[..n].windows(token.len()).any(|w| w == token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    const CHILD: &str = "SX_BRIDGE_SIGNAL_CHILD";
    const CHILD_TOKEN: &str = "SX_BRIDGE_SIGNAL_TOKEN";

    /// Runs this test binary again as a child that writes `file` with `written`, arms the handler for `token`, and
    /// waits; then sends it `sig` and returns how it ended.
    fn end_child(file: &Path, written: &str, sig: libc::c_int) -> std::process::ExitStatus {
        let ready = file.with_extension("ready");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "agent_bridge::signal::tests::a_signal_removes_this_runs_connection_file",
                "--test-threads=1",
            ])
            .env(CHILD, file)
            .env(CHILD_TOKEN, written)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !ready.exists() {
            assert!(
                started.elapsed() < Duration::from_secs(60),
                "the child did not start"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(file.exists());
        // SAFETY: kill with the child's own pid.
        assert_eq!(unsafe { libc::kill(i32::try_from(child.id()).unwrap(), sig) }, 0);
        child.wait().unwrap()
    }

    #[test]
    fn a_signal_removes_this_runs_connection_file() {
        if let Some(file) = std::env::var_os(CHILD).map(PathBuf::from) {
            // The child: the connection file as a run writes it, the handler armed, then a wait to be ended.
            let written = std::env::var(CHILD_TOKEN).unwrap();
            super::super::private::write_private(&file, format!("{{\"token\":\"{written}\"}}").as_bytes())
                .unwrap();
            remove_on_signal(&file, "t0k3n-of-this-run");
            std::fs::write(file.with_extension("ready"), b"").unwrap();
            std::thread::sleep(Duration::from_secs(120));
            std::process::exit(3);
        }
        let dir = std::env::temp_dir().join(format!("sx-bridge-signal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for sig in SIGNALS {
            let file = dir.join(format!("bridge-{sig}.json"));
            let status = end_child(&file, "t0k3n-of-this-run", sig);
            assert_eq!(status.signal(), Some(sig), "the signal still ends the app");
            assert!(!file.exists(), "signal {sig} left the connection file");
        }
        // A file another run wrote over this one's is left alone.
        let file = dir.join("bridge-other.json");
        let status = end_child(&file, "another-runs-token", libc::SIGTERM);
        assert_eq!(status.signal(), Some(libc::SIGTERM));
        assert!(file.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
