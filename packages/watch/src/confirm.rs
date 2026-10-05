// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Confirmation by huginn: when the local watch agrees on a failure, one frame (the last scored
//! one) goes to huginn (gpt-5.6-luna) on the person's own ChatGPT plan with one fixed question,
//! "has this print failed?". Never continuously, only on a finding, and only for printers the
//! person turned it on for, because the frame then leaves their network. The hub auto-pauses
//! only when huginn agreed; without confirmation a finding notifies and nothing more.
use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;

/// The answer, or why there is none.
pub type Answer<'a> = Pin<Box<dyn Future<Output = Result<bool, String>> + Send + 'a>>;

/// Something that can look at one frame and say whether the print failed.
pub trait Confirm: Send + Sync {
    /// Name for notes and logs.
    fn name(&self) -> &str;
    /// True when the print in this frame has failed.
    fn confirm<'a>(&'a self, content_type: &'a str, bytes: &'a [u8]) -> Answer<'a>;
}

/// Which printers are confirmed, and by what.
pub struct Confirmation {
    /// Printer ids the person turned confirmation on for. Every other printer's frames stay
    /// on the network.
    pub printers: BTreeSet<String>,
    /// Who answers.
    pub by: Box<dyn Confirm>,
}

/// What the person is told when turning confirmation on, and what sx-watch prints at start.
pub fn plain_statement(model: &str, printers: &BTreeSet<String>) -> String {
    let list: Vec<&str> = printers.iter().map(String::as_str).collect();
    format!(
        "huginn confirmation is on for {}. When the watch suspects a failure there, one camera frame is sent to ChatGPT ({model}) on your plan to ask whether the print failed. Only a confirmed failure can auto-pause a print. Frames are never sent otherwise.",
        list.join(", ")
    )
}

/// huginn on the ChatGPT plan saved in the keychain.
#[cfg(feature = "huginn")]
pub struct Huginn {
    /// The model huginn uses on the plan.
    pub model: String,
}

#[cfg(feature = "huginn")]
impl Confirm for Huginn {
    fn name(&self) -> &'static str {
        "huginn"
    }

    fn confirm<'a>(&'a self, content_type: &'a str, bytes: &'a [u8]) -> Answer<'a> {
        Box::pin(async move {
            let endpoints = sx_llm::chatgpt::Endpoints::openai().map_err(|e| e.to_string())?;
            sx_llm::chatgpt::judge_frame(
                &sx_llm::SystemKeySource,
                &endpoints,
                &self.model,
                content_type,
                bytes,
            )
            .await
            .map(|v| v.failed)
            .map_err(|e| e.to_string())
        })
    }
}
