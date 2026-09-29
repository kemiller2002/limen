//! The minimal engine: a capability probe, specified language-neutrally in
//! conformance/sessions/minimal-engine.md. Pure state and transitions; every
//! union matched exhaustively.

#![forbid(unsafe_code)]
#![deny(warnings)]

use std::collections::BTreeMap;

use limen_contract::limen_core::{
    parse_browser_to_engine_message, serialize_engine_to_browser_message, BrowserToEngineMessage, CapabilityId, ClipboardEffectRequest, ClipboardOutcome,
    CorrelationId, EffectOutcome, EffectRequest, EffectResult, EngineHandshake, EngineToBrowserMessage, HttpEffectRequest, HttpMethod, NavigationEffectRequest,
    NavigationOutcome, StorageEffectRequest, StorageOutcome, ViewPrimitive, ViewState, ViewValue,
};
use limen_guest::{answer, Requirements};

/// The minimal engine speaks protocol 1.1, as its specification says
/// (conformance/sessions/minimal-engine.md): it uses none of 1.2's
/// form-control state, so a 1.2 kernel never sends it those fields.
fn minimal_requirements() -> Requirements {
    Requirements { protocol: limen_contract::limen_core::ProtocolRevision { major: 1, minor: 1 }, ..Requirements::core_only() }
}

const LOG_LIMIT: usize = 20;

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum State {
    Ready { log: Vec<Entry>, last_id: u64, next: u64, pending: BTreeMap<String, String> },
    Incompatible,
}

impl State {
    pub fn initial() -> State {
        State::Ready { log: Vec::new(), last_id: 0, next: 1, pending: BTreeMap::new() }
    }
}

fn record(state: State, text: String) -> State {
    match state {
        State::Ready { log, last_id, next, pending } => {
            let appended: Vec<Entry> = log.into_iter().chain(std::iter::once(Entry { id: last_id + 1, text })).collect();
            let skip = appended.len().saturating_sub(LOG_LIMIT);
            State::Ready { log: appended.into_iter().skip(skip).collect(), last_id: last_id + 1, next, pending }
        }
        State::Incompatible => State::Incompatible,
    }
}

pub fn project(state: &State) -> ViewState {
    let (status, log): (&str, &[Entry]) = match state {
        State::Ready { log, .. } => ("ready", log),
        State::Incompatible => ("incompatible", &[]),
    };
    BTreeMap::from([
        ("status".to_string(), ViewValue::Text(status.to_string())),
        ("count".to_string(), ViewValue::Number(log.len() as f64)),
        (
            "log".to_string(),
            ViewValue::Items(
                log.iter()
                    .map(|entry| BTreeMap::from([("id".to_string(), ViewPrimitive::Text(entry.id.to_string())), ("text".to_string(), ViewPrimitive::Text(entry.text.clone()))]))
                    .collect(),
            ),
        ),
    ])
}

fn request(label: &str, id: CorrelationId) -> Option<EffectRequest> {
    let http = |url: &str| Some(EffectRequest::Http(HttpEffectRequest { correlation_id: id.clone(), method: HttpMethod::Get, url: url.to_string(), headers: None, body: None, timeout_ms: 5000, response: None, response_headers: None, credentials: None, xsrf: None }));
    match label {
        "http-ok" => http("/ok.json"),
        "http-missing" => http("/missing.json"),
        "storage-set" => Some(EffectRequest::Storage(StorageEffectRequest::Set { correlation_id: id, key: "limen-minimal".to_string(), value: "saved".to_string() })),
        "storage-get" => Some(EffectRequest::Storage(StorageEffectRequest::Get { correlation_id: id, key: "limen-minimal".to_string() })),
        "clipboard" => Some(EffectRequest::Clipboard(ClipboardEffectRequest { correlation_id: id, text: "limen".to_string() })),
        "nav-push" => Some(EffectRequest::Navigation(NavigationEffectRequest::Push { correlation_id: id, url: "?screen=two".to_string() })),
        "nav-away" => Some(EffectRequest::Navigation(NavigationEffectRequest::Push { correlation_id: id, url: "https://example.org/elsewhere".to_string() })),
        _ => None,
    }
}

