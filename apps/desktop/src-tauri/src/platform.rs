// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What the page cannot read about this computer itself. The web view's user agent says "MacIntel" on every Mac,
//! so the page asks the shell for the CPU, for the print watch, which does not run on Intel Macs (watch.rs).

/// The CPU the running shell was built for, as Rust names it: "aarch64" or "x86_64". On the universal Mac build it is
/// the half that is running.
#[tauri::command]
pub fn shell_arch() -> String {
    std::env::consts::ARCH.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_cpu_the_shell_runs_on() {
        let arch = shell_arch();
        assert!(!arch.is_empty());
        assert_eq!(arch, std::env::consts::ARCH);
    }
}
