// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
use serde::Serialize;

/// The one error type of the crate. Messages never carry secrets: constructors take the
/// printer id and a plain description, never a URL with credentials or a header value.
#[derive(Debug, Clone, thiserror::Error)]
pub enum Error {
    #[error("printer {printer} is unreachable: {detail}")]
    Unreachable { printer: String, detail: String },
    #[error("printer {printer} rejected the credentials")]
    Auth { printer: String },
    /// The printer refused the sign-in and said why, so the fix shown can match.
    #[error("printer {printer} {}", need.words())]
    Login { printer: String, need: LoginNeed },
    /// The secure connection could not be set up: a certificate or TLS failure, not a missing printer.
    #[error("printer {printer} answered, but the secure connection failed: {detail}")]
    Tls { printer: String, detail: String },
    /// Nothing came back in time.
    #[error("printer {printer} did not answer in time: {detail}")]
    Timeout { printer: String, detail: String },
    #[error("{what} is not supported by {plugin}")]
    NotSupported { plugin: String, what: String },
    #[error("{action} needs an approval token")]
    ApprovalRequired { action: String },
    #[error("approval token rejected for {action}: {detail}")]
    ApprovalInvalid { action: String, detail: String },
    #[error("{what} not found on {printer}")]
    NotFound { printer: String, what: String },
    #[error("printer {printer} is {state}, cannot {action}")]
    BadState {
        printer: String,
        state: String,
        action: String,
    },
    #[error("protocol error from {printer}: {detail}")]
    Protocol { printer: String, detail: String },
    /// The printer answered a start with a refusal. `reason` is the printer's own reason in plain words.
    #[error("printer {printer} refused the print: {reason}")]
    Refused { printer: String, reason: String },
    /// A Bambu Lab printer sends status but takes no prints or commands from other apps. `sure` is
    /// true when the printer said so: its report's `fun` flags say Developer Mode is off, or it
    /// answered a command with the unsigned-command refusal. False when it is read from what the
    /// printer did (an upload that failed or a start left unanswered while status kept coming), so
    /// the words say "may". The remedies are LAN Only Mode plus Developer Mode, or Bambu Connect.
    #[error("printer {printer} {}: {reason}", if *sure { "takes no prints from other apps" } else { "may need Developer Mode to take prints from this app" })]
    NeedsDeveloperMode {
        printer: String,
        reason: String,
        sure: bool,
    },
    /// The printer's storage (its SD card or internal storage) has no room for the file: its FTP
    /// server answered the upload with a storage reply (452 or 552).
    #[error("printer {printer} has no room for the file: {reason}")]
    StorageFull { printer: String, reason: String },
    #[error("bad configuration: {0}")]
    Config(String),
    /// The printer has a camera but it does not stream. `reason` is one plain line saying what to change.
    #[error("{reason}")]
    Camera { printer: String, reason: String },
    /// A remote tunnel (Obico) answered for the printer with one of its own refusals.
    #[error("printer {printer} {}", problem.words())]
    Tunnel { printer: String, problem: TunnelProblem },
}

/// What a remote tunnel said went wrong, from its own status codes (Obico's tunnel guide: 401, 481,
/// 482 and 483), or what the app found before sending anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelProblem {
    /// No tunnel credential is stored on this computer for the printer.
    NoAccess,
    /// 401: the access was revoked, or the printer or account was removed in Obico.
    AccessRemoved,
    /// 481: this month's free tunnel data is used up.
    DataLimit,
    /// The file is larger than what is left of this month's free tunnel data.
    FileOverDataLimit,
    /// 482: the printer's Obico plugin is not connected to Obico.
    NotConnected,
    /// 483: the printer's Obico plugin is connected but did not answer within 30 seconds.
    TimedOut,
}

impl TunnelProblem {
    fn words(self) -> &'static str {
        match self {
            TunnelProblem::NoAccess => {
                "has no Obico access stored on this computer: connect it through Obico again"
            }
            TunnelProblem::AccessRemoved => {
                "lost its Obico access (it was revoked, or the printer or account was removed in Obico): connect it through Obico again"
            }
            TunnelProblem::DataLimit => {
                "has used this month's free Obico tunnel data, so Obico passes nothing more until the monthly reset"
            }
            TunnelProblem::FileOverDataLimit => {
                "has too little of this month's free Obico tunnel data left for this file"
            }
            TunnelProblem::NotConnected => {
                "is not connected to Obico right now: check that the printer is on and its Obico plugin is online"
            }
            TunnelProblem::TimedOut => "did not answer through Obico within 30 seconds",
        }
    }
}

/// Why a printer refused a sign-in, when it says (Moonraker `/access/info`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginNeed {
    /// No key was sent and the server does not trust this computer (`trusted_clients`).
    NotTrusted,
    /// The key that was sent is not the server's.
    KeyWrong,
    /// The server wants a user login (`force_logins`, Fluidd accounts, Snapmaker U1 Require Login).
    LoginRequired,
    /// The printer forgot its pairing (a Snapmaker 2.0 loses its tokens when powered off).
    PairAgain,
    /// The request was turned down on the printer's own screen.
    Declined,
    /// The printer is in cloud mode and takes no local connection (Anycubic LAN Mode is off).
    LanModeOff,
}

