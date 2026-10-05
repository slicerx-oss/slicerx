// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! When a detection becomes a finding. One frame never does: the score of each kind must clear
//! its threshold in `agree` of the last `window` usable frames. Frames on the first layers, and
//! for a while after a print starts or resumes, are not scored. A person's "this is fine" raises
//! that printer's threshold for that kind until the print ends.
//!
//! A whole-frame model's scores ([`Seen::Relative`]) are not compared with a fixed bar. They
//! become a suspicion from 0 to 1 measured against the same print's first scored frames, so a
//! camera view that always looks a little like a failure to the model does not alarm on every
//! frame: what counts is a rise over how this print looked when it started, strengthened when
//! the bed area also changes more than it did then. See [`Relative`].
use std::collections::{BTreeMap, HashMap, VecDeque};

use crate::protocol::Kind;

/// The tuning knobs. Thresholds are set from measured false alarms and misses, not guessed;
/// these defaults are placeholders until the trained model is measured.
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// Usable frames looked at.
    pub window: usize,
    /// How many of them must agree.
    pub agree: usize,
    /// Score a kind must reach in a frame to count.
    pub threshold: BTreeMap<Kind, f64>,
    /// Added to a kind's threshold each time a person dismisses it, for the rest of the print.
    pub dismiss_raise: f64,
    /// Threshold never goes above this.
    pub threshold_cap: f64,
    /// Layers at the start not scored (the first layer and its purge line).
    pub quiet_layers: u32,
    /// Quiet time after a print starts or resumes, ms.
    pub quiet_after_resume_ms: u64,
    /// A gap between frames longer than this means the print paused or a new one started, ms.
    pub gap_ms: u64,
    /// How whole-frame scores become a suspicion.
    pub relative: Relative,
}

/// Scoring a whole-frame model against the print's own start. The suspicion of a frame is
/// `z / (1 + z)`, so `z = 1` sits exactly on the default threshold of 0.5:
///
/// - While the print's baseline is still being built (its first `baseline_frames` scored
///   frames), `z = score / start_bar`: only a frame the model is very sure about counts.
/// - After that, `z = min((score - start) / rise, score / floor)`, where `start` is the median
///   score of the baseline frames: the score must rise by `rise` over the print's start and
///   also reach `floor` on its own.
/// - The frame change (bed area against the frame before) multiplies `z` by up to
///   `1 + change_boost`, in full when it is `change_full` times the baseline's median change.
///   Change alone never makes a frame suspicious.
///
/// Baseline frames the model is already sure about (`score >= start_bar`) are left out of the
/// baseline, so a print that fails early does not teach the watch that failure is normal.
/// Measured on public images; false alarms on real printers are not measured yet.
#[derive(Debug, Clone, PartialEq)]
pub struct Relative {
    /// Scored frames that make up the print's baseline.
    pub baseline_frames: usize,
    /// Score needed during the baseline.
    pub start_bar: f64,
    /// Rise over the print's start needed afterwards.
    pub rise: f64,
    /// Score needed afterwards regardless of the start.
    pub floor: f64,
    /// Change, as a multiple of the baseline's median change, that gives the full boost.
    pub change_full: f64,
    /// The most the change can add, as a fraction of `z`.
    pub change_boost: f64,
}

impl Default for Relative {
    fn default() -> Self {
        Self {
            baseline_frames: 6,
            start_bar: 0.9,
            rise: 0.3,
            floor: 0.5,
            change_full: 3.0,
            change_boost: 0.5,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            window: 5,
            agree: 3,
            threshold: Kind::ALL.iter().map(|&k| (k, 0.5)).collect(),
            dismiss_raise: 0.15,
            threshold_cap: 0.95,
            quiet_layers: 1,
            quiet_after_resume_ms: 30_000,
            gap_ms: 35_000,
            relative: Relative::default(),
        }
    }
}

/// What a frame is to the policy, after the mask and quality checks.
#[derive(Debug, Clone, PartialEq)]
pub enum Seen {
    /// Not scored (dark, bright, blurred, undecodable).
    Skipped,
    /// The best score per kind among detections inside the bed mask.
    Scored(BTreeMap<Kind, f64>),
    /// A whole-frame model's score per kind for the bed area, and the change in the bed area
    /// since the previous scored frame (0 to 1), when there is one. Scored against the print's
    /// own start ([`Relative`]).
    Relative {
        /// Score per kind.
        scores: BTreeMap<Kind, f64>,
        /// Frame change, when the previous frame is recent.
        change: Option<f64>,
    },
}

