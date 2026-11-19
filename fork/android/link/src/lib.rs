//! Prism's phone link, J0 prototype.
//!
//! Each device (the PC, each phone) has its own self-signed certificate, made once and kept in its folder. They
//! speak TLS 1.3 and each checks the other's certificate by its SHA-256 fingerprint, never by a certificate
//! authority:
//! - the phone learns the PC's fingerprint from the pairing QR code, with a one-time token;
//! - the PC learns the phone's fingerprint when the phone shows that token over TLS, and keeps it in its list of
//!   paired devices until it is revoked.
//!
//! After the handshake the first line says who is asking: `PAIR <token>` for a new phone, `HELLO` for a paired one.
//! The PC answers `OK` or `DENIED <reason>` and closes on a refusal. Then lines go both ways
//.

use std::fmt::Write as _;
use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ring::rand::{SecureRandom, SystemRandom};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{DigitallySignedStruct, DistinguishedName, Error, SignatureScheme};

/// How long a pairing token can be used, once.
pub const TOKEN_LIFETIME: Duration = Duration::from_secs(300);
/// A line longer than this ends the connection. A whole conversation (`get_messages`) is one line of several MiB.
const LINE_LIMIT: usize = 64 << 20;
// Security audit of 2026-11-14: before the first line is checked the other side is anyone who reaches the port, with
// any certificate. Until then it gets a short line, a short time in all and a bounded number of places, so it cannot
// make the server hold memory or threads.
/// The first line is `PAIR <token>` or `HELLO`: nothing longer is kept before the phone is known.
const FIRST_LINE_LIMIT: usize = 1024;
/// How long a connection has, handshake included, to say who it is.
pub const HELLO_WAIT: Duration = Duration::from_secs(10);
/// fork: how long a write to an accepted phone may wait without the
/// phone reading anything. A phone that stops reading is cut off then, instead of holding its connection open; it
/// takes its engines back when it reconnects.
pub const WRITE_WAIT: Duration = Duration::from_secs(30);
/// How many connections may be saying who they are at once; the next ones are closed at once.
pub const PENDING_LIMIT: usize = 32;

/// One of the `PENDING_LIMIT` places, given back when dropped.
struct Pending<'a>(&'a AtomicUsize);

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

/// Compares a token without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

pub fn fingerprint(cert: &[u8]) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, cert).as_ref())
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

/// A device's certificate and key, made on first use in `dir` (mode 700, key 600).
pub struct Identity {
    pub cert: CertificateDer<'static>,
    key: Vec<u8>,
}

impl Identity {
    pub fn load_or_create(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        let (cert_path, key_path) = (dir.join("cert.der"), dir.join("key.der"));
        if !cert_path.exists() || !key_path.exists() {
            let made = rcgen::generate_simple_self_signed(vec!["prism".to_string()])
                .map_err(|e| e.to_string())?;
            write_private(&key_path, &made.signing_key.serialize_der())
                .map_err(|e| e.to_string())?;
            write_private(&cert_path, made.cert.der()).map_err(|e| e.to_string())?;
        }
        let cert = fs::read(&cert_path).map_err(|e| e.to_string())?;
        let key = fs::read(&key_path).map_err(|e| e.to_string())?;
        Ok(Self {
            cert: CertificateDer::from(cert),
            key,
        })
    }

    pub fn fingerprint(&self) -> String {
        fingerprint(&self.cert)
    }

    fn key(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key.clone()))
    }
}

/// Checks the other side's signature with the certificate it showed; who that certificate belongs to is decided
/// by its fingerprint, after the handshake (server) or here (client).
#[derive(Debug)]
struct Pinned {
    /// The PC's fingerprint, on the phone; none on the PC, which checks the phone's after the handshake.
    expected: Option<String>,
    provider: Arc<CryptoProvider>,
}

