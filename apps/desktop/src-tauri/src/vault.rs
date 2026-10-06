// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Printer credentials the system keychain refuses. On one user's Windows 11 PC, Credential Manager
//! refused every write with error 8, `cmdkey` included. There the bridge kept the access code only until
//! the app closed. On Windows such a credential now goes to a file of its own in the app's data folder,
//! encrypted with DPAPI for this Windows user (`CryptProtectData`, the current user's key), the way
//! Windows programs keep secrets when the vault is unavailable. The file holds the value only, is named
//! by the credential's name, and nothing about it is logged. Elsewhere there is no file: the keychain's
//! refusal stands.

use std::path::PathBuf;
use std::sync::Arc;

use sx_connect::{SecretStore, Secrets};

/// The keychain first; on Windows, a file sealed with DPAPI when the keychain refuses a write.
pub struct KeychainOrFile {
    keychain: Arc<dyn SecretStore>,
    dir: PathBuf,
}

impl KeychainOrFile {
    pub fn new(keychain: Arc<dyn SecretStore>, dir: PathBuf) -> Self {
        Self { keychain, dir }
    }

    /// One file per credential, named by the name's bytes in hex so any name is a plain file name.
    fn path(&self, name: &str) -> PathBuf {
        use std::fmt::Write as _;
        let mut file = String::with_capacity(name.len() * 2 + 6);
        for b in name.bytes() {
            let _ = write!(file, "{b:02x}");
        }
        file.push_str(".dpapi");
        self.dir.join(file)
    }

    fn read_file(&self, name: &str) -> Option<String> {
        let sealed = std::fs::read(self.path(name)).ok()?;
        String::from_utf8(unprotect(&sealed)?).ok()
    }
}

impl std::fmt::Debug for KeychainOrFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeychainOrFile").finish_non_exhaustive()
    }
}

impl Secrets for KeychainOrFile {
    fn get(&self, name: &str) -> Option<String> {
        self.keychain.get(name).or_else(|| self.read_file(name))
    }
}

impl SecretStore for KeychainOrFile {
    fn set(&self, name: &str, value: &str) -> sx_connect::Result<()> {
        match self.keychain.set(name, value) {
            Ok(()) => {
                // The keychain took it: no older sealed copy is left to disagree with it.
                let _ = std::fs::remove_file(self.path(name));
                Ok(())
            }
            Err(refused) => {
                let Some(sealed) = protect(value.as_bytes()) else {
                    return Err(refused);
                };
                sx_connect::create_private_dir(&self.dir)
                    .and_then(|()| sx_connect::write_private(&self.path(name), &sealed))
                    .map_err(|_| refused)
            }
        }
    }

    fn delete(&self, name: &str) -> sx_connect::Result<()> {
        let _ = std::fs::remove_file(self.path(name));
        self.keychain.delete(name)
    }
}

/// `data` sealed for this Windows user with DPAPI; `None` where there is no DPAPI or it fails.
#[cfg(windows)]
fn protect(data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).ok()?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input` points at `data`, which outlives the call and is only read. On success DPAPI
    // allocates `output` with LocalAlloc; it is copied out and freed once in `take_blob`.
    unsafe {
        CryptProtectData(
            &raw const input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut output,
        )
        .ok()?;
        Some(take_blob(output))
    }
}

/// The value `protect` sealed, for the same Windows user; `None` for anything else.
#[cfg(windows)]
fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(sealed.len()).ok()?,
        pbData: sealed.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in `protect`: `input` is only read during the call, and `output` is freed once.
    unsafe {
        CryptUnprotectData(
            &raw const input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut output,
        )
        .ok()?;
        Some(take_blob(output))
    }
}

/// Copies a blob DPAPI allocated and frees it.
///
/// # Safety
/// `blob` must come from a successful `CryptProtectData` or `CryptUnprotectData` and not be freed yet.
#[cfg(windows)]
unsafe fn take_blob(blob: windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    // SAFETY: DPAPI wrote `cbData` bytes at `pbData`, allocated with LocalAlloc, freed here once.
    unsafe {
        let out = if blob.pbData.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec()
        };
        let _ = LocalFree(Some(HLOCAL(blob.pbData.cast())));
        out
    }
}

#[cfg(not(windows))]
fn protect(_: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use sx_connect::{MemorySecrets, SecretStore, Secrets};

    /// A keychain that refuses every write, as Windows Credential Manager did for a user (error 8).
    struct Refusing;
    impl Secrets for Refusing {
        fn get(&self, _: &str) -> Option<String> {
            None
        }
    }
    impl SecretStore for Refusing {
        fn set(&self, _: &str, _: &str) -> sx_connect::Result<()> {
            Err(sx_connect::Error::Config(
                "keychain write failed: Platform failure: Windows error code 8".into(),
            ))
        }
        fn delete(&self, _: &str) -> sx_connect::Result<()> {
            Ok(())
        }
    }

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("sx-vault-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_seals_for_this_user_and_opens_again() {
        let sealed = protect(b"12345678").unwrap();
        assert!(
            !sealed.windows(8).any(|w| w == b"12345678"),
            "the code is not in the clear"
        );
        assert_eq!(unprotect(&sealed).unwrap(), b"12345678");
        assert!(unprotect(b"not a dpapi blob").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn a_code_the_keychain_refuses_goes_to_an_encrypted_file() {
        let d = dir("refused");
        let s = KeychainOrFile::new(Arc::new(Refusing), d.clone());
        // Stored for good: the caller is told nothing is lost at quit.
        assert_eq!(
            s.set_kept("printer-p1s", "12345678").unwrap(),
            sx_connect::Kept::Stored
        );
        assert_eq!(s.get("printer-p1s").as_deref(), Some("12345678"));
        let files: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().collect();
        assert_eq!(files.len(), 1);
        let bytes = std::fs::read(files[0].path()).unwrap();
        assert!(
            !bytes.windows(8).any(|w| w == b"12345678"),
            "the file holds no clear code"
        );
        // A new store over the same folder (the app started again) reads it back.
        let again = KeychainOrFile::new(Arc::new(Refusing), d.clone());
        assert_eq!(again.get("printer-p1s").as_deref(), Some("12345678"));
        again.delete("printer-p1s").unwrap();
        assert_eq!(again.get("printer-p1s"), None);
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_keychain_that_works_is_used_and_no_file_is_written() {
        let d = dir("works");
        let keychain = Arc::new(MemorySecrets::new());
        let s = KeychainOrFile::new(keychain.clone(), d.clone());
        s.set("printer-p1s", "12345678").unwrap();
        assert_eq!(keychain.get("printer-p1s").as_deref(), Some("12345678"));
        assert!(!d.exists() || std::fs::read_dir(&d).unwrap().count() == 0);
        let _ = std::fs::remove_dir_all(&d);
    }
}