/// The policy's answer for one frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// Not looked at: first layers or just after a resume.
    Quiet,
    /// Skipped for quality.
    Skipped,
    /// Scored, nothing agreed yet.
    Watching,
    /// Agreement reached: report this.
    Finding {
        /// What.
        kind: Kind,
        /// Mean score of the agreeing frames.
        confidence: f64,
        /// How many of how many frames agreed.
        agreed: usize,
        /// Window size.
        of: usize,
    },
}

#[derive(Debug, Default)]
struct Printer {
    last_frame_ms: Option<u64>,
    quiet_until_ms: u64,
    last_layer: Option<u32>,
    layer_count: Option<u32>,
    window: VecDeque<BTreeMap<Kind, f64>>,
    raised: BTreeMap<Kind, f64>,
    /// The print's baseline: scores per kind and frame changes from its first scored frames.
    base_scores: BTreeMap<Kind, Vec<f64>>,
    base_changes: Vec<f64>,
    base_frames: usize,
}

fn median(v: &[f64]) -> Option<f64> {
    let mut s = v.to_vec();
    s.sort_by(f64::total_cmp);
    let n = s.len();
    match n {
        0 => None,
        _ if n % 2 == 1 => s.get(n / 2).copied(),
        _ => Some(f64::midpoint(s.get(n / 2 - 1).copied()?, s.get(n / 2).copied()?)),
    }
}

impl Printer {
    /// Turns whole-frame scores into suspicions and grows the baseline.
    fn suspicion(
        &mut self,
        r: &Relative,
        scores: &BTreeMap<Kind, f64>,
        change: Option<f64>,
    ) -> BTreeMap<Kind, f64> {
        let building = self.base_frames < r.baseline_frames;
        let boost = match (change, median(&self.base_changes)) {
            (Some(c), Some(m)) if !building => {
                let ratio = c / m.max(0.002);
                1.0 + r.change_boost * ((ratio - 1.0) / (r.change_full - 1.0).max(1e-9)).clamp(0.0, 1.0)
            }
            _ => 1.0,
        };
        let out = scores
            .iter()
            .map(|(&kind, &s)| {
                let z = match (building, self.base_scores.get(&kind).and_then(|b| median(b))) {
                    (false, Some(start)) => ((s - start) / r.rise).min(s / r.floor),
                    _ => s / r.start_bar,
                };
                let z = z.max(0.0) * boost;
                (kind, z / (1.0 + z))
            })
            .collect();
        if building {
            self.base_frames += 1;
            for (&kind, &s) in scores {
                if s < r.start_bar {
                    self.base_scores.entry(kind).or_default().push(s);
                }
            }
            if let Some(c) = change {
                self.base_changes.push(c);
            }
        }
        out
    }
}

/// The policy for every printer.
#[derive(Debug, Default)]
pub struct Policy {
    config: Config,
    printers: HashMap<String, Printer>,
}

impl Policy {
    /// A policy with these knobs.
    pub fn new(config: Config) -> Self {
        Self {
            config,
            printers: HashMap::new(),
        }
    }

    /// The gap between frames that counts as a pause or a new print, ms.
    pub fn gap_ms(&self) -> u64 {
        self.config.gap_ms
    }

    /// The threshold for a kind on a printer, after dismissals.
    pub fn threshold(&self, printer: &str, kind: Kind) -> f64 {
        let base = self.config.threshold.get(&kind).copied().unwrap_or(0.5);
        let raised = self
            .printers
            .get(printer)
            .and_then(|p| p.raised.get(&kind))
            .copied()
            .unwrap_or(0.0);
        (base + raised).min(self.config.threshold_cap)
    }

    /// A person said a finding of this kind was fine.
    pub fn dismiss(&mut self, printer: &str, kind: Kind) {
        let raise = self.config.dismiss_raise;
        let p = self.printers.entry(printer.to_owned()).or_default();
        *p.raised.entry(kind).or_insert(0.0) += raise;
        p.window.clear();
    }

