//! How an engine is expected to handle contract unions in Rust: every variant
//! matched, no wildcard. A new variant in the contract must break this build.

use limen_contract::limen_core::{EffectOutcome, EffectResult, HttpFailureReason};

pub fn describe_outcome(outcome: &EffectOutcome) -> String {
    match outcome {
        EffectOutcome::Success { status, .. } => format!("success {}", status),
        EffectOutcome::Failure { reason, .. } => match reason {
            HttpFailureReason::Network => "network".to_string(),
            HttpFailureReason::Aborted => "aborted".to_string(),
            HttpFailureReason::InvalidResponse => "invalid response".to_string(),
            HttpFailureReason::TooLarge => "too large".to_string(),
        },
        EffectOutcome::Cancelled => "cancelled".to_string(),
        EffectOutcome::OutcomeUnknown => "unknown: reconcile before retrying".to_string(),
    }
}

pub fn describe_result(result: &EffectResult) -> String {
    match result {
        EffectResult::HttpResult { outcome, .. } => describe_outcome(outcome),
        EffectResult::StorageResult { .. } => "storage".to_string(),
        EffectResult::ClipboardResult { .. } => "clipboard".to_string(),
        EffectResult::NavigationResult { .. } => "navigation".to_string(),
        EffectResult::CapabilityResult { .. } => "capability".to_string(),
    }
}

fn main() {
    println!("{}", describe_outcome(&EffectOutcome::Cancelled));
}
