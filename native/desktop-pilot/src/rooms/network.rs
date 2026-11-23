use super::crypto::{b64, hex, random, unb64};
use k256::schnorr::SigningKey;
use serde_json::{json, Value};
use sha2_10::{Digest, Sha256};
use std::{net::{Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket},
    sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, SyncSender}}, time::{Duration, Instant}};
use tungstenite::{protocol::WebSocketConfig, stream::MaybeTlsStream, Message, WebSocket};

pub struct Lan {
    socket: UdpSocket,
    targets: Vec<SocketAddr>,
    refreshed: u64,
    port: u16,
    seeds: Vec<SocketAddr>,
    broadcast: bool,
}

impl Lan {
    pub fn open(port: u16, seeds: Vec<SocketAddr>, broadcast: bool) -> std::io::Result<Self> {
        let socket = UdpSocket::bind((if broadcast { Ipv4Addr::UNSPECIFIED } else { Ipv4Addr::LOCALHOST }, port))?;
        socket.set_nonblocking(true)?;
        socket.set_broadcast(broadcast)?;
        Ok(Self { socket, targets: vec![], refreshed: 0, port, seeds, broadcast })
    }

    pub fn receive(&self, bytes: &mut [u8]) -> std::io::Result<(usize, SocketAddr)> { self.socket.recv_from(bytes) }
    pub fn send(&self, address: SocketAddr, bytes: &[u8]) { let _ = self.socket.send_to(bytes, address); }

    pub fn broadcast(&mut self, bytes: &[u8], now: u64) {
        if now.saturating_sub(self.refreshed) >= 5000 {
            self.refreshed = now;
            self.targets = self.seeds.clone();
            if self.broadcast {
                self.targets.push((Ipv4Addr::BROADCAST, self.port).into());
                if let Ok(interfaces) = if_addrs::get_if_addrs() {
                    for interface in interfaces {
                        if interface.is_loopback() { continue; }
                        if let if_addrs::IfAddr::V4(ip) = interface.addr {
                            if let Some(broadcast) = ip.broadcast { self.targets.push((broadcast, self.port).into()); }
                        }
                    }
                }
            }
            self.targets.sort(); self.targets.dedup();
        }
        for &target in &self.targets { self.send(target, bytes); }
    }
}

pub enum RelayInput { Status(usize, &'static str), LinkUp, Packet(String, Vec<u8>) }
enum RelayCommand { Publish(String), Retry, Stop }

pub struct Relays {
    pub input: Receiver<RelayInput>,
    senders: Vec<SyncSender<RelayCommand>>,
    stopped: Arc<AtomicBool>,
    key: SigningKey,
    topic: String,
    finished: Vec<Receiver<()>>,
}

impl Relays {
    pub fn start(urls: &[String], topic: &str) -> Result<Self, String> {
        let key = SigningKey::from_bytes(&random::<32>()?).map_err(|e| e.to_string())?;
        let public = hex(&key.verifying_key().to_bytes());
        let (out, input) = mpsc::sync_channel(512);
        let stopped = Arc::new(AtomicBool::new(false));
        let mut senders = vec![];
        let mut finished = vec![];
        for (index, url) in urls.iter().enumerate() {
            let (tx, rx) = mpsc::sync_channel(64);
            senders.push(tx);
            let (url, topic, public, out, stopped) = (url.clone(), topic.to_owned(), public.clone(), out.clone(), stopped.clone());
            let (done, receiver) = mpsc::channel();
            finished.push(receiver);
            std::thread::spawn(move || {
                relay_loop(index, &url, &topic, &public, out, rx, stopped);
                let _ = done.send(());
            });
        }
        Ok(Self { input, senders, stopped, key, topic: topic.into(), finished })
    }

    pub fn publish(&self, packet: &[u8], now: u64) {
        self.publish_with_key(&self.key, packet, now);
    }

    pub fn publish_unlinked(&self, packet: &[u8], now: u64) {
        if let Ok(seed) = random::<32>() {
            if let Ok(key) = SigningKey::from_bytes(&seed) { self.publish_with_key(&key, packet, now); }
        }
    }

    fn publish_with_key(&self, key: &SigningKey, packet: &[u8], now: u64) {
        let public = hex(&key.verifying_key().to_bytes());
        let content = b64(packet);
        let tags = json!([["x", self.topic]]);
        let canonical = json!([0, public, now / 1000, 24747, tags, content]).to_string();
        let digest = Sha256::digest(canonical.as_bytes());
        let Ok(aux) = random::<32>() else { return; };
        let Ok(signature) = key.sign_raw(&digest, &aux) else { return; };
        let event = json!(["EVENT", {"id":hex(&digest),"pubkey":public,"created_at":now / 1000,
            "kind":24747,"tags":tags,"content":content,"sig":hex(&signature.to_bytes())}]).to_string();
        for tx in &self.senders { let _ = tx.try_send(RelayCommand::Publish(event.clone())); }
    }

    pub fn retry(&self) { for tx in &self.senders { let _ = tx.try_send(RelayCommand::Retry); } }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        for tx in &self.senders { let _ = tx.try_send(RelayCommand::Stop); }
        let deadline = Instant::now() + Duration::from_millis(500);
        for receiver in &self.finished { let _ = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())); }
    }
}