pub fn describe(result: &EffectResult) -> String {
    match result {
        EffectResult::HttpResult { outcome, .. } => match outcome {
            EffectOutcome::Success { status, .. } => format!("success {}", status),
            EffectOutcome::Failure { reason, status: Some(status) } => format!("failure {} {}", reason.as_wire(), status),
            EffectOutcome::Failure { reason, status: None } => format!("failure {}", reason.as_wire()),
            EffectOutcome::Cancelled => "cancelled".to_string(),
            EffectOutcome::OutcomeUnknown { .. } => "unknown".to_string(),
        },
        EffectResult::StorageResult { outcome, .. } => match outcome {
            StorageOutcome::Success { value: Some(value) } => format!("success {}", value),
            StorageOutcome::Success { value: None } => "success null".to_string(),
            StorageOutcome::Failure { reason } => format!("failure {}", reason.as_wire()),
        },
        EffectResult::ClipboardResult { outcome, .. } => match outcome {
            ClipboardOutcome::Success => "success".to_string(),
            ClipboardOutcome::Failure { reason } => format!("failure {}", reason.as_wire()),
        },
        EffectResult::NavigationResult { outcome, .. } => match outcome {
            NavigationOutcome::Success { location } => format!("success {}{}", location.path, location.query),
            NavigationOutcome::Dispatched => "dispatched".to_string(),
            NavigationOutcome::Failure { reason } => format!("failure {}", reason.as_wire()),
        },
        EffectResult::CapabilityResult { .. } => "unexpected capability result".to_string(),
    }
}

fn correlation_of(result: &EffectResult) -> &str {
    match result {
        EffectResult::HttpResult { correlation_id, .. }
        | EffectResult::StorageResult { correlation_id, .. }
        | EffectResult::ClipboardResult { correlation_id, .. }
        | EffectResult::NavigationResult { correlation_id, .. }
        | EffectResult::CapabilityResult { correlation_id, .. } => &correlation_id.0,
    }
}

fn respond(state: State, effects: Vec<EffectRequest>, handshake: Option<EngineHandshake>) -> (State, EngineToBrowserMessage) {
    let view = project(&state);
    (state, EngineToBrowserMessage { view, effects, cancellations: Vec::new(), handshake })
}

/// One transition: the state after the message, and the response to send.
pub fn handle(state: State, message: &BrowserToEngineMessage) -> (State, EngineToBrowserMessage) {
    let State::Ready { next, ref pending, .. } = state else {
        return respond(State::Incompatible, Vec::new(), None);
    };
    match message {
        BrowserToEngineMessage::Initialize { handshake, .. } => match answer(handshake.as_ref(), &minimal_requirements()) {
            accepted @ EngineHandshake::Accepted { .. } => respond(record(state, "ready".to_string()), Vec::new(), Some(accepted)),
            rejected @ EngineHandshake::Rejected { .. } => respond(State::Incompatible, Vec::new(), Some(rejected)),
        },
        BrowserToEngineMessage::Event { event } => {
            let correlation = format!("c{}", next);
            match request(&event.name, CorrelationId(correlation.clone())) {
                None => respond(record(state, format!("ignored {}", event.name)), Vec::new(), None),
                Some(effect) => {
                    let pending = pending.clone().into_iter().chain(std::iter::once((correlation, event.name.clone()))).collect();
                    match record(state, format!("requested {}", event.name)) {
                        State::Ready { log, last_id, .. } => respond(State::Ready { log, last_id, next: next + 1, pending }, vec![effect], None),
                        State::Incompatible => respond(State::Incompatible, Vec::new(), None),
                    }
                }
            }
        }
        BrowserToEngineMessage::EffectResult { result } => {
            let correlation = correlation_of(result).to_string();
            match pending.get(&correlation).cloned() {
                None => respond(record(state, format!("stale {}", correlation)), Vec::new(), None),
                Some(label) => match record(state, format!("{}: {}", label, describe(result))) {
                    State::Ready { log, last_id, next, pending } => {
                        let pending = pending.into_iter().filter(|(key, _)| *key != correlation).collect();
                        respond(State::Ready { log, last_id, next, pending }, Vec::new(), None)
                    }
                    State::Incompatible => respond(State::Incompatible, Vec::new(), None),
                },
            }
        }
        BrowserToEngineMessage::LocationChanged { location } => respond(record(state, format!("location {}{}", location.path, location.query)), Vec::new(), None),
        BrowserToEngineMessage::CapabilityFact { capability: CapabilityId(capability), .. } => respond(record(state, format!("unexpected fact {}", capability)), Vec::new(), None),
    }
}

/// The JSON edge used by the WASM export: parse with the generated codec,
/// transition, serialize. A message outside the contract is refused, not
/// interpreted.
pub fn handle_json(state: State, json: &str) -> Result<(State, String), String> {
    let message = parse_browser_to_engine_message(json).map_err(|error| format!("Browser message outside the Limen contract at {}: expected {}, found {}", error.path, error.expected, error.found))?;
    let (next, response) = handle(state, &message);
    Ok((next, serialize_engine_to_browser_message(&response)))
}
