// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Credential storage. Values never appear in `Debug` output, logs or error text.
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use crate::error::{Error, Result};
use crate::types::Secrets;

/// Where [`SecretStore::set_kept`] put a credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kept {
    /// In the store, for later runs too.
    Stored,
    /// In memory until the program quits: the keychain refused it.
    Session,
}

/// Write side of a credential store. The webview only ever gets this, never `Secrets::get`.
pub trait SecretStore: Secrets {
    fn set(&self, name: &str, value: &str) -> Result<()>;
    /// Like [`Self::set`], for a credential that must not stop what it belongs to (a printer being
    /// saved): a store that can keep it for the session instead says so rather than failing.
    fn set_kept(&self, name: &str, value: &str) -> Result<Kept> {
        self.set(name, value).map(|()| Kept::Stored)
    }
    fn delete(&self, name: &str) -> Result<()>;
    fn has(&self, name: &str) -> bool {
        self.get(name).is_some()
    }
}

/// In-process store for tests and headless runs. Nothing is written to disk.
#[derive(Default)]
pub struct MemorySecrets {
    map: Mutex<HashMap<String, String>>,
}

impl MemorySecrets {
    pub fn new() -> Self {
        Self::default()
    }
}

impl std::fmt::Debug for MemorySecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemorySecrets").finish_non_exhaustive()
    }
}

impl Secrets for MemorySecrets {
    fn get(&self, name: &str) -> Option<String> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .cloned()
    }
}

impl SecretStore for MemorySecrets {
    fn set(&self, name: &str, value: &str) -> Result<()> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(name.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<()> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(name);
        Ok(())
    }
}

/// Names of the credentials a connection test writes, uses once and deletes
/// (`packages/connect/setup` `testConnection`).
pub const TEST_SECRET_PREFIX: &str = "printer-test-";

/// A store whose connection test credentials ([`TEST_SECRET_PREFIX`]) stay in memory and everything
/// else goes to `inner`. A test's credential lives for one test, so it never needs the keychain, and a
/// keychain that refuses writes (Windows Credential Manager error 8 on one user's PC) no longer stops
/// the test before it reaches the printer.
pub struct ScratchSecrets {
    inner: std::sync::Arc<dyn SecretStore>,
    scratch: MemorySecrets,
}

impl ScratchSecrets {
    pub fn new(inner: std::sync::Arc<dyn SecretStore>) -> Self {
        Self {
            inner,
            scratch: MemorySecrets::new(),
        }
    }
}

impl std::fmt::Debug for ScratchSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScratchSecrets").finish_non_exhaustive()
    }
}

impl Secrets for ScratchSecrets {
    fn get(&self, name: &str) -> Option<String> {
        if name.starts_with(TEST_SECRET_PREFIX) {
            self.scratch.get(name)
        } else {
            self.inner.get(name).or_else(|| self.scratch.get(name))
        }
    }
}

impl SecretStore for ScratchSecrets {
    fn set(&self, name: &str, value: &str) -> Result<()> {
        if name.starts_with(TEST_SECRET_PREFIX) {
            self.scratch.set(name, value)
        } else {
            self.inner.set(name, value)
        }
    }

    /// A credential the keychain refuses is kept in memory for the session, so saving a printer never
    /// fails on it; the caller is told, to say so.
    fn set_kept(&self, name: &str, value: &str) -> Result<Kept> {
        if name.starts_with(TEST_SECRET_PREFIX) {
            return self.scratch.set(name, value).map(|()| Kept::Stored);
        }
        match self.inner.set(name, value) {
            Ok(()) => {
                // A stored copy takes over from one kept earlier in the session.
                self.scratch.delete(name)?;
                Ok(Kept::Stored)
            }
            Err(_) => self.scratch.set(name, value).map(|()| Kept::Session),
        }
    }

    fn delete(&self, name: &str) -> Result<()> {
        self.scratch.delete(name)?;
        if name.starts_with(TEST_SECRET_PREFIX) {
            Ok(())
        } else {
            self.inner.delete(name)
        }
    }
}

/// The OS keychain (macOS Keychain, Windows Credential Manager, Secret Service). Calls
/// block briefly, and macOS may show an access prompt on first use.
#[derive(Debug, Clone)]
pub struct KeychainSecrets {
    service: String,
}

impl KeychainSecrets {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_owned(),
        }
    }

    fn entry(&self, name: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, name)
            .map_err(|e| Error::Config(format!("keychain unavailable: {e}")))
    }
}