impl Pinned {
    fn signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        match &self.expected {
            Some(expected) if *expected == fingerprint(end_entity) => {
                Ok(ServerCertVerified::assertion())
            }
            _ => Err(Error::General(
                "the PC's certificate is not the one paired".to_string(),
            )),
        }
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::General("TLS 1.3 only".to_string()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

impl ClientCertVerifier for Pinned {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        // Any certificate proves only that the phone holds its key; whether it is paired is checked after.
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::General("TLS 1.3 only".to_string()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// What the pairing QR code holds.
#[derive(Clone, Debug, PartialEq)]
pub struct Invitation {
    pub hosts: Vec<String>,
    pub port: u16,
    pub fingerprint: String,
    pub token: Option<String>,
}

impl Invitation {
    pub fn encode(&self) -> String {
        let mut out = format!(
            "prism-pair:v1;h={};p={};f={}",
            self.hosts.join(","),
            self.port,
            self.fingerprint
        );
        if let Some(token) = &self.token {
            let _ = write!(out, ";t={token}");
        }
        out
    }

    pub fn decode(text: &str) -> Result<Self, String> {
        let rest = text
            .trim()
            .strip_prefix("prism-pair:v1;")
            .ok_or("not a Prism pairing code")?;
        let (mut hosts, mut port, mut fingerprint, mut token) = (Vec::new(), None, None, None);
        for field in rest.split(';') {
            match field.split_once('=') {
                Some(("h", value)) => {
                    hosts = value
                        .split(',')
                        .filter(|h| !h.is_empty())
                        .map(str::to_string)
                        .collect()
                }
                Some(("p", value)) => port = value.parse().ok(),
                Some(("f", value))
                    if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) =>
                {
                    fingerprint = Some(value.to_ascii_lowercase())
                }
                Some(("t", value)) => token = Some(value.to_string()),
                _ => return Err(format!("unexpected field {field:?}")),
            }
        }
        Ok(Self {
            hosts: if hosts.is_empty() {
                return Err("no address".to_string());
            } else {
                hosts
            },
            port: port.ok_or("no port")?,
            fingerprint: fingerprint.ok_or("no fingerprint")?,
            token,
        })
    }

    /// The code as an SVG image, for the PC window (dark modules on white, with its quiet zone).
    pub fn svg(&self) -> Result<String, String> {
        let code = qrcode::QrCode::new(self.encode()).map_err(|e| e.to_string())?;
        Ok(code
            .render::<qrcode::render::svg::Color>()
            .quiet_zone(true)
            .min_dimensions(240, 240)
            .build())
    }

    /// The code drawn in the terminal, two rows of modules per line.
    pub fn qr(&self) -> Result<String, String> {
        let code = qrcode::QrCode::new(self.encode()).map_err(|e| e.to_string())?;
        Ok(code
            .render::<qrcode::render::unicode::Dense1x2>()
            .quiet_zone(true)
            .build())
    }
}

/// The PC's side: paired devices in `dir/paired` (one fingerprint and name per line), tokens in memory only.
pub struct Server {
    pub identity: Identity,
    dir: PathBuf,
    tokens: Mutex<Vec<(String, Instant)>>,
    config: Arc<rustls::ServerConfig>,
    /// Connections that have not said who they are yet.
    pending: AtomicUsize,
}

impl Server {
    pub fn new(dir: &Path) -> Result<Arc<Self>, String> {
        let identity = Identity::load_or_create(dir)?;
        let verifier = Arc::new(Pinned {
            expected: None,
            provider: provider(),
        });
        let config = rustls::ServerConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|e| e.to_string())?
            .with_client_cert_verifier(verifier)
            .with_single_cert(vec![identity.cert.clone()], identity.key())
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(Self {
            identity,
            dir: dir.to_path_buf(),
            tokens: Mutex::new(Vec::new()),
            config: Arc::new(config),
            pending: AtomicUsize::new(0),
        }))
    }

    /// A new one-time token, valid for `TOKEN_LIFETIME`.
    pub fn invite(&self, hosts: Vec<String>, port: u16) -> Result<Invitation, String> {
        let mut bytes = [0u8; 16];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| "no randomness".to_string())?;
        let token = hex(&bytes);
        self.tokens
            .lock()
            .unwrap()
            .push((token.clone(), Instant::now() + TOKEN_LIFETIME));
        Ok(Invitation {
            hosts,
            port,
            fingerprint: self.identity.fingerprint(),
            token: Some(token),
        })
    }

