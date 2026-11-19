//! Prism's engine host.
//!
//! One engine is a `prism --mode rpc` child process. The PC window and the phones are *clients* of it, and any number
//! of clients can attach to the same engine: what one types appears for the others, because the engine's every line
//! goes to every client. The host does not interpret the protocol beyond what sharing needs (routing a response to the
//! client that asked, remembering the questions nobody answered); every decision (permissions, sessions, models) stays
//! in the engine.
//!
//! - `engine`: the engines and the clients attached to them (`Hub`).
//! - `connection`: the phone protocol (section 3 quater) over any line transport, for a phone's TLS connection and for
//!   the window's local socket alike.
//! - `lines`: that transport, over a Unix socket.
//! - `attach`, `uploads`, `project`, `files`, `base64`: what the window's host calls need besides engines.

pub mod attach;
pub mod base64;
pub mod connection;
pub mod engine;
pub mod files;
pub mod lines;
pub mod project;
pub mod uploads;
