// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Cisco's prebuilt `OpenH264`, for systems whose own decoder `SlicerX` does not use (Linux). Cisco
//! licenses H.264 for its own binaries, so `SlicerX` downloads Cisco's file at first use instead of
//! shipping a decoder: the caller fetches `url`, [`install_cisco_library`] unpacks it with the
//! system `bzip2` tool and checks the SHA-256 against the pin below, and the openh264 crate checks
//! the same file against its own list of known builds again when it loads it.
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use sha2::{Digest, Sha256};

#[cfg(not(windows))]
use crate::Rgb;

/// One build of Cisco's library for this system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CiscoLibrary {
    /// The unpacked file's name.
    pub file_name: &'static str,
    /// Where Cisco serves the bzip2-compressed file.
    pub url: &'static str,
    /// SHA-256 of the unpacked file.
    pub sha256: &'static str,
}

/// `OpenH264` 2.6.0, the version the openh264 crate 0.9.8 binds. Hashes as the crate lists them.
const BUILDS: &[(&str, &str, CiscoLibrary)] = &[
    (
        "linux",
        "x86_64",
        CiscoLibrary {
            file_name: "libopenh264-2.6.0-linux64.8.so",
            url: "http://ciscobinary.openh264.org/libopenh264-2.6.0-linux64.8.so.bz2",
            sha256: "2f0cde7c6a6abcf5cae76942894ea42897fa677bce4ed6c91a24dd1b041d5f04",
        },
    ),
    (
        "linux",
        "aarch64",
        CiscoLibrary {
            file_name: "libopenh264-2.6.0-linux-arm64.8.so",
            url: "http://ciscobinary.openh264.org/libopenh264-2.6.0-linux-arm64.8.so.bz2",
            sha256: "12e7b33623667cdab0e575170c147b1b36eadb77d0d2aa7ceb5afd3e58902140",
        },
    ),
    (
        "linux",
        "arm",
        CiscoLibrary {
            file_name: "libopenh264-2.6.0-linux-arm.8.so",
            url: "http://ciscobinary.openh264.org/libopenh264-2.6.0-linux-arm.8.so.bz2",
            sha256: "df91866de0e93773019e30a8f2bdee8b15de4abe2bf89a228ae9f064ff1e85bb",
        },
    ),
    (
        "macos",
        "aarch64",
        CiscoLibrary {
            file_name: "libopenh264-2.6.0-mac-arm64.dylib",
            url: "http://ciscobinary.openh264.org/libopenh264-2.6.0-mac-arm64.dylib.bz2",
            sha256: "052e98bfcf7a9167d22f3bbb3f5988ef79065591f36af8b52924b22b13624551",
        },
    ),
    (
        "macos",
        "x86_64",
        CiscoLibrary {
            file_name: "libopenh264-2.6.0-mac-x64.dylib",
            url: "http://ciscobinary.openh264.org/libopenh264-2.6.0-mac-x64.dylib.bz2",
            sha256: "e3dc8bc01fe69363f61fd3c02fd27798537a585eadd38cd808f303d1ee505a19",
        },
    ),
];

/// Cisco's build for this operating system and processor, if there is one.
pub fn cisco_library() -> Option<CiscoLibrary> {
    BUILDS
        .iter()
        .find(|(os, arch, _)| *os == std::env::consts::OS && *arch == std::env::consts::ARCH)
        .map(|(_, _, lib)| *lib)
}

#[derive(Debug)]
pub enum InstallError {
    /// No Cisco build for this system.
    Unsupported,
    /// The system has no `bzip2` tool (`apt install bzip2`).
    NoBzip2,
    /// The download did not unpack.
    Unpack(String),
    /// The unpacked file is not the pinned build.
    Hash {
        got: String,
    },
    Io(std::io::Error),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::Unsupported => f.write_str("Cisco's OpenH264 has no build for this system"),
            InstallError::NoBzip2 => f.write_str("the bzip2 tool is not installed"),
            InstallError::Unpack(m) => write!(f, "could not unpack OpenH264: {m}"),
            InstallError::Hash { got } => write!(
                f,
                "the OpenH264 download is not the expected build (SHA-256 {got})"
            ),
            InstallError::Io(e) => write!(f, "could not save OpenH264: {e}"),
        }
    }
}

