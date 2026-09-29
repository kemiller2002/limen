//! The Rust minimal engine against the normative session vectors.

use std::path::PathBuf;

use limen_contract::limen_core::contract;
use limen_minimal::{handle_json, State};
use serde_json::Value;

fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y)),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(key, x)| b.get(key).is_some_and(|y| same(x, y))),
        _ => left == right,
    }
}

#[test]
fn every_session_matches() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../conformance/sessions/minimal.session.json");
    let text = std::fs::read_to_string(path).expect("session file").replace("{{core.fingerprint}}", contract::FINGERPRINT);
    let file: Value = serde_json::from_str(&text).expect("valid JSON");
    let sessions = file["sessions"].as_array().expect("sessions");
    let mut failures = Vec::new();
    let mut steps = 0;
    for session in sessions {
        let name = session["name"].as_str().unwrap_or("?");
        let mut state = State::initial();
        for (index, step) in session["steps"].as_array().expect("steps").iter().enumerate() {
            steps += 1;
            let (next, output) = handle_json(state, &step["send"].to_string()).expect("a contract message");
            state = next;
            let actual: Value = serde_json::from_str(&output).expect("engine output is JSON");
            if !same(&actual, &step["expect"]) {
                failures.push(format!("{}, step {}:\n  expected {}\n  actual   {}", name, index + 1, step["expect"], actual));
            }
        }
    }
    assert!(failures.is_empty(), "Rust minimal engine disagrees on {} step(s):\n{}", failures.len(), failures.join("\n"));
    assert_eq!(steps, 65);
}
