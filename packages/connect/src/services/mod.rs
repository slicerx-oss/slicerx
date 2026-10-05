// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Service plugins: inventory (Spoolman) and home automation (Home Assistant).
mod home_assistant;
mod spoolman;

pub use home_assistant::HomeAssistantPlugin;
pub use spoolman::SpoolmanPlugin;

pub(crate) fn strip_prefix<'a>(id: &str, tool: &'a str) -> &'a str {
    tool.strip_prefix(id)
        .and_then(|t| t.strip_prefix('.'))
        .unwrap_or(tool)
}
