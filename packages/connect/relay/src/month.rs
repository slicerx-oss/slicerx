// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Calendar months in UTC, for the monthly traffic cap.

const DAY_MS: u64 = 86_400_000;

/// (year, month 1..=12) of a day count since 1970-01-01 (Howard Hinnant's civil calendar).
#[allow(
    clippy::cast_possible_wrap,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn civil_from_days(days: i64) -> (i64, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m as u32)
}

/// Days since 1970-01-01 of the first of a month.
fn days_from_civil(y: i64, m: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// A number that changes exactly when the UTC month does.
#[allow(
    clippy::cast_possible_wrap,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
pub fn key(now_ms: u64) -> u32 {
    let (y, m) = civil_from_days((now_ms / DAY_MS) as i64);
    (y * 12 + i64::from(m) - 1) as u32
}

/// Unix milliseconds when the next UTC month starts.
#[allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
pub fn next_start_ms(now_ms: u64) -> u64 {
    let (y, m) = civil_from_days((now_ms / DAY_MS) as i64);
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    days_from_civil(ny, nm) as u64 * DAY_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months_roll_over_at_utc_midnight_on_the_first() {
        // 2026-10-02T00:00:00Z
        let oct2 = 1_790_899_200_000;
        // 2026-11-01T00:00:00Z
        let nov1 = 1_793_491_200_000;
        assert_eq!(next_start_ms(oct2), nov1);
        assert_eq!(key(nov1 - 1), key(oct2));
        assert_eq!(key(nov1), key(oct2) + 1);
        // 2026-12-15 rolls into 2027-01-01T00:00:00Z.
        assert_eq!(next_start_ms(1_797_292_800_000), 1_798_761_600_000);
        // Leap day: 2028-02-29 to 2028-03-01T00:00:00Z.
        assert_eq!(next_start_ms(1_835_395_200_000), 1_835_481_600_000);
    }
}
