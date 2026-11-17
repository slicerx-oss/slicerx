// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Mixed filaments: a filament number that prints as one of two loaded filaments per layer, in a repeating
//! pattern from a ratio, so the two colors blend to the eye.
//!
//! The plate's `mixed_filaments` setting lists them, one entry each as `id:a,b:ra,rb:name`: the filament number
//! parts and paint use for the mix (`id`), its two loaded filaments (`a`, `b`), how many layers of each a cycle
//! prints (`ra`, `rb`), and a name the engine does not read. Every region on a mixed filament prints with the
//! filament its layer resolves to ([`Mixes::resolve`]) before any path is planned, so the tool order, the prime
//! tower and the flush see only loaded filaments.

use crate::config::PrintConfig;
use crate::error::{Error, Result};

/// The setting that lists the mixed filaments.
pub const KEY: &str = "mixed_filaments";

/// The most layers of one filament a cycle may print.
pub const MAX_RATIO: u32 = 20;

/// The highest filament number a mix takes: paint keeps filament numbers up to 32, so the app and the MCP server
/// number mixes from there down and the loaded filaments count up from 1.
pub const TOP_ID: u8 = 32;

/// The most mixes a project holds, so the numbers mixes take are `TOP_ID - MAX_MIXES + 1` to [`TOP_ID`].
pub const MAX_MIXES: u8 = 4;

/// The lowest filament number a mix takes.
pub const LOWEST_ID: u8 = TOP_ID - MAX_MIXES + 1;

/// One mixed filament.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mix {
    /// The filament number parts and paint use for it.
    pub id: u8,
    /// The two loaded filaments it alternates.
    pub components: [u8; 2],
    /// Layers of each filament per cycle.
    pub ratio: [u32; 2],
}

impl Mix {
    /// Which of the two filaments layer `layer` prints: the layers of the second are spread through the cycle as
    /// evenly as the ratio allows (2:1 prints A, A, B; 3:2 prints A, A, B, A, B), so neither color forms a band.
    #[must_use]
    pub fn at(&self, layer: u32) -> u8 {
        let [a, b] = self.ratio;
        let n = u64::from(a + b);
        let i = u64::from(layer) % n;
        let b = u64::from(b);
        // Layer i of the cycle prints B when the count of B layers up to and including it, rounded down, grows.
        if (i + 1) * b / n > i * b / n {
            self.components[1]
        } else {
            self.components[0]
        }
    }
}

/// The mixed filaments of a plate.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Mixes(Vec<Mix>);

impl Mixes {
    /// The mixed filaments `cfg` lists (none without the setting).
    ///
    /// # Errors
    /// [`Error::Config`] for an entry that does not parse, a filament number outside 1 to 64, a mix whose two
    /// filaments are the same or are themselves mixes, a ratio outside 1 to [`MAX_RATIO`], or two mixes with one id.
    pub fn of(cfg: &PrintConfig) -> Result<Self> {
        let bad = |reason: String| Error::Config { key: KEY, reason };
        let entries: Vec<&str> = match cfg.raw.get(KEY) {
            None | Some(serde_json::Value::Null) => return Ok(Self::default()),
            Some(serde_json::Value::Array(a)) => a
                .iter()
                .map(|v| v.as_str().ok_or_else(|| bad("entries must be text".to_owned())))
                .collect::<Result<_>>()?,
            Some(serde_json::Value::String(s)) if s.trim().is_empty() => return Ok(Self::default()),
            Some(serde_json::Value::String(s)) => vec![s.as_str()],
            Some(_) => return Err(bad("must be a list of entries".to_owned())),
        };
        let mut out: Vec<Mix> = Vec::with_capacity(entries.len());
        for (k, e) in entries.iter().enumerate() {
            if e.trim().is_empty() {
                continue;
            }
            let m = parse(e).ok_or_else(|| {
                bad(format!(
                    "entry {} \"{e}\" is not id:a,b:ra,rb (filaments 1 to 64, ratio 1 to {MAX_RATIO})",
                    k + 1
                ))
            })?;
            if m.components[0] == m.components[1] {
                return Err(bad(format!(
                    "mixed filament {} mixes filament {} with itself",
                    m.id, m.components[0]
                )));
            }
            if out.iter().any(|o| o.id == m.id) {
                return Err(bad(format!("two mixed filaments use filament number {}", m.id)));
            }
            out.push(m);
        }
        for m in &out {
            if let Some(c) = m.components.iter().find(|c| out.iter().any(|o| o.id == **c)) {
                return Err(bad(format!(
                    "mixed filament {} uses mixed filament {c}; mix two loaded filaments",
                    m.id
                )));
            }
        }
        Ok(Self(out))
    }