    pub fn paired(&self) -> Vec<String> {
        fs::read_to_string(self.dir.join("paired"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.split_whitespace().next().map(str::to_string))
            .collect()
    }

    pub fn revoke(&self, fingerprint: &str) -> Result<bool, String> {
        let list = self.paired();
        let kept: Vec<&String> = list.iter().filter(|f| *f != fingerprint).collect();
        let text: String = kept.iter().map(|f| format!("{f}\n")).collect();
        write_private(&self.dir.join("paired"), text.as_bytes()).map_err(|e| e.to_string())?;
        Ok(kept.len() != list.len())
    }

    fn take_token(&self, token: &str) -> bool {
        let mut tokens = self.tokens.lock().unwrap();
        let now = Instant::now();
        tokens.retain(|(_, until)| *until > now);
        match tokens
            .iter()
            .position(|(t, _)| same(t.as_bytes(), token.as_bytes()))
        {
            Some(index) => {
                tokens.remove(index);
                true
            }
            None => false,
        }
    }

    fn add(&self, fingerprint: &str) -> Result<(), String> {
        let mut list = self.paired();
        if !list.iter().any(|f| f == fingerprint) {
            list.push(fingerprint.to_string());
        }
        let text: String = list.iter().map(|f| format!("{f}\n")).collect();
        write_private(&self.dir.join("paired"), text.as_bytes()).map_err(|e| e.to_string())
    }

    /// Serves one connection: handshake, who is asking, then `serve` with the open line stream. Returns the phone's
    /// fingerprint once it is accepted, or the reason it was refused.
    pub fn accept(
        self: &Arc<Self>,
        tcp: TcpStream,
        serve: impl FnOnce(&mut ServerLines),
    ) -> Result<String, String> {
        if self.pending.fetch_add(1, Ordering::SeqCst) >= PENDING_LIMIT {
            self.pending.fetch_sub(1, Ordering::SeqCst);
            return Err("too many connections are waiting to say who they are".to_string());
        }
        let waiting = Pending(&self.pending);
        tcp.set_read_timeout(Some(HELLO_WAIT))
            .map_err(|e| e.to_string())?;
        // The read timeout starts again at every byte: the socket is closed after `HELLO_WAIT` in all, unless the
        // phone was accepted before.
        let (accepted, watch) = mpsc::channel::<()>();
        let closing = tcp.try_clone().map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            if watch.recv_timeout(HELLO_WAIT) == Err(RecvTimeoutError::Timeout) {
                let _ = closing.shutdown(Shutdown::Both);
            }
        });
        let connection =
            rustls::ServerConnection::new(self.config.clone()).map_err(|e| e.to_string())?;
        let mut lines = Lines::new(rustls::StreamOwned::new(connection, tcp));
        lines.limit = FIRST_LINE_LIMIT;
        let first = lines.read()?.ok_or("closed before saying who it is")?;
        let phone = lines
            .stream
            .conn
            .peer_certificates()
            .and_then(|certs| certs.first())
            .map(|cert| fingerprint(cert))
            .ok_or("no certificate")?;
        let refused = |lines: &mut ServerLines, reason: &str| {
            let _ = lines.write(&format!("DENIED {reason}"));
            Err(reason.to_string())
        };
        if let Some(token) = first.strip_prefix("PAIR ") {
            if !self.take_token(token) {
                return refused(&mut lines, "unknown, used or expired pairing code");
            }
            self.add(&phone)?;
        } else if first == "HELLO" {
            if !self.paired().contains(&phone) {
                return refused(&mut lines, "this device is not paired (or was revoked)");
            }
        } else {
            return refused(&mut lines, "unexpected first line");
        }
        lines.write("OK")?;
        // Accepted: the watch ends, the place is free, and the lines are those of a paired phone.
        drop(accepted);
        drop(waiting);
        lines.limit = LINE_LIMIT;
        lines
            .stream
            .sock
            .set_read_timeout(None)
            .map_err(|e| e.to_string())?;
        lines
            .stream
            .sock
            .set_write_timeout(Some(WRITE_WAIT))
            .map_err(|e| e.to_string())?;
        serve(&mut lines);
        Ok(phone)
    }

    pub fn listen(self: &Arc<Self>, port: u16) -> Result<TcpListener, String> {
        TcpListener::bind(("0.0.0.0", port)).map_err(|e| e.to_string())
    }
}

/// The phone's side: its identity, and the PC it paired with in `dir/pc` (the invitation without its token).
pub struct Client {
    pub identity: Identity,
    dir: PathBuf,
}

impl Client {
    pub fn new(dir: &Path) -> Result<Self, String> {
        Ok(Self {
            identity: Identity::load_or_create(dir)?,
            dir: dir.to_path_buf(),
        })
    }

    pub fn saved(&self) -> Option<Invitation> {
        Invitation::decode(&fs::read_to_string(self.dir.join("pc")).ok()?).ok()
    }

