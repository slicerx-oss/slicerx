// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Snapmaker J1, J1S and Artisan speak SACP, a binary protocol on TCP 8888
//! (https://github.com/Snapmaker/Snapmaker-SACP). They are found by the `discover` broadcast, and a
//! connection says plainly that SACP is not supported yet, so setup can offer saving the G-code.
use std::time::Duration;

use crate::PrinterSession;
use crate::error::{Error, Result};
use crate::types::{PrinterConfig, Secrets};

const NOT_YET: &str =
    "the J1, J1S and Artisan protocol (SACP); save the G-code and print it from a USB drive";

pub(crate) fn open(_cfg: &PrinterConfig, _secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
    Err(Error::not_supported("snapmaker", NOT_YET))
}

pub(crate) fn authorize(_cfg: &PrinterConfig, _timeout: Duration) -> Result<Option<String>> {
    Err(Error::not_supported("snapmaker", NOT_YET))
}
