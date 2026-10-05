// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Hub events in, hub calls out, as JSON. The network client feeds [`Session::on_event`] every
//! event the hub sends and sends back what it returns.
use std::collections::{BTreeMap, HashMap};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};

use crate::change::Thumb;
use crate::decode::{DecodeError, decode};
use crate::detector::Detector;
use crate::mask::Mask;
use crate::policy::{Config, Policy, Seen, Verdict};
use crate::protocol::{Dismissed, Frame, Report};
use crate::quality::{Quality, assess};
use crate::resize::crop;

/// Counts of what happened to frames, for logs and the status page.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Counts {
    /// Frames received.
    pub frames: u64,
    /// Scored by the detector.
    pub scored: u64,
    /// Skipped as too dark, too bright or blurred.
    pub poor: u64,
    /// In a format there is no decoder for, or corrupt.
    pub undecodable: u64,
    /// Not looked at: first layers or just after a resume.
    pub quiet: u64,
    /// Findings reported.
    pub reports: u64,
}

/// The watch for one hub connection.
pub struct Session<D: Detector> {
    detector: D,
    policy: Policy,
    masks: HashMap<String, Mask>,
    counts: Counts,
    /// Per printer: the bed area's thumbnail of the last scored frame and when it was taken.
    thumbs: HashMap<String, (u64, Thumb)>,
    /// Per printer: the last scored frame as received (type and bytes), for a confirmation.
    /// Kept in memory only, replaced by the next frame.
    latest: HashMap<String, (String, Vec<u8>)>,
}

/// Milliseconds since the epoch from an ISO 8601 UTC time (`2026-10-01T20:00:00.000Z`).
fn iso_ms(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        std::str::from_utf8(bytes.get(range)?).ok()?.parse().ok()
    };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let millis = if bytes.get(19) == Some(&b'.') {
        num(20..23).unwrap_or(0)
    } else {
        0
    };
    // Days from civil (Howard Hinnant's algorithm).
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let yoe = shifted - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis).ok()
}

impl<D: Detector> Session<D> {
    /// A session with this detector and policy.
    pub fn new(detector: D, config: Config) -> Self {
        Self {
            detector,
            policy: Policy::new(config),
            masks: HashMap::new(),
            counts: Counts::default(),
            thumbs: HashMap::new(),
            latest: HashMap::new(),
        }
    }

    /// The last scored frame of a printer (content type and bytes), the one a confirmation
    /// looks at.
    pub fn latest_frame(&self, printer: &str) -> Option<(&str, &[u8])> {
        self.latest.get(printer).map(|(t, b)| (t.as_str(), b.as_slice()))
    }

    /// Sets a printer's bed mask (hub setting `watchMask`).
    pub fn set_mask(&mut self, printer: &str, mask: Mask) {
        self.masks.insert(printer.to_owned(), mask);
    }

    /// What happened so far.
    pub fn counts(&self) -> &Counts {
        &self.counts
    }

    /// One hub event (`{event, data}`). Returns the calls to make: `watch.report` params.
    pub fn on_event(&mut self, msg: &Value) -> Vec<Report> {
        let data = msg.get("data").cloned().unwrap_or(Value::Null);
        match msg.get("event").and_then(Value::as_str) {
            Some("watch.frame") => serde_json::from_value::<Frame>(data)
                .map(|f| self.on_frame(&f))
                .unwrap_or_default(),
            Some("watch.dismissed") => {
                if let Ok(d) = serde_json::from_value::<Dismissed>(data) {
                    self.policy.dismiss(&d.printer_id, d.kind);
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn on_frame(&mut self, f: &Frame) -> Vec<Report> {
        self.counts.frames += 1;
        if f.state.as_deref().is_some_and(|s| s != "printing") {
            return Vec::new();
        }
        let Some(now) = iso_ms(&f.captured_at) else {
            return Vec::new();
        };
        let bytes = B64.decode(&f.data_base64).map_err(|_| DecodeError::Corrupt);
        let seen = match bytes
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|b| decode(&f.content_type, b))
        {
            Err(_) => {
                self.counts.undecodable += 1;
                Seen::Skipped
            }
            Ok(rgb) if assess(&rgb.gray(), rgb.width, rgb.height) == Quality::Usable => {
                self.counts.scored += 1;
                let mask = self.masks.get(&f.printer_id).cloned().unwrap_or_else(Mask::whole);
                if let Ok(b) = bytes {
                    self.latest
                        .insert(f.printer_id.clone(), (f.content_type.clone(), b));
                }
                if self.detector.whole_image() {
                    let thumb = Thumb::of(&rgb, &mask);
                    let change = self
                        .thumbs
                        .get(&f.printer_id)
                        .filter(|(t, _)| now.saturating_sub(*t) <= self.policy.gap_ms())
                        .map(|(_, before)| thumb.change(before));
                    self.thumbs.insert(f.printer_id.clone(), (now, thumb));
                    let area = crop(&rgb, mask.bounds());
                    let mut scores = BTreeMap::new();
                    for d in self.detector.detect(&area) {
                        let s = scores.entry(d.kind).or_insert(0.0_f64);
                        *s = s.max(d.score);
                    }
                    Seen::Relative { scores, change }
                } else {
                    let mut best = BTreeMap::new();
                    for d in self.detector.detect(&rgb) {
                        let (x, y) = d.center();
                        if mask.contains(x, y) {
                            let s = best.entry(d.kind).or_insert(0.0_f64);
                            *s = s.max(d.score);
                        }
                    }
                    Seen::Scored(best)
                }
            }
            Ok(_) => {
                self.counts.poor += 1;
                Seen::Skipped
            }
        };
        match self
            .policy
            .observe(&f.printer_id, now, f.layer, f.layer_count, seen)
        {
            Verdict::Finding {
                kind,
                confidence,
                agreed,
                of,
            } => {
                self.counts.reports += 1;
                vec![Report {
                    printer_id: f.printer_id.clone(),
                    kind,
                    confidence,
                    note: format!("{agreed} of the last {of} frames, {}", self.detector.name()),
                    confirmed: None,
                }]
            }
            Verdict::Quiet => {
                self.counts.quiet += 1;
                Vec::new()
            }
            Verdict::Skipped | Verdict::Watching => Vec::new(),
        }
    }
}

/// The `watch.report` call for a report.
pub fn report_call(r: &Report) -> Value {
    json!({ "method": "watch.report", "params": r })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::Rgb;
    use crate::detector::{Detection, Stub};
    use crate::protocol::Kind;

    /// Sees spaghetti at a fixed spot in every frame.
    struct Always(f64, [f64; 4]);
    impl Detector for Always {
        fn name(&self) -> &'static str {
            "always"
        }
        fn detect(&self, _: &Rgb) -> Vec<Detection> {
            vec![Detection {
                kind: Kind::Spaghetti,
                score: self.0,
                bbox: self.1,
            }]
        }
    }

    fn png(level_a: u8, level_b: u8) -> String {
        let (w, h) = (64u32, 48u32);
        let mut raw = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let v = if (x / 8 + y / 8) % 2 == 0 {
                    level_a
                } else {
                    level_b
                };
                raw.extend_from_slice(&[v, v, v]);
            }
        }
        let mut out = Vec::new();
        {
            let mut e = png::Encoder::new(&mut out, w, h);
            e.set_color(png::ColorType::Rgb);
            e.set_depth(png::BitDepth::Eight);
            let mut wr = e.write_header().unwrap();
            wr.write_image_data(&raw).unwrap();
        }
        B64.encode(out)
    }

