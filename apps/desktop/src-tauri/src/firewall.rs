// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Whether Windows Firewall lets this app hear printers on the local network. Printer discovery listens for
//! announcements (SSDP, mDNS) on inbound UDP, which Windows Firewall allows or blocks per program; a prompt the
//! person closed leaves a Block rule and a scan that finds nothing. This reads the rules for the app's own
//! program, without admin rights and changing nothing, and opens Windows' own page to allow it. OrcaSlicer,
//! Bambu Studio and PrusaSlicer do not check.

/// What the inbound rules for the app say for private networks, where printers are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Inbound {
    /// An enabled Allow rule covers private networks, and no Block rule does.
    Allowed,
    /// An enabled Block rule covers private networks (closing Windows' prompt leaves one).
    Blocked,
    /// No rule covers private networks: Windows asks the next time the app listens, or a prompt was dismissed
    /// in a way that left nothing.
    None,
    /// Not Windows, or the rules could not be read.
    Unsupported,
}

/// The verdict from `Action|Profile` pairs, `;` between rules, as `query_script` prints the enabled inbound rules.
/// Windows applies a Block rule over an Allow rule.
fn verdict(rules: &str) -> Inbound {
    let private = |profile: &str| {
        profile
            .split(',')
            .map(str::trim)
            .any(|p| p == "Private" || p == "Any")
    };
    let mut allowed = false;
    for rule in rules.split(';').filter(|r| !r.trim().is_empty()) {
        let Some((action, profile)) = rule.split_once('|') else {
            continue;
        };
        if !private(profile) {
            continue;
        }
        match action.trim() {
            "Block" => return Inbound::Blocked,
            "Allow" => allowed = true,
            _ => {}
        }
    }
    if allowed { Inbound::Allowed } else { Inbound::None }
}

/// The PowerShell that prints the enabled inbound rules for `program` as `Action|Profile` pairs. The cmdlets' enum
/// names are not translated, unlike `netsh` output, and reading rules needs no admin rights.
fn query_script(program: &str) -> String {
    let quoted = program.replace('\'', "''");
    format!(
        "$ProgressPreference = 'SilentlyContinue'; \
         $r = Get-NetFirewallApplicationFilter -Program '{quoted}' -ErrorAction SilentlyContinue | \
         Get-NetFirewallRule -ErrorAction SilentlyContinue | \
         Where-Object {{ $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' }} | \
         ForEach-Object {{ \"$($_.Action)|$($_.Profile)\" }}; $r -join ';'"
    )
}

/// `script` as PowerShell's `-EncodedCommand` takes it: base64 of its UTF-16LE text.
fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    sx_core::thumbnail::base64_encode(&bytes)
}

/// Whether Windows Firewall lets this app hear printers on private networks. Reads only.
#[tauri::command]
pub async fn firewall_inbound() -> Inbound {
    #[cfg(windows)]
    {
        let Ok(exe) = std::env::current_exe() else {
            return Inbound::Unsupported;
        };
        let script = query_script(&exe.to_string_lossy());
        let mut ps = std::process::Command::new("powershell.exe");
        ps.args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encode_command(&script),
        ]);
        let out =
            tauri::async_runtime::spawn_blocking(move || crate::launch::no_window(&mut ps).output()).await;
        match out {
            Ok(Ok(o)) if o.status.success() => verdict(String::from_utf8_lossy(&o.stdout).trim()),
            _ => Inbound::Unsupported,
        }
    }
    #[cfg(not(windows))]
    {
        Inbound::Unsupported
    }
}

/// Opens Windows' own "Allow an app through Windows Firewall" page, where the person allows the app. Nothing is
/// changed here: adding a rule takes admin rights, and the choice is theirs.
#[tauri::command]
pub fn firewall_open_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut control = std::process::Command::new("control.exe");
        control.args(["/name", "Microsoft.WindowsFirewall", "/page", "pageConfigureApps"]);
        crate::launch::no_window(&mut control)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("Windows Firewall settings exist only on Windows".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_rule_on_private_networks_blocks() {
        // Closing the prompt leaves Block rules; Windows lets a Block rule win over an Allow rule.
        assert_eq!(verdict("Block|Private, Public"), Inbound::Blocked);
        assert_eq!(verdict("Allow|Private;Block|Any"), Inbound::Blocked);
        assert_eq!(verdict("Allow|Domain;Block|Public"), Inbound::None);
    }

    #[test]
    fn an_allow_rule_on_private_networks_allows() {
        assert_eq!(verdict("Allow|Private"), Inbound::Allowed);
        assert_eq!(verdict("Allow|Any"), Inbound::Allowed);
        assert_eq!(verdict("Allow|Domain, Private, Public"), Inbound::Allowed);
        // A printer is on a private network: an Allow for public networks alone does not count.
        assert_eq!(verdict("Allow|Public"), Inbound::None);
        assert_eq!(verdict(""), Inbound::None);
    }

    #[test]
    fn the_query_names_the_program_whatever_its_path_holds() {
        // Sent encoded, so a path with a quote or a space cannot change the command.
        let script = query_script(r"C:\Users\O'Neil Smith\AppData\Local\SlicerX\slicerx.exe");
        assert!(
            script.contains(r"'C:\Users\O''Neil Smith\AppData\Local\SlicerX\slicerx.exe'"),
            "{script}"
        );
        let encoded = encode_command(&script);
        assert!(
            encoded
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c))
        );
    }
}
