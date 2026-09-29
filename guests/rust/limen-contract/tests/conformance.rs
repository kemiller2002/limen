//! The Rust binding's side of the shared semantic vectors in
//! conformance/vectors/. TypeScript, F# and C# run the same file.

use std::path::PathBuf;

use limen_contract::limen_core::{conformance_round_trip, contract};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn read_json(relative: &str) -> Value {
    let text = std::fs::read_to_string(repository().join(relative)).expect("readable file");
    serde_json::from_str(&text).expect("valid JSON")
}

// Canonical form: keys sorted (serde_json's default map is ordered), every
// "doc" removed, no whitespace — the same rule the generator applies.
fn without_docs(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().filter(|(key, _)| key.as_str() != "doc").map(|(key, inner)| (key.clone(), without_docs(inner))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(without_docs).collect()),
        other => other.clone(),
    }
}

#[test]
fn fingerprint_is_the_contracts_computed_independently() {
    let canonical = serde_json::to_string(&without_docs(&read_json("contract/core.contract.json"))).expect("serializable");
    let digest = Sha256::digest(canonical.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{:02x}", byte)).collect();
    assert_eq!(contract::FINGERPRINT, format!("sha256:{}", hex));
}

// Numbers compare by value: 200 and 200.0 are the same wire number.
fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y)),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(key, x)| b.get(key).is_some_and(|y| same(x, y))),
        _ => left == right,
    }
}

#[test]
fn every_shared_vector_agrees() {
    let file = read_json("conformance/vectors/core.vectors.json");
    let vectors = file["vectors"].as_array().expect("vectors");
    let failures: Vec<String> = vectors
        .iter()
        .filter_map(|vector| {
            let name = vector["name"].as_str().unwrap_or("?");
            let type_name = vector["type"].as_str().unwrap_or("?");
            let valid = vector["valid"].as_bool().unwrap_or(false);
            match conformance_round_trip(type_name, &vector["json"]) {
                None => Some(format!("{}: no generated decoder for {}", name, type_name)),
                Some(Ok(encoded)) if valid => (!same(&encoded, &vector["json"])).then(|| format!("{}: round trip changed the value: {}", name, encoded)),
                Some(Ok(_)) => Some(format!("{}: decoded a vector that must be rejected", name)),
                Some(Err(error)) if valid => Some(format!("{}: rejected a valid vector at {} ({})", name, error.path, error.expected)),
                Some(Err(error)) => (Some(error.path.as_str()) != vector["errorPath"].as_str()).then(|| format!("{}: rejected at {} instead of {}", name, error.path, vector["errorPath"])),
            }
        })
        .collect();
    assert!(failures.is_empty(), "{} vector(s) disagree:\n{}", failures.len(), failures.join("\n"));
    assert!(vectors.len() >= 50, "the shared vector file is unexpectedly small");
}