    /// Connects to the first address that answers. With a token, pairs, then keeps the PC for next time.
    pub fn connect(&self, invitation: &Invitation) -> Result<ClientLines, String> {
        let verifier = Arc::new(Pinned {
            expected: Some(invitation.fingerprint.clone()),
            provider: provider(),
        });
        let config = rustls::ClientConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|e| e.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_client_auth_cert(vec![self.identity.cert.clone()], self.identity.key())
            .map_err(|e| e.to_string())?;
        let config = Arc::new(config);
        let mut last = String::from("no address");
        for host in &invitation.hosts {
            let address = format!("{host}:{}", invitation.port);
            let tcp = match address
                .parse()
                .map_err(|e: std::net::AddrParseError| e.to_string())
                .and_then(|socket| {
                    TcpStream::connect_timeout(&socket, Duration::from_secs(3))
                        .map_err(|e| e.to_string())
                }) {
                Ok(tcp) => tcp,
                Err(error) => {
                    last = format!("{address}: {error}");
                    continue;
                }
            };
            let name = ServerName::try_from("prism").map_err(|e| e.to_string())?;
            let connection =
                rustls::ClientConnection::new(config.clone(), name).map_err(|e| e.to_string())?;
            let mut lines = Lines::new(rustls::StreamOwned::new(connection, tcp));
            let hello = match &invitation.token {
                Some(token) => format!("PAIR {token}"),
                None => "HELLO".to_string(),
            };
            lines.write(&hello).map_err(|e| format!("{address}: {e}"))?;
            match lines.read().map_err(|e| format!("{address}: {e}"))? {
                Some(answer) if answer == "OK" => {
                    let kept = Invitation {
                        token: None,
                        ..invitation.clone()
                    };
                    write_private(&self.dir.join("pc"), kept.encode().as_bytes())
                        .map_err(|e| e.to_string())?;
                    return Ok(lines);
                }
                Some(answer) => return Err(answer),
                None => return Err(format!("{address}: closed")),
            }
        }
        Err(last)
    }
}

/// Lines over a TLS stream, each at most `LINE_LIMIT` bytes (`FIRST_LINE_LIMIT` until the PC knows the phone).
pub struct Lines<S> {
    pub stream: S,
    buffer: Vec<u8>,
    limit: usize,
}

pub type ServerLines = Lines<rustls::StreamOwned<rustls::ServerConnection, TcpStream>>;
pub type ClientLines = Lines<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>;

impl<S: Read + Write> Lines<S> {
    fn new(stream: S) -> Self {
        Self {
            stream,
            buffer: Vec::new(),
            limit: LINE_LIMIT,
        }
    }

    pub fn write(&mut self, line: &str) -> Result<(), String> {
        self.stream
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|_| self.stream.flush())
            .map_err(|e| e.to_string())
    }

    /// The next line, or nothing when the other side closed.
    pub fn read(&mut self) -> Result<Option<String>, String> {
        match self.next(false)? {
            Polled::Line(line) => Ok(Some(line)),
            Polled::Closed | Polled::Nothing => Ok(None),
        }
    }

    fn next(&mut self, polling: bool) -> Result<Polled, String> {
        loop {
            if let Some(end) = self.buffer.iter().position(|&b| b == b'\n') {
                if end > self.limit {
                    return Err("line too long".to_string());
                }
                let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return String::from_utf8(line)
                    .map(Polled::Line)
                    .map_err(|_| "not UTF-8".to_string());
            }
            if self.buffer.len() > self.limit {
                return Err("line too long".to_string());
            }
            let mut chunk = [0u8; 16384];
            let read = match self.stream.read(&mut chunk) {
                Ok(read) => read,
                // A peer that closes without TLS's close_notify: the same as closing.
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => 0,
                // Polling: nothing arrived in time. A partial line stays in the buffer, a partial TLS record in rustls.
                Err(error)
                    if polling
                        && matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                {
                    return Ok(Polled::Nothing)
                }
                Err(error) => return Err(error.to_string()),
            };
            if read == 0 {
                return Ok(Polled::Closed);
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        }
    }
}

/// What `poll` found.
#[derive(Debug, PartialEq)]
pub enum Polled {
    Line(String),
    Closed,
    /// Nothing arrived within the wait: the caller may write, then poll again.
    Nothing,
}

impl ServerLines {
    /// The phone's certificate fingerprint (what `accept` returns), for the server to know whose its engines are.
    pub fn peer(&self) -> Option<String> {
        self.stream
            .conn
            .peer_certificates()
            .and_then(|certs| certs.first())
            .map(|cert| fingerprint(cert))
    }
}

impl<C, D> Lines<rustls::StreamOwned<C, TcpStream>>
where
    C: std::ops::DerefMut + std::ops::Deref<Target = rustls::ConnectionCommon<D>>,
    D: rustls::SideData,
{
    /// Waits at most `wait` for the next line, so one thread can both read and write: read with `poll`, write what is
    /// waiting, poll again.
    pub fn poll(&mut self, wait: Duration) -> Result<Polled, String> {
        self.stream
            .sock
            .set_read_timeout(Some(wait.max(Duration::from_millis(1))))
            .map_err(|e| e.to_string())?;
        let polled = self.next(true);
        self.stream
            .sock
            .set_read_timeout(None)
            .map_err(|e| e.to_string())?;
        polled
    }
}