impl Secrets for KeychainSecrets {
    fn get(&self, name: &str) -> Option<String> {
        self.entry(name).ok()?.get_password().ok()
    }
}

impl SecretStore for KeychainSecrets {
    fn set(&self, name: &str, value: &str) -> Result<()> {
        let entry = self.entry(name)?;
        write_retrying(
            &|local| {
                if local {
                    local_entry(&self.service, name)?.set_password(value)
                } else {
                    entry.set_password(value)
                }
            },
            cfg!(windows),
        )
    }

    fn delete(&self, name: &str) -> Result<()> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Config(format!("keychain delete failed: {e}"))),
        }
    }
}

/// The Windows credential for `service` and `name` with Local persistence: kept on this PC and not
/// roamed with the account, as keyring's default Enterprise persistence is.
#[cfg(windows)]
fn local_entry(service: &str, name: &str) -> keyring::Result<keyring_core::Entry> {
    let local = HashMap::from([("persistence", "Local")]);
    keyring_core::Entry::new_with_modifiers(service, name, &local)
}

#[cfg(not(windows))]
fn local_entry(_: &str, _: &str) -> keyring::Result<keyring_core::Entry> {
    Err(keyring::Error::NoDefaultStore)
}

/// Writes with `write(false)`, and on Windows (`retry_local`) when the platform refuses it, once more
/// with `write(true)`, Local persistence: one user's Credential Manager refused the default Enterprise
/// (roaming) persistence with error 8. The error can name the service and account but never the value.
fn write_retrying(write: &dyn Fn(bool) -> keyring::Result<()>, retry_local: bool) -> Result<()> {
    match write(false) {
        Ok(()) => Ok(()),
        Err(first @ keyring::Error::PlatformFailure(_)) if retry_local => write(true).map_err(|again| {
            Error::Config(format!(
                "keychain write failed: {first}; with local persistence: {again}"
            ))
        }),
        Err(e) => Err(Error::Config(format!("keychain write failed: {e}"))),
    }
}

/// A JSON file readable only by its owner (mode 0600 in a 0700 directory), for headless hubs on a
/// Raspberry Pi, a NAS or in Docker, where no OS keychain runs. Values are not encrypted: anyone
/// who can read the file as this user or as root can read the credentials, the same as a printer
/// host's own config files. Writes go to a temporary file first and are renamed into place.
pub struct FileSecrets {
    path: std::path::PathBuf,
    map: Mutex<HashMap<String, String>>,
}

impl std::fmt::Debug for FileSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileSecrets")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl FileSecrets {
    /// Opens (or starts) the store at `path`. Fails when the file exists but is not a JSON object
    /// of strings, so a damaged file is never silently replaced.
    pub fn open(path: impl Into<std::path::PathBuf>) -> Result<Self> {
        let path = path.into();
        let map = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<HashMap<String, String>>(&bytes)
                .map_err(|_| Error::Config(format!("{} is not a secrets file", path.display())))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => return Err(Error::Config(format!("cannot read {}: {e}", path.display()))),
        };
        Ok(Self {
            path,
            map: Mutex::new(map),
        })
    }

    fn write(&self, map: &HashMap<String, String>) -> Result<()> {
        let fail = |e: std::io::Error| Error::Config(format!("cannot write {}: {e}", self.path.display()));
        if let Some(dir) = self.path.parent() {
            create_private_dir(dir).map_err(fail)?;
        }
        let body = serde_json::to_vec_pretty(map).map_err(|e| Error::Config(e.to_string()))?;
        write_private(&self.path, &body).map_err(fail)
    }
}

impl Secrets for FileSecrets {
    fn get(&self, name: &str) -> Option<String> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .cloned()
    }
}

impl SecretStore for FileSecrets {
    fn set(&self, name: &str, value: &str) -> Result<()> {
        let mut map = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        map.insert(name.to_owned(), value.to_owned());
        self.write(&map)
    }

    fn delete(&self, name: &str) -> Result<()> {
        let mut map = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        if map.remove(name).is_some() {
            self.write(&map)?;
        }
        Ok(())
    }
}

