// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
use std::fmt;

/// Letters and digits without look-alikes (no 0, O, 1, I, L).
const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// The code printed by `sx-link` at start. `Debug` and `Display` are the only ways to see it
/// and only the launching terminal should print it.
#[derive(Clone)]
pub struct PairingCode(String);

impl PairingCode {
    /// Eight characters, about 39 bits.
    pub fn random() -> Result<Self, getrandom::Error> {
        let mut bytes = [0_u8; 8];
        getrandom::fill(&mut bytes)?;
        let s: String = bytes
            .iter()
            .map(|b| {
                let idx = usize::from(*b) % ALPHABET.len();
                ALPHABET.get(idx).map_or('A', |c| char::from(*c))
            })
            .collect();
        Ok(Self(s))
    }

    pub fn from_string(s: &str) -> Self {
        Self(normalize(s))
    }

    /// Constant-time comparison after normalizing case and dashes.
    /// The code without its dash, for the code exchange.
    pub(crate) fn raw(&self) -> &str {
        &self.0
    }

    pub fn matches(&self, candidate: &str) -> bool {
        let a = self.0.as_bytes();
        let b = normalize(candidate);
        let b = b.as_bytes();
        let mut diff = a.len() ^ b.len();
        for i in 0..a.len().max(b.len()) {
            diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
        }
        diff == 0
    }
}

fn normalize(s: &str) -> String {
    s.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

impl fmt::Display for PairingCode {
    /// `ABCD-EFGH`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (a, b) = self.0.split_at(self.0.len().min(4));
        write!(f, "{a}-{b}")
    }
}

impl fmt::Debug for PairingCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PairingCode(..)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_ignores_case_and_dashes() {
        let c = PairingCode::from_string("abcd-efgh");
        assert!(c.matches("ABCDEFGH"));
        assert!(c.matches("abcd-efgh"));
        assert!(!c.matches("ABCDEFGX"));
        assert!(!c.matches("ABCDEFG"));
        assert!(!c.matches(""));
        assert_eq!(c.to_string(), "ABCD-EFGH");
    }

    #[test]
    fn random_codes_use_the_alphabet() {
        let c = PairingCode::random().unwrap().to_string().replace('-', "");
        assert_eq!(c.len(), 8);
        assert!(c.bytes().all(|b| ALPHABET.contains(&b)));
    }
}
