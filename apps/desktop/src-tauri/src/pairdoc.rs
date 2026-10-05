// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The pairing host's document (its identity and every paired phone's device key). It is sealed with
//! ChaCha20-Poly1305 under a random key kept in the system keychain (service `slicerx-pair`), and the
//! sealed bytes live in the app data folder. A copied data folder opens nothing without the keychain.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const NONCE: usize = 12;

fn key() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new("slicerx-pair", "slicerx").map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(hex) => decode(&hex).ok_or_else(|| "the pairing key in the keychain is damaged".to_owned()),
        Err(keyring::Error::NoEntry) => {
            let mut k = [0u8; 32];
            getrandom::fill(&mut k).map_err(|e| e.to_string())?;
            entry.set_password(&encode(&k)).map_err(|e| e.to_string())?;
            Ok(k)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn decode(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

pub(crate) fn seal(k: &[u8; 32], text: &str) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; NONCE];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let sealed = ChaCha20Poly1305::new(&Key::from(*k))
        .encrypt(&Nonce::from(nonce), text.as_bytes())
        .map_err(|_| "could not seal".to_owned())?;
    Ok([nonce.to_vec(), sealed].concat())
}

pub(crate) fn open(k: &[u8; 32], bytes: &[u8]) -> Option<String> {
    if bytes.len() <= NONCE {
        return None;
    }
    let plain = ChaCha20Poly1305::new(&Key::from(*k))
        .decrypt(&Nonce::try_from(&bytes[..NONCE]).ok()?, &bytes[NONCE..])
        .ok()?;
    String::from_utf8(plain).ok()
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("pairing.sealed"))
}

/// The document, or nothing when none was saved or the keychain no longer opens it.
#[tauri::command]
pub fn pair_doc_read(app: AppHandle) -> Result<Option<String>, String> {
    let p = path(&app)?;
    let Ok(bytes) = std::fs::read(&p) else {
        return Ok(None);
    };
    Ok(open(&key()?, &bytes))
}

#[tauri::command]
pub fn pair_doc_write(app: AppHandle, text: String) -> Result<(), String> {
    if text.len() > 4 * 1024 * 1024 {
        return Err("pairing document too large".to_owned());
    }
    let p = path(&app)?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, seal(&key()?, &text)?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sealed_document_opens_only_under_its_key() {
        let k = [7u8; 32];
        let sealed = seal(&k, "{\"v\":1}").unwrap();
        assert!(!String::from_utf8_lossy(&sealed).contains("\"v\""));
        assert_eq!(open(&k, &sealed).as_deref(), Some("{\"v\":1}"));
        assert_eq!(open(&[8u8; 32], &sealed), None);
        assert_eq!(open(&k, &sealed[..5]), None);
    }

    #[test]
    fn keys_round_trip_through_hex() {
        let k: [u8; 32] = core::array::from_fn(|i| i as u8 * 7);
        assert_eq!(decode(&encode(&k)), Some(k));
        assert_eq!(decode("zz"), None);
    }
}
