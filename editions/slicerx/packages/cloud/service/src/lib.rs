// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx-cloud`: the `SlicerX` cloud slicing service.
//!
//! An HTTP API ([`http`]) takes plates from API tokens and signed-in
//! sessions, queues them in Supabase, and workers ([`worker`]) slice them
//! with `sx-core` and store the G-code and SXPV preview. A job that targets
//! a printer is offered to the user's sx-link bridge, which pulls it over an
//! outbound connection and asks the user before anything reaches the printer.

pub mod backend;
pub mod error;
pub mod http;
pub mod idle;
pub mod memory;
pub mod scan_worker;
pub mod supabase;
pub mod worker;

pub use backend::{Backend, CloudQuota, Principal};
pub use error::{Error, Result};
pub use http::{App, router};
pub use memory::MemoryBackend;
pub use supabase::SupabaseBackend;
pub use worker::{WorkerConfig, sha256_hex};