impl Drop for Relays { fn drop(&mut self) { self.stop(); } }

fn connect(url: &str, stopped: &AtomicBool) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
    let parsed = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "wss" | "ws") { return Err("Invalid relay URL".into()); }
    let host = parsed.host_str().ok_or("Missing relay host")?;
    let port = parsed.port().unwrap_or(if parsed.scheme() == "wss" { 443 } else { 80 });
    let mut tcp = None;
    for address in (host, port).to_socket_addrs().map_err(|e| e.to_string())?.take(4) {
        if stopped.load(Ordering::SeqCst) { return Err("Relay stopped".into()); }
        if let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) { tcp = Some(stream); break; }
    }
    let tcp = tcp.ok_or("Cannot connect to relay")?;
    tcp.set_read_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_millis(250))).map_err(|e| e.to_string())?;
    if stopped.load(Ordering::SeqCst) { return Err("Relay stopped".into()); }
    let config = WebSocketConfig::default().max_message_size(Some(65_536)).max_frame_size(Some(65_536))
        .write_buffer_size(0).max_write_buffer_size(131_072);
    let (socket, _) = tungstenite::client_tls_with_config(url, tcp, Some(config), None).map_err(|e| e.to_string())?;
    let tcp = match socket.get_ref() {
        MaybeTlsStream::Plain(tcp) => tcp,
        MaybeTlsStream::NativeTls(tls) => tls.get_ref(),
        _ => return Err("Unsupported TLS stream".into()),
    };
    tcp.set_read_timeout(Some(Duration::from_millis(50))).map_err(|e| e.to_string())?;
    Ok(socket)
}