/// Creates `dir` (and parents) and limits it to its owner on Unix.
pub fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes `path` atomically (temporary file in the same directory, then rename), readable and
/// writable by its owner only on Unix.
pub fn write_private(path: &std::path::Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(body)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A keychain that refuses every write, as Windows Credential Manager did for a user (error 8).
    struct Refusing;
    impl Secrets for Refusing {
        fn get(&self, _: &str) -> Option<String> {
            None
        }
    }
    impl SecretStore for Refusing {
        fn set(&self, _: &str, _: &str) -> Result<()> {
            Err(Error::Config(
                "keychain write failed: Platform failure: Windows error code 8".into(),
            ))
        }
        fn delete(&self, _: &str) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_connection_test_credential_never_needs_the_keychain() {
        let s = ScratchSecrets::new(std::sync::Arc::new(Refusing));
        // The test's credential is written, read once and deleted: it works with a keychain that refuses.
        s.set("printer-test-0b8f0d3e", "12345678").unwrap();
        assert_eq!(s.get("printer-test-0b8f0d3e").as_deref(), Some("12345678"));
        s.delete("printer-test-0b8f0d3e").unwrap();
        assert_eq!(s.get("printer-test-0b8f0d3e"), None);
        // A saved printer's credential still goes to the keychain, and its refusal still reaches the caller.
        assert!(s.set("printer-p1s-x1y2", "12345678").is_err());
    }

    #[test]
    fn a_printer_credential_the_keychain_refuses_is_kept_for_the_session() {
        let s = ScratchSecrets::new(std::sync::Arc::new(Refusing));
        // Saving a printer never fails on the keychain: the code is kept in memory, and the caller is told.
        assert_eq!(s.set_kept("printer-p1s-x1y2", "12345678").unwrap(), Kept::Session);
        assert_eq!(s.get("printer-p1s-x1y2").as_deref(), Some("12345678"));
        s.delete("printer-p1s-x1y2").unwrap();
        assert_eq!(s.get("printer-p1s-x1y2"), None);
        // The memory store keeps what it is given.
        assert_eq!(MemorySecrets::new().set_kept("a", "b").unwrap(), Kept::Stored);
    }

    #[test]
    fn a_refused_write_is_tried_again_with_local_persistence() {
        let failure =
            || keyring::Error::PlatformFailure(Box::new(std::io::Error::other("Windows error code 8")));
        // Enterprise (roaming) refused, Local taken.
        let tries = std::cell::RefCell::new(Vec::new());
        let local_ok = |local: bool| {
            tries.borrow_mut().push(local);
            if local { Ok(()) } else { Err(failure()) }
        };
        assert!(write_retrying(&local_ok, true).is_ok());
        assert_eq!(*tries.borrow(), [false, true]);
        // Both refused: one error that names both tries, never the value.
        let both = write_retrying(&|_| Err(failure()), true).unwrap_err().to_string();
        assert!(
            both.contains("Windows error code 8") && both.contains("local"),
            "{both}"
        );
        // No retry off Windows, and none for an error that is not the platform's.
        tries.borrow_mut().clear();
        assert!(write_retrying(&local_ok, false).is_err());
        assert_eq!(*tries.borrow(), [false]);
        assert!(write_retrying(&|_| Err(keyring::Error::NoEntry), true).is_err());
    }

    #[test]
    fn file_store_persists_privately_and_redacts() {
        let dir = std::env::temp_dir().join(format!("sx-secrets-{}", std::process::id()));
        let path = dir.join("nested").join("secrets.json");
        let _ = std::fs::remove_dir_all(&dir);
        let s = FileSecrets::open(&path).unwrap();
        assert!(!s.has("printer-1"));
        s.set("printer-1", "hunter2").unwrap();
        s.set("printer-2", "swordfish").unwrap();
        s.delete("printer-2").unwrap();
        assert!(!format!("{s:?}").contains("hunter2"));
        let again = FileSecrets::open(&path).unwrap();
        assert_eq!(again.get("printer-1").as_deref(), Some("hunter2"));
        assert!(!again.has("printer-2"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            let mode = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700);
        }
        std::fs::write(&path, b"not json").unwrap();
        assert!(
            FileSecrets::open(&path).is_err(),
            "a damaged file is not replaced"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_store_round_trip_and_redaction() {
        let s = MemorySecrets::new();
        s.set("a", "hunter2").unwrap();
        assert!(s.has("a"));
        assert_eq!(s.get("a").as_deref(), Some("hunter2"));
        assert!(!format!("{s:?}").contains("hunter2"));
        s.delete("a").unwrap();
        assert!(!s.has("a"));
    }
}