impl std::error::Error for InstallError {}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::with_capacity(64), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Unpacks Cisco's download (`compressed`, the `.bz2` from [`CiscoLibrary::url`]) into `dir`,
/// after checking the unpacked bytes against the pinned SHA-256. Returns the library's path.
pub fn install_cisco_library(dir: &Path, compressed: &[u8]) -> Result<PathBuf, InstallError> {
    let lib = cisco_library().ok_or(InstallError::Unsupported)?;
    let unpacked = bunzip2(compressed)?;
    let got = hex(&Sha256::digest(&unpacked));
    if got != lib.sha256 {
        return Err(InstallError::Hash { got });
    }
    std::fs::create_dir_all(dir).map_err(InstallError::Io)?;
    let path = dir.join(lib.file_name);
    let tmp = dir.join(format!("{}.part", lib.file_name));
    std::fs::write(&tmp, &unpacked).map_err(InstallError::Io)?;
    std::fs::rename(&tmp, &path).map_err(InstallError::Io)?;
    Ok(path)
}

/// `bzip2 -dc`, fed through a pipe.
fn bunzip2(compressed: &[u8]) -> Result<Vec<u8>, InstallError> {
    let mut child = Command::new("bzip2")
        .arg("-dc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| InstallError::NoBzip2)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| InstallError::Unpack("no pipe".into()))?;
    let input = compressed.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let out = child.wait_with_output().map_err(InstallError::Io)?;
    let _ = writer.join();
    if !out.status.success() {
        return Err(InstallError::Unpack(
            String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        ));
    }
    Ok(out.stdout)
}

/// Decodes with Cisco's library at `path`. The openh264 crate checks the file's SHA-256 against
/// its list of known builds before loading it.
#[cfg(not(windows))]
pub(crate) fn decode(path: &Path, access_unit: &[u8]) -> Option<Rgb> {
    use openh264::decoder::{Decoder, DecoderConfig};
    use openh264::formats::YUVSource;

    let api = openh264::OpenH264API::from_blob_path(path).ok()?;
    let mut decoder = Decoder::with_api_config(api, DecoderConfig::new()).ok()?;
    let yuv = match decoder.decode(access_unit) {
        Ok(Some(yuv)) => Some(yuv),
        _ => None,
    };
    let picture = yuv.map(|y| {
        let (width, height) = y.dimensions();
        let mut data = vec![0_u8; width * height * 3];
        y.write_rgb8(&mut data);
        Rgb { width, height, data }
    });
    picture.filter(|p| p.width > 0 && p.height > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wrong_download_is_refused_before_it_is_saved() {
        let dir = std::env::temp_dir().join(format!("sx-stills-{}", std::process::id()));
        // Not bzip2 at all.
        assert!(matches!(
            install_cisco_library(&dir, b"not bzip2"),
            Err(InstallError::Unpack(_) | InstallError::NoBzip2 | InstallError::Unsupported)
        ));
        // Valid bzip2 of the wrong bytes: unpacks, then fails the pin.
        if cisco_library().is_some()
            && Command::new("bzip2")
                .arg("--help")
                .stderr(Stdio::null())
                .status()
                .is_ok()
        {
            let mut child = Command::new("bzip2")
                .arg("-c")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(b"pretend library").unwrap();
            let packed = child.wait_with_output().unwrap().stdout;
            assert!(matches!(
                install_cisco_library(&dir, &packed),
                Err(InstallError::Hash { .. })
            ));
            assert!(!dir.join(cisco_library().unwrap().file_name).exists());
        }
        assert!(BUILDS.iter().all(
            |(_, _, l)| l.sha256.len() == 64 && Path::new(l.url).extension().is_some_and(|e| e == "bz2")
        ));
    }
}