impl LoginNeed {
    fn words(self) -> &'static str {
        match self {
            LoginNeed::NotTrusted => {
                "does not trust this computer: enter its API key, or add this computer to trusted_clients in moonraker.conf"
            }
            LoginNeed::KeyWrong => "rejected the API key",
            LoginNeed::LoginRequired => {
                "asks for a user login: enter its API key, which works with logins required"
            }
            LoginNeed::PairAgain => {
                "forgot its pairing with this computer (it was turned off): pair it again on its touchscreen"
            }
            LoginNeed::Declined => "turned the connection down on its touchscreen",
            LoginNeed::LanModeOff => {
                "is in cloud mode: turn on LAN Mode in its network settings (this removes it from the maker's cloud account)"
            }
        }
    }
}

/// Codes shared with `PrinterErrorCode` in `packages/contracts/src/printers.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unreachable,
    Auth,
    Tls,
    Timeout,
    NotSupported,
    ApprovalRequired,
    ApprovalInvalid,
    NotFound,
    BadState,
    Protocol,
    Refused,
    NeedsDeveloperMode,
    /// The printer's storage is full; serialized as `printer_storage_full`.
    #[serde(rename = "printer_storage_full")]
    StorageFull,
    /// A remote tunnel's monthly data allowance is used up, or too little is left for a file.
    TunnelDataLimit,
}

impl Error {
    pub fn code(&self) -> ErrorCode {
        match self {
            Error::Unreachable { .. } => ErrorCode::Unreachable,
            Error::Auth { .. } | Error::Login { .. } => ErrorCode::Auth,
            Error::Tls { .. } => ErrorCode::Tls,
            Error::Timeout { .. } => ErrorCode::Timeout,
            Error::NotSupported { .. } | Error::Camera { .. } => ErrorCode::NotSupported,
            Error::ApprovalRequired { .. } => ErrorCode::ApprovalRequired,
            Error::ApprovalInvalid { .. } => ErrorCode::ApprovalInvalid,
            Error::NotFound { .. } => ErrorCode::NotFound,
            Error::BadState { .. } => ErrorCode::BadState,
            Error::Protocol { .. } | Error::Config(_) => ErrorCode::Protocol,
            Error::Refused { .. } => ErrorCode::Refused,
            Error::NeedsDeveloperMode { .. } => ErrorCode::NeedsDeveloperMode,
            Error::StorageFull { .. } => ErrorCode::StorageFull,
            Error::Tunnel { problem, .. } => match problem {
                TunnelProblem::NoAccess | TunnelProblem::AccessRemoved => ErrorCode::Auth,
                TunnelProblem::DataLimit | TunnelProblem::FileOverDataLimit => ErrorCode::TunnelDataLimit,
                TunnelProblem::NotConnected => ErrorCode::Unreachable,
                TunnelProblem::TimedOut => ErrorCode::Timeout,
            },
        }
    }

    /// Why the sign-in was refused, when the printer said.
    pub fn login_need(&self) -> Option<LoginNeed> {
        match self {
            Error::Login { need, .. } => Some(*need),
            _ => None,
        }
    }

    /// What a remote tunnel refused, for a tunnel error.
    pub fn tunnel_problem(&self) -> Option<TunnelProblem> {
        match self {
            Error::Tunnel { problem, .. } => Some(*problem),
            _ => None,
        }
    }

    pub(crate) fn tunnel(printer: &str, problem: TunnelProblem) -> Self {
        Error::Tunnel {
            printer: printer.to_owned(),
            problem,
        }
    }

    pub(crate) fn unreachable(printer: &str, detail: impl std::fmt::Display) -> Self {
        Error::Unreachable {
            printer: printer.to_owned(),
            detail: crate::tunnel::redact_userinfo(&detail.to_string()),
        }
    }

    pub(crate) fn tls(printer: &str, detail: impl std::fmt::Display) -> Self {
        Error::Tls {
            printer: printer.to_owned(),
            detail: crate::tunnel::redact_userinfo(&detail.to_string()),
        }
    }

    pub(crate) fn timeout(printer: &str, detail: impl std::fmt::Display) -> Self {
        Error::Timeout {
            printer: printer.to_owned(),
            detail: crate::tunnel::redact_userinfo(&detail.to_string()),
        }
    }

    pub(crate) fn protocol(printer: &str, detail: impl std::fmt::Display) -> Self {
        Error::Protocol {
            printer: printer.to_owned(),
            detail: crate::tunnel::redact_userinfo(&detail.to_string()),
        }
    }

    pub(crate) fn not_supported(plugin: &str, what: &str) -> Self {
        Error::NotSupported {
            plugin: plugin.to_owned(),
            what: what.to_owned(),
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
