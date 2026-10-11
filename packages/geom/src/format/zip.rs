// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! zip archives: the central directory, entries read whole or as they inflate

use crate::error::{Error, Result};
use miniz_oxide::inflate::stream::{InflateState, inflate};
use miniz_oxide::{DataFormat, MZError, MZFlush, MZStatus};

/// largest entry inflated, against zip bombs
pub const MAX_ENTRY: usize = 1 << 30;
const MAX_ENTRIES: usize = 1 << 16;
const CHUNK: usize = 1 << 18;

pub struct Zip<'a> {
    data: &'a [u8],
    entries: Vec<Entry>,
}

struct Entry {
    name: String,
    method: u16,
    compressed: usize,
    size: usize,
    offset: usize,
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2)
        .and_then(|s| s.try_into().ok())
        .map(u16::from_le_bytes)
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4)
        .and_then(|s| s.try_into().ok())
        .map(u32::from_le_bytes)
}

fn u64_at(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 8)
        .and_then(|s| s.try_into().ok())
        .map(u64::from_le_bytes)
}

fn bad(why: impl Into<String>) -> Error {
    Error::invalid("3mf", why)
}

impl<'a> Zip<'a> {
    pub fn open(data: &'a [u8]) -> Result<Self> {
        let not_zip = || bad("not a ZIP archive (3MF files are ZIP)");
        let min = data.len().checked_sub(22).ok_or_else(not_zip)?;
        let eocd = (min.saturating_sub(65_535)..=min)
            .rev()
            .find(|&i| u32_at(data, i) == Some(0x0605_4b50))
            .ok_or_else(not_zip)?;
        let mut count = usize::from(u16_at(data, eocd + 10).ok_or_else(not_zip)?);
        let mut at = u32_at(data, eocd + 16).ok_or_else(not_zip)? as usize;
        if at == 0xFFFF_FFFF || count == 0xFFFF {
            // zip64: the locator before the end record points at the 64-bit one
            let loc = eocd.checked_sub(20).ok_or_else(not_zip)?;
            if u32_at(data, loc) != Some(0x0706_4b50) {
                return Err(bad("broken ZIP64 locator"));
            }
            let rec = u64_at(data, loc + 8)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(not_zip)?;
            if u32_at(data, rec) != Some(0x0606_4b50) {
                return Err(bad("broken ZIP64 end record"));
            }
            count = u64_at(data, rec + 32)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(not_zip)?;
            at = u64_at(data, rec + 48)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(not_zip)?;
        }
        if count > MAX_ENTRIES {
            return Err(bad("the archive has too many entries"));
        }
        let mut entries = Vec::with_capacity(count);
        for _ in 0..count {
            if u32_at(data, at) != Some(0x0201_4b50) {
                return Err(bad("broken ZIP central directory"));
            }
            let method = u16_at(data, at + 10).ok_or_else(not_zip)?;
            let mut compressed = u32_at(data, at + 20).ok_or_else(not_zip)? as usize;
            let mut size = u32_at(data, at + 24).ok_or_else(not_zip)? as usize;
            let name_len = usize::from(u16_at(data, at + 28).ok_or_else(not_zip)?);
            let extra_len = usize::from(u16_at(data, at + 30).ok_or_else(not_zip)?);
            let comment_len = usize::from(u16_at(data, at + 32).ok_or_else(not_zip)?);
            let mut offset = u32_at(data, at + 42).ok_or_else(not_zip)? as usize;
            let name = data.get(at + 46..at + 46 + name_len).ok_or_else(not_zip)?;
            let name = String::from_utf8_lossy(name).into_owned();
            // zip64 extra field: 64-bit values for the fields that are all ones, in this order
            let extra = data
                .get(at + 46 + name_len..at + 46 + name_len + extra_len)
                .unwrap_or(&[]);
            let mut e = 0;
            while let (Some(id), Some(len)) = (u16_at(extra, e), u16_at(extra, e + 2)) {
                if id == 1 {
                    let body = extra.get(e + 4..e + 4 + usize::from(len)).unwrap_or(&[]);
                    let mut f = 0;
                    for v in [&mut size, &mut compressed, &mut offset] {
                        if *v == 0xFFFF_FFFF
                            && let Some(x) = u64_at(body, f).and_then(|x| usize::try_from(x).ok())
                        {
                            *v = x;
                            f += 8;
                        }
                    }
                }
                e += 4 + usize::from(len);
            }
            entries.push(Entry {
                name,
                method,
                compressed,
                size,
                offset,
            });
            at += 46 + name_len + extra_len + comment_len;
        }
        Ok(Self { data, entries })
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|e| e.name.as_str())
    }

    pub fn has(&self, name: &str) -> bool {
        self.entry(name).is_some()
    }

    fn entry(&self, name: &str) -> Option<&Entry> {
        let name = name.trim_start_matches('/');
        self.entries
            .iter()
            .find(|e| e.name == name)
            .or_else(|| self.entries.iter().find(|e| e.name.eq_ignore_ascii_case(name)))
    }

    fn raw(&self, name: &str) -> Result<(&Entry, &'a [u8])> {
        let e = self
            .entry(name)
            .ok_or_else(|| bad(format!("{name} is missing from the archive")))?;
        if e.size > MAX_ENTRY {
            return Err(bad(format!("{name} is too large")));
        }
        let h = e.offset;
        if u32_at(self.data, h) != Some(0x0403_4b50) {
            return Err(bad(format!("{name}: broken local header")));
        }
        let name_len = usize::from(u16_at(self.data, h + 26).unwrap_or(0));
        let extra_len = usize::from(u16_at(self.data, h + 28).unwrap_or(0));
        let start = h + 30 + name_len + extra_len;
        let raw = self
            .data
            .get(start..start + e.compressed)
            .ok_or_else(|| bad(format!("{name}: truncated")))?;
        Ok((e, raw))
    }

    /// the whole entry
    pub fn read(&self, name: &str) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        self.stream(name, |b| {
            out.extend_from_slice(b);
            Ok(())
        })?;
        Ok(out)
    }

    /// the entry in pieces as it inflates, so a big model part is never whole in memory
    pub fn stream(&self, name: &str, mut sink: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
        let (e, raw) = self.raw(name)?;
        match e.method {
            0 => {
                for piece in raw.chunks(CHUNK) {
                    sink(piece)?;
                }
                Ok(())
            }
            8 => {
                let mut state = InflateState::new_boxed(DataFormat::Raw);
                let mut out = vec![0u8; CHUNK];
                let mut input = raw;
                let mut total = 0usize;
                loop {
                    let r = inflate(&mut state, input, &mut out, MZFlush::None);
                    input = input.get(r.bytes_consumed..).unwrap_or(&[]);
                    total += r.bytes_written;
                    // the declared size is the limit: an entry that inflates past it is refused
                    if total > e.size.max(1) {
                        return Err(bad(format!("{name} inflates past its size")));
                    }
                    if let Some(piece) = out.get(..r.bytes_written)
                        && !piece.is_empty()
                    {
                        sink(piece)?;
                    }
                    match r.status {
                        Ok(MZStatus::StreamEnd) => return Ok(()),
                        Ok(_) | Err(MZError::Buf) => {
                            if r.bytes_consumed == 0 && r.bytes_written == 0 {
                                return Err(bad(format!("{name}: truncated deflate data")));
                            }
                        }
                        Err(err) => return Err(bad(format!("{name}: deflate error {err:?}"))),
                    }
                }
            }
            m => Err(bad(format!("{name}: compression method {m} is not supported"))),
        }
    }
}
