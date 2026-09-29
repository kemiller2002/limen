//! The WebAssembly ABI of the Rust minimal engine.
//!
//! JUSTIFIED UNSAFE BOUNDARY (kemiller2002/limen#55): a WebAssembly module
//! with no JavaScript bindings generator can exchange strings with its host
//! only through raw pointers into linear memory, and exporting a function by
//! a stable symbol name requires `#[no_mangle]`, which the `unsafe_code` lint
//! treats as unsafe. Everything else in the Rust guests forbids unsafe code;
//! this crate contains the three exports and nothing else — no decision, no
//! state, no decoding.
//!
//! Protocol (src/hosts/raw-wasm-transport.ts is the other half):
//!   limen_alloc(len)          -> ptr   host writes len UTF-8 bytes at ptr
//!   limen_dispatch(ptr, len)  -> u64   consumes the input buffer; returns
//!                                      (out_ptr << 32) | out_len, where the
//!                                      output's first byte is 0 (JSON follows)
//!                                      or 1 (an error message follows)
//!   limen_free(ptr, len)               host releases the output buffer

#![deny(warnings)]
#![allow(unsafe_code)]

use std::cell::RefCell;

use limen_minimal::{handle_json, State};

thread_local! {
    // The engine's state between calls. WebAssembly here is single-threaded.
    static STATE: RefCell<Option<State>> = RefCell::new(Some(State::initial()));
}

fn dispatch(input: &str) -> Vec<u8> {
    STATE.with(|cell| {
        let state = cell.borrow_mut().take().unwrap_or_else(State::initial);
        match handle_json(state.clone(), input) {
            Ok((next, output)) => {
                *cell.borrow_mut() = Some(next);
                std::iter::once(0u8).chain(output.into_bytes()).collect()
            }
            Err(error) => {
                *cell.borrow_mut() = Some(state);
                std::iter::once(1u8).chain(error.into_bytes()).collect()
            }
        }
    })
}

fn leak(bytes: Vec<u8>) -> u64 {
    let boxed = bytes.into_boxed_slice();
    let length = boxed.len() as u64;
    let pointer = Box::into_raw(boxed) as *mut u8 as usize as u64;
    (pointer << 32) | length
}

#[no_mangle]
pub extern "C" fn limen_alloc(length: u32) -> *mut u8 {
    let boxed = vec![0u8; length as usize].into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}

/// # Safety
/// `pointer`/`length` must be a buffer returned by `limen_alloc` or
/// `limen_dispatch` and not yet freed.
#[no_mangle]
pub unsafe extern "C" fn limen_free(pointer: *mut u8, length: u32) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length as usize)));
}

/// # Safety
/// `pointer`/`length` must be a buffer returned by `limen_alloc`, filled by
/// the host; ownership passes to this function.
#[no_mangle]
pub unsafe extern "C" fn limen_dispatch(pointer: *mut u8, length: u32) -> u64 {
    let input = Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length as usize));
    match std::str::from_utf8(&input) {
        Ok(text) => leak(dispatch(text)),
        Err(_) => leak(std::iter::once(1u8).chain("input is not UTF-8".bytes()).collect()),
    }
}
