// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Splitting an Annex B access unit into NAL units.

/// The NAL units of an Annex B byte stream (start codes `00 00 01` or `00 00 00 01` removed).
pub(crate) fn units(stream: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= stream.len() {
        if stream.get(i..i + 3) == Some(&[0, 0, 1]) {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::with_capacity(starts.len());
    for (k, &s) in starts.iter().enumerate() {
        let mut end = starts.get(k + 1).map_or(stream.len(), |next| next - 3);
        // A four byte start code leaves a zero before the next unit.
        while end > s && stream.get(end - 1) == Some(&0) {
            end -= 1;
        }
        if let Some(u) = stream.get(s..end)
            && !u.is_empty()
        {
            out.push(u);
        }
    }
    out
}

/// The NAL unit type (low five bits of the header byte).
pub(crate) fn kind(unit: &[u8]) -> u8 {
    unit.first().map_or(0, |h| h & 0x1f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_three_and_four_byte_start_codes() {
        let s = [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5];
        let u = units(&s);
        assert_eq!(u, vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4, 5][..]]);
        assert_eq!(u.iter().map(|x| kind(x)).collect::<Vec<_>>(), vec![7, 8, 5]);
        assert!(units(&[1, 2, 3]).is_empty());
    }
}