fn relay_loop(index: usize, url: &str, topic: &str, public: &str, out: SyncSender<RelayInput>,
    commands: Receiver<RelayCommand>, stopped: Arc<AtomicBool>) {
    let epoch = Instant::now();
    let elapsed = || epoch.elapsed().as_millis() as u64;
    let mut socket = None;
    let (mut retry_at, mut attempts, mut retired) = (0, 0u32, false);
    let (mut health_at, mut cooling_until, mut closed_once) = (0, 0, false);
    let mut healthy_since = None;
    let (mut window_at, mut received) = (0, 0);
    let status = |value| { let _ = out.try_send(RelayInput::Status(index, value)); };
    while !stopped.load(Ordering::SeqCst) {
        let now = elapsed();
        for _ in 0..64 {
            let Ok(command) = commands.try_recv() else { break; };
            match command {
                RelayCommand::Stop => return,
                RelayCommand::Retry => { if socket.is_none() { retired = false; retry_at = 0; attempts = 0; } },
                RelayCommand::Publish(text) => {
                    if now >= cooling_until {
                        if let Some(socket) = socket.as_mut() {
                            let socket: &mut WebSocket<MaybeTlsStream<TcpStream>> = socket;
                            if socket.send(Message::Text(text.into())).is_err() { health_at = 0; }
                        }
                    }
                },
            }
        }
        if socket.is_none() {
            if retired || now < retry_at {
                match commands.recv_timeout(Duration::from_millis(50)) {
                    Ok(RelayCommand::Retry) => { retired = false; retry_at = 0; attempts = 0; },
                    Ok(RelayCommand::Stop) => return,
                    _ => {},
                }
                continue;
            }
            status("starting");
            match connect(url, &stopped) {
                Ok(mut connected) => {
                    if stopped.load(Ordering::SeqCst) { let _ = connected.close(None); return; }
                    let req = subscription(topic);
                    if connected.send(Message::Text(req.into())).is_ok() {
                        socket = Some(connected); health_at = elapsed() + 25_000;
                        healthy_since = None; closed_once = false;
                        let _ = out.try_send(RelayInput::LinkUp);
                        continue;
                    }
                },
                Err(_) => {},
            }
            status("unavailable");
            retry_at = elapsed() + backoff(attempts);
            attempts = attempts.saturating_add(1);
            continue;
        }
        let result = match socket.as_mut() { Some(socket) => socket.read(), None => continue };
        let mut disconnected = false;
        match result {
            Ok(Message::Text(text)) => {
                if now.saturating_sub(window_at) >= 1000 { received = 0; window_at = now; }
                received += 1;
                if received > 400 { retired = true; disconnected = true; }
                else if let Ok(message) = serde_json::from_str::<Value>(&text) {
                    match message[0].as_str() {
                        Some("EVENT") if message[1] == "lolping" => {
                            let e = &message[2];
                            if e["kind"] == 24747 && e["tags"].as_array().is_some_and(|tags| tags.iter().any(|t| t[0] == "x" && t[1] == topic)) {
                                if e["pubkey"] == public {
                                    healthy_since.get_or_insert(now);
                                    health_at = now + 25_000; status("ok");
                                } else if let (Some(id), Some(content)) = (e["id"].as_str(), e["content"].as_str()) {
                                    if super::protocol::is_hex(id, 64) && content.len() <= 1600 {
                                        if let Some(packet) = unb64(content) { let _ = out.try_send(RelayInput::Packet(id.into(), packet)); }
                                    }
                                }
                            }
                        },
                        Some("OK") if message[2] == false => {
                            let reason = message[3].as_str().unwrap_or("");
                            if reason.starts_with("rate-limited:") { cooling_until = now + 30_000; health_at = cooling_until + 25_000; }
                            else if ["blocked:", "restricted:", "auth-required:", "pow:", "invalid:"].iter().any(|prefix| reason.starts_with(prefix)) {
                                retired = true; disconnected = true;
                            }
                        },
                        Some("CLOSED") if message[1] == "lolping" => {
                            if closed_once { retired = true; disconnected = true; }
                            else {
                                closed_once = true;
                                if let Some(socket) = socket.as_mut() { let _ = socket.send(Message::Text(subscription(topic).into())); }
                            }
                        },
                        _ => {},
                    }
                }
            },
            Ok(Message::Close(_)) => disconnected = true,
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {},
            Err(_) => disconnected = true,
            _ => {},
        }
        if now >= health_at { disconnected = true; }
        if disconnected {
            if let Some(mut socket) = socket.take() { let _ = socket.close(None); }
            if healthy_since.is_some_and(|at| now.saturating_sub(at) >= 60_000) { attempts = 0; }
            healthy_since = None; status("unavailable");
            retry_at = now + backoff(attempts); attempts = attempts.saturating_add(1);
        }
    }
    // Drain queued bye packets without reconnecting or waiting for another network response.
    if let Some(mut socket) = socket {
        let deadline = Instant::now() + Duration::from_millis(500);
        for command in commands.try_iter().take(64) {
            if Instant::now() >= deadline { break; }
            if let RelayCommand::Publish(text) = command { let _ = socket.send(Message::Text(text.into())); }
        }
        let _ = socket.close(None);
    }
}

fn subscription(topic: &str) -> String {
    json!(["REQ", "lolping", {"kinds":[24747],"#x":[topic],"since":super::now().saturating_sub(600_000) / 1000,"limit":0}]).to_string()
}

fn backoff(attempt: u32) -> u64 {
    let base = (2000u64.saturating_mul(1u64 << attempt.min(5))).min(60_000);
    let jitter = random::<2>().map(u16::from_le_bytes).unwrap_or(32768) as f64 / 65535.0;
    (base as f64 * (0.8 + jitter * 0.4)) as u64
}