    /// Takes one frame of a printing printer at `now_ms`.
    pub fn observe(
        &mut self,
        printer: &str,
        now_ms: u64,
        layer: Option<u32>,
        layer_count: Option<u32>,
        seen: Seen,
    ) -> Verdict {
        let c = &self.config;
        let p = self.printers.entry(printer.to_owned()).or_default();
        // A new print: the layer went back or the job's layer count changed. Dismissals end.
        let new_print = matches!((p.last_layer, layer), (Some(was), Some(now)) if now < was)
            || (p.layer_count.is_some() && layer_count.is_some() && p.layer_count != layer_count);
        if new_print {
            p.raised.clear();
            p.base_scores.clear();
            p.base_changes.clear();
            p.base_frames = 0;
        }
        // A start or a resume: no frame for a while (the hub sends frames only while printing).
        let resumed = p
            .last_frame_ms
            .is_none_or(|t| now_ms.saturating_sub(t) > c.gap_ms);
        if resumed || new_print {
            p.quiet_until_ms = now_ms + c.quiet_after_resume_ms;
            p.window.clear();
        }
        p.last_frame_ms = Some(now_ms);
        p.last_layer = layer.or(p.last_layer);
        p.layer_count = layer_count.or(p.layer_count);

        if now_ms < p.quiet_until_ms || layer.is_some_and(|l| l <= c.quiet_layers) {
            return Verdict::Quiet;
        }
        let scores = match seen {
            Seen::Skipped => return Verdict::Skipped,
            Seen::Scored(scores) => scores,
            Seen::Relative { scores, change } => p.suspicion(&c.relative, &scores, change),
        };
        p.window.push_back(scores);
        while p.window.len() > c.window {
            p.window.pop_front();
        }
        let (window, agree) = (c.window, c.agree);
        for kind in Kind::ALL {
            let base = c.threshold.get(&kind).copied().unwrap_or(0.5);
            let th = (base + p.raised.get(&kind).copied().unwrap_or(0.0)).min(c.threshold_cap);
            let hits: Vec<f64> = p
                .window
                .iter()
                .filter_map(|s| s.get(&kind).copied())
                .filter(|&s| s >= th)
                .collect();
            if hits.len() >= agree {
                let confidence =
                    hits.iter().sum::<f64>() / f64::from(u32::try_from(hits.len()).unwrap_or(u32::MAX));
                // Start over, so one failure is one report; the hub also rate limits alerts.
                p.window.clear();
                return Verdict::Finding {
                    kind,
                    confidence,
                    agreed: hits.len(),
                    of: window,
                };
            }
        }
        Verdict::Watching
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1000;

    fn hit(score: f64) -> Seen {
        Seen::Scored([(Kind::Spaghetti, score)].into_iter().collect())
    }

    fn none() -> Seen {
        Seen::Scored(BTreeMap::new())
    }

    /// A printer that has been printing quietly for a while, at layer 10.
    fn warmed(p: &mut Policy) -> u64 {
        let mut t = 0;
        for _ in 0..5 {
            p.observe("bay-1", t, Some(10), Some(200), none());
            t += 10 * S;
        }
        t
    }

    #[test]
    fn one_frame_never_alarms_three_of_five_do() {
        let mut p = Policy::default();
        let mut t = warmed(&mut p);
        let mut verdicts = Vec::new();
        for s in [hit(0.9), none(), hit(0.7), hit(0.8)] {
            verdicts.push(p.observe("bay-1", t, Some(11), Some(200), s));
            t += 10 * S;
        }
        assert_eq!(verdicts[0], Verdict::Watching);
        assert_eq!(verdicts[2], Verdict::Watching);
        match &verdicts[3] {
            Verdict::Finding {
                kind,
                confidence,
                agreed,
                of,
            } => {
                assert_eq!((*kind, *agreed, *of), (Kind::Spaghetti, 3, 5));
                assert!((confidence - 0.8).abs() < 1e-9);
            }
            v => panic!("expected a finding, got {v:?}"),
        }
        // The window starts over: the next hit alone is not a second report.
        assert_eq!(
            p.observe("bay-1", t, Some(12), Some(200), hit(0.9)),
            Verdict::Watching
        );
    }

    #[test]
    fn skipped_frames_do_not_count_either_way() {
        let mut p = Policy::default();
        let mut t = warmed(&mut p);
        for s in [hit(0.9), Seen::Skipped, Seen::Skipped, hit(0.9)] {
            assert!(!matches!(
                p.observe("bay-1", t, Some(11), Some(200), s),
                Verdict::Finding { .. }
            ));
            t += 10 * S;
        }
        assert!(matches!(
            p.observe("bay-1", t, Some(11), Some(200), hit(0.9)),
            Verdict::Finding { .. }
        ));
    }

    #[test]
    fn quiet_on_the_first_layer_and_after_a_resume() {
        let mut p = Policy::default();
        // A new print: the first frame starts 30 s of quiet, and the first layer stays quiet.
        assert_eq!(
            p.observe("bay-1", 0, Some(0), Some(200), hit(0.99)),
            Verdict::Quiet
        );
        assert_eq!(
            p.observe("bay-1", 10 * S, Some(1), Some(200), hit(0.99)),
            Verdict::Quiet
        );
        assert_eq!(
            p.observe("bay-1", 20 * S, Some(2), Some(200), hit(0.99)),
            Verdict::Quiet
        );
        assert_eq!(
            p.observe("bay-1", 30 * S, Some(2), Some(200), hit(0.99)),
            Verdict::Watching
        );
        // Paused for two minutes (no frames), then resumed: quiet again for 30 s.
        assert_eq!(
            p.observe("bay-1", 150 * S, Some(3), Some(200), hit(0.99)),
            Verdict::Quiet
        );
        assert_eq!(
            p.observe("bay-1", 160 * S, Some(3), Some(200), hit(0.99)),
            Verdict::Quiet
        );
        assert_eq!(
            p.observe("bay-1", 180 * S, Some(3), Some(200), hit(0.99)),
            Verdict::Watching
        );
    }

    #[test]
    fn a_dismissal_raises_the_bar_until_the_next_print() {
        let mut p = Policy::default();
        let mut t = warmed(&mut p);
        p.dismiss("bay-1", Kind::Spaghetti);
        assert!((p.threshold("bay-1", Kind::Spaghetti) - 0.65).abs() < 1e-9);
        assert!((p.threshold("bay-2", Kind::Spaghetti) - 0.5).abs() < 1e-9);
        for _ in 0..5 {
            assert_eq!(
                p.observe("bay-1", t, Some(11), Some(200), hit(0.6)),
                Verdict::Watching
            );
            t += 10 * S;
        }
        // A new print (layer count changed) clears it.
        p.observe("bay-1", t, Some(0), Some(80), none());
        assert!((p.threshold("bay-1", Kind::Spaghetti) - 0.5).abs() < 1e-9);
    }

    fn rel(score: f64, change: f64) -> Seen {
        Seen::Relative {
            scores: [(Kind::Spaghetti, score)].into_iter().collect(),
            change: Some(change),
        }
    }

    /// A print whose view the model always finds a bit like spaghetti (0.7) never alarms on it,
    /// though a fixed 0.5 bar would fire on every frame; a real rise does.
    #[test]
    fn whole_frame_scores_count_against_the_print_start() {
        let mut p = Policy::default();
        let mut t = 0;
        let mut findings = 0;
        for _ in 0..30 {
            if matches!(
                p.observe("bay-1", t, Some(10), Some(200), rel(0.7, 0.02)),
                Verdict::Finding { .. }
            ) {
                findings += 1;
            }
            t += 10 * S;
        }
        assert_eq!(findings, 0);
        let mut verdicts = Vec::new();
        for _ in 0..3 {
            verdicts.push(p.observe("bay-1", t, Some(11), Some(200), rel(0.99, 0.06)));
            t += 10 * S;
        }
        assert!(matches!(verdicts[2], Verdict::Finding { .. }), "{verdicts:?}");
    }

    #[test]
    fn change_strengthens_but_never_decides_alone() {
        let r = Relative::default();
        let mut quiet = Printer::default();
        let mut moving = Printer::default();
        for _ in 0..r.baseline_frames {
            quiet.suspicion(&r, &[(Kind::Spaghetti, 0.2)].into_iter().collect(), Some(0.02));
            moving.suspicion(&r, &[(Kind::Spaghetti, 0.2)].into_iter().collect(), Some(0.02));
        }
        let at = |p: &mut Printer, s: f64, c: f64| {
            p.suspicion(&r, &[(Kind::Spaghetti, s)].into_iter().collect(), Some(c))[&Kind::Spaghetti]
        };
        // A modest rise is below the bar without change and above it with three times the change.
        assert!(at(&mut quiet, 0.45, 0.02) < 0.5);
        assert!(at(&mut moving, 0.45, 0.06) >= 0.5);
        // No rise: change does nothing.
        assert!(at(&mut moving, 0.2, 0.5) < 0.01);
    }

    #[test]
    fn an_early_failure_is_not_learned_as_normal() {
        let mut p = Policy::default();
        let mut t = 0;
        let mut found = false;
        for _ in 0..10 {
            found |= matches!(
                p.observe("bay-1", t, Some(10), Some(200), rel(0.97, 0.05)),
                Verdict::Finding { .. }
            );
            t += 10 * S;
        }
        assert!(found);
    }

    #[test]
    fn printers_are_judged_apart() {
        let mut p = Policy::default();
        let mut t = warmed(&mut p);
        for _ in 0..5 {
            p.observe("bay-2", t, Some(10), Some(100), none());
            t += 10 * S;
        }
        for _ in 0..3 {
            p.observe("bay-1", t, Some(11), Some(200), hit(0.9));
            assert_eq!(
                p.observe("bay-2", t, Some(11), Some(100), none()),
                Verdict::Watching
            );
            t += 10 * S;
        }
    }
}