    /// Checks the mixes the plate uses (`used`: the filaments its parts and paint name) against the `loaded`
    /// filaments, when the settings say how many (one `filament_colour` each): a used mix's number is past them and
    /// its two are among them. A mix nothing uses is not checked, so one made ahead of time never stops a slice.
    ///
    /// # Errors
    /// [`Error::Config`] naming the first used mix that breaks either rule.
    pub fn check_used(&self, used: impl IntoIterator<Item = u8>, loaded: Option<usize>) -> Result<()> {
        let Some(n) = loaded else {
            return Ok(());
        };
        let bad = |reason: String| Error::Config { key: KEY, reason };
        let mut ids: Vec<u8> = used.into_iter().filter(|s| self.get(*s).is_some()).collect();
        ids.sort_unstable();
        ids.dedup();
        for m in ids.iter().filter_map(|&id| self.get(id)) {
            if usize::from(m.id) <= n {
                return Err(bad(format!(
                    "mixed filament {} has the number of loaded filament {}; number it past the {n} loaded",
                    m.id, m.id
                )));
            }
            if let Some(c) = m.components.iter().find(|c| usize::from(**c) > n) {
                return Err(bad(format!(
                    "mixed filament {} uses filament {c}, but only {n} are loaded",
                    m.id
                )));
            }
        }
        Ok(())
    }

    /// True when `slot` was left on a deleted mix: on a plate with mixes, one of the numbers mixes take
    /// ([`LOWEST_ID`] up) that no mix names and that is past the `loaded` filaments. A part on it prints in filament 1
    /// and paint in it in the part's own filament. Without mixes, or without a count of the loaded filaments, no
    /// number is.
    #[must_use]
    pub fn left_on_mix(&self, slot: u8, loaded: Option<usize>) -> bool {
        !self.is_empty()
            && self.get(slot).is_none()
            && slot >= LOWEST_ID
            && loaded.is_some_and(|n| usize::from(slot) > n)
    }

    /// The filament a part on `slot` prints as: filament 1 when [`Self::left_on_mix`], else `slot`.
    #[must_use]
    pub fn part_slot(&self, slot: u8, loaded: Option<usize>) -> u8 {
        if self.left_on_mix(slot, loaded) { 1 } else { slot }
    }

    /// True with no mixed filaments.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The mix filament number `slot` names, if it is one.
    #[must_use]
    pub fn get(&self, slot: u8) -> Option<&Mix> {
        self.0.iter().find(|m| m.id == slot)
    }

    /// The loaded filament `slot` prints with on layer `layer`: itself, or for a mix the filament of that layer.
    #[must_use]
    pub fn resolve(&self, slot: u8, layer: u32) -> u8 {
        self.get(slot).map_or(slot, |m| m.at(layer))
    }

    /// The loaded filaments `slot` prints with on some layer: itself, or a mix's two.
    pub fn expand(&self, slot: u8) -> impl Iterator<Item = u8> {
        let pair = self.get(slot).map(|m| m.components);
        let (one, two) = match pair {
            Some([a, b]) => (a, Some(b)),
            None => (slot, None),
        };
        std::iter::once(one).chain(two)
    }
}