    fn frame(sec: u64, layer: u32, data: &str, kind: &str) -> Value {
        let (m, s) = (sec / 60, sec % 60);
        json!({ "event": "watch.frame", "data": {
            "subscription": 1, "printerId": "bay-1", "contentType": kind, "dataBase64": data,
            "capturedAt": format!("2026-10-01T20:{m:02}:{s:02}.000Z"), "source": "snapshot",
            "state": "printing", "layer": layer, "layerCount": 200
        } })
    }

    #[test]
    fn reads_iso_times() {
        assert_eq!(iso_ms("1970-01-01T00:00:01.250Z"), Some(1250));
        assert_eq!(
            iso_ms("2026-10-01T20:00:00.000Z").map(|t| t % 86_400_000),
            Some(72_000_000)
        );
    }

    #[test]
    fn reports_after_agreement_inside_the_mask() {
        let mut s = Session::new(Always(0.9, [0.4, 0.6, 0.5, 0.7]), Config::default());
        s.set_mask(
            "bay-1",
            Mask::new(vec![[0.0, 0.5], [1.0, 0.5], [1.0, 1.0], [0.0, 1.0]]),
        );
        let img = png(60, 200);
        let mut reports = Vec::new();
        // 0 s starts the print's quiet time; scoring begins at 30 s.
        for i in 0..7 {
            reports.extend(s.on_event(&frame(i * 10, 20, &img, "image/png")));
        }
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].kind, Kind::Spaghetti);
        assert!(reports[0].note.starts_with("3 of the last 5 frames, always"));
        let call = report_call(&reports[0]);
        assert_eq!(call["params"]["kind"], "spaghetti");
        assert_eq!(call["params"]["printerId"], "bay-1");
    }

    #[test]
    fn findings_outside_the_mask_never_count() {
        // The box sits in the purge chute at the top of the frame.
        let mut s = Session::new(Always(0.99, [0.0, 0.0, 0.1, 0.1]), Config::default());
        s.set_mask(
            "bay-1",
            Mask::new(vec![[0.0, 0.5], [1.0, 0.5], [1.0, 1.0], [0.0, 1.0]]),
        );
        let img = png(60, 200);
        let n: usize = (0..12)
            .map(|i| s.on_event(&frame(i * 10, 20, &img, "image/png")).len())
            .sum();
        assert_eq!(n, 0);
    }

    #[test]
    fn dark_and_undecodable_frames_are_skipped_and_counted() {
        let mut s = Session::new(Always(0.99, [0.4, 0.6, 0.5, 0.7]), Config::default());
        let dark = png(3, 15);
        let n: usize = (0..12)
            .map(|i| s.on_event(&frame(i * 10, 20, &dark, "image/png")).len())
            .sum();
        assert_eq!(n, 0);
        s.on_event(&frame(130, 20, "/9j/4AAQ", "image/jpeg"));
        assert_eq!(s.counts().undecodable, 1);
        assert!(s.counts().poor >= 8);
    }

    #[test]
    fn a_dismissal_from_the_hub_raises_the_bar() {
        let mut s = Session::new(Always(0.6, [0.4, 0.6, 0.5, 0.7]), Config::default());
        s.on_event(&json!({ "event": "watch.dismissed", "data": { "printerId": "bay-1", "kind": "spaghetti", "at": "2026-10-01T20:00:00.000Z" } }));
        let img = png(60, 200);
        let n: usize = (0..12)
            .map(|i| s.on_event(&frame(i * 10, 20, &img, "image/png")).len())
            .sum();
        assert_eq!(n, 0);
    }

    #[test]
    fn the_stub_reports_nothing() {
        let mut s = Session::new(Stub, Config::default());
        let img = png(60, 200);
        let n: usize = (0..12)
            .map(|i| s.on_event(&frame(i * 10, 20, &img, "image/png")).len())
            .sum();
        assert_eq!(n, 0);
        assert!(s.counts().scored > 0);
    }
}