/// One entry, `id:a,b:ra,rb` with an optional `:name` after it.
fn parse(e: &str) -> Option<Mix> {
    let mut it = e.trim().splitn(4, ':');
    let filament = |s: &str| s.trim().parse::<u8>().ok().filter(|f| (1..=64).contains(f));
    let id = filament(it.next()?)?;
    let (a, b) = it.next()?.split_once(',')?;
    let (ra, rb) = it.next()?.split_once(',')?;
    let ratio = |s: &str| {
        s.trim()
            .parse::<u32>()
            .ok()
            .filter(|r| (1..=MAX_RATIO).contains(r))
    };
    Some(Mix {
        id,
        components: [filament(a)?, filament(b)?],
        ratio: [ratio(ra)?, ratio(rb)?],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(entries: &[&str]) -> PrintConfig {
        let mut c = PrintConfig::default();
        c.raw.insert(KEY.to_owned(), serde_json::json!(entries));
        c
    }

    fn pattern(e: &str, n: u32) -> String {
        let m = Mixes::of(&cfg(&[e])).expect("parses");
        (0..n)
            .map(|l| if m.resolve(18, l) == 1 { 'A' } else { 'B' })
            .collect()
    }

    #[test]
    fn the_layer_pattern_follows_the_ratio() {
        assert_eq!(pattern("18:1,2:1,1", 6), "ABABAB");
        assert_eq!(pattern("18:1,2:2,1", 9), "AABAABAAB");
        assert_eq!(pattern("18:1,2:3,2", 10), "AABABAABAB");
        // Each cycle prints the ratio's count of each.
        let p = pattern("18:1,2:3,2", 5);
        assert_eq!((p.matches('A').count(), p.matches('B').count()), (3, 2));
        // A ratio with a common factor prints as its lowest terms.
        assert_eq!(pattern("18:1,2:2,2", 6), "ABABAB");
    }

    #[test]
    fn other_filaments_resolve_to_themselves() {
        let m = Mixes::of(&cfg(&["18:1,2:2,1:Purple"])).expect("parses");
        assert_eq!(m.resolve(3, 7), 3);
        assert_eq!(m.expand(18).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(m.expand(2).collect::<Vec<_>>(), [2]);
    }

    #[test]
    fn names_may_hold_colons_and_no_setting_is_no_mix() {
        assert!(Mixes::of(&cfg(&["17:3,1:1,4:a: b"])).is_ok());
        assert!(Mixes::of(&PrintConfig::default()).expect("no setting").is_empty());
        assert!(Mixes::of(&cfg(&[])).expect("empty").is_empty());
    }

    #[test]
    fn bad_entries_are_refused() {
        for e in [
            "18:1,1:1,1",
            "18:1,2:0,1",
            "18:1,2:1,21",
            "0:1,2:1,1",
            "18:1,65:1,1",
            "18:1:1,1",
            "x",
        ] {
            assert!(Mixes::of(&cfg(&[e])).is_err(), "{e}");
        }
        assert!(Mixes::of(&cfg(&["18:1,2:1,1", "18:1,3:1,1"])).is_err());
        assert!(Mixes::of(&cfg(&["18:1,2:1,1", "17:18,3:1,1"])).is_err());
    }

    #[test]
    fn a_used_mix_is_numbered_past_the_loaded_filaments_and_mixes_two_of_them() {
        let check = |e: &str, used: &[u8]| {
            Mixes::of(&cfg(&[e]))
                .expect("parses")
                .check_used(used.iter().copied(), Some(2))
        };
        assert!(check("3:1,2:1,1", &[3]).is_ok());
        assert!(check("2:1,3:1,1", &[2]).is_err());
        assert!(check("3:1,4:1,1", &[3]).is_err());
        // A mix nothing uses is not checked, and without the loaded count nothing is.
        assert!(check("3:1,4:1,1", &[1]).is_ok());
        let m = Mixes::of(&cfg(&["3:1,4:1,1"])).expect("parses");
        assert!(m.check_used([3], None).is_ok());
    }

    #[test]
    fn an_entry_reads_into_its_number_filaments_and_ratio() {
        for (e, id, c, r) in [
            ("17:3,1:1,4:a: b", 17, [3, 1], [1, 4]),
            ("16:2,1:20,20:Teal, soft", 16, [2, 1], [20, 20]),
            (" 15 : 1 , 2 : 1 , 2 ", 15, [1, 2], [1, 2]),
        ] {
            let m = Mixes::of(&cfg(&[e])).expect("parses");
            assert_eq!(
                m.get(id),
                Some(&Mix {
                    id,
                    components: c,
                    ratio: r
                }),
                "{e}"
            );
        }
        // The setting may be one text instead of a list.
        let mut c = PrintConfig::default();
        c.raw.insert(KEY.to_owned(), serde_json::json!("18:1,2:2,1:One"));
        assert_eq!(
            Mixes::of(&c).expect("parses").get(18).map(|m| m.ratio),
            Some([2, 1])
        );
    }

    #[test]
    fn the_pattern_matches_the_app_s_vectors() {
        // The same vectors as packages/settings/js/mixed.test.ts, so the two rules cannot drift.
        for (ratio, want) in [
            ("1,1", "ABABAB"),
            ("2,1", "AABAAB"),
            ("3,2", "AABABAABAB"),
            ("1,2", "ABBABB"),
            ("20,20", "ABABAB"),
        ] {
            assert_eq!(
                pattern(&format!("18:1,2:{ratio}"), u32::try_from(want.len()).unwrap_or(0)),
                want,
                "{ratio}"
            );
        }
    }
}
