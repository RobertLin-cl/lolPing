import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { hashes, schnorr } from '@noble/secp256k1';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'out/desktop-pilot');
const chat = process.argv.includes('--chat');
const panel = process.argv.includes('--panel');
await mkdir(output, { recursive: true });
const bundle = resolve(output, 'room-test.cjs');
await build({ stdin: { contents: `
  export { RoomManager } from './src/main/roomManager';
  export { RoomVotes } from './src/main/roomVotes';
  export { DEFAULT_SUMMONER_STATE } from './src/shared/summonerSpells';
  export { LanTransport } from './src/main/lanTransport';
  export { RelayTransport } from './src/main/relayTransport';
  export { deriveRoomKeys, open } from './src/main/roomCrypto';
  export { EmoteTransfer } from './src/main/emoteTransfer';
  export { linkedHd } from './src/shared/hdLink';
  export { DEFAULT_CLICK_EMOTE } from './src/shared/emoteCatalog';
  export { desktopPilotSettings } from './src/shared/desktopPilot';
`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { RoomManager, LanTransport, RelayTransport, deriveRoomKeys, open, EmoteTransfer, linkedHd,
  DEFAULT_CLICK_EMOTE, desktopPilotSettings, RoomVotes, DEFAULT_SUMMONER_STATE } = createRequire(import.meta.url)(bundle);

hashes.sha256 = (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());
const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((done) => relay.once('listening', done));
const relayUrl = `ws://127.0.0.1:${relay.address().port}`;
const subscriptions = new Map();
let signatureFailure = false;
let privacyFailure = false;
const knownRelayKeys = new Set();
const knownPeers = new Set();
const keys = await deriveRoomKeys('0000000000');
relay.on('connection', (ws) => {
  subscriptions.set(ws, new Map());
  ws.on('close', () => subscriptions.delete(ws));
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message[0] === 'REQ') subscriptions.get(ws)?.set(message[1], message[2]);
    if (message[0] !== 'EVENT') return;
    const e = message[1];
    const plain = open(keys.msgKey, Buffer.from(e.content, 'base64'));
    if (plain) {
      const inside = JSON.parse(plain.toString('utf8'));
      if (inside.t === 'presence') { knownRelayKeys.add(e.pubkey); knownPeers.add(inside.peer); }
      if (inside.t === 'whisper' && (knownRelayKeys.has(e.pubkey) || knownPeers.has(inside.peer))) privacyFailure = true;
    }
    const canonical = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
    const id = createHash('sha256').update(canonical).digest('hex');
    if (e.id !== id || !schnorr.verify(Buffer.from(e.sig, 'hex'), Buffer.from(id, 'hex'), Buffer.from(e.pubkey, 'hex'))) {
      signatureFailure = true; ws.send(JSON.stringify(['OK', e.id, false, 'invalid: signature'])); return;
    }
    ws.send(JSON.stringify(['OK', e.id, true, '']));
    for (const [socket, subs] of subscriptions) {
      for (const [sub, filter] of subs) {
        if (filter.kinds.includes(e.kind) && e.tags.some((tag) => tag[0] === 'x' && filter['#x'].includes(tag[1]))) {
          socket.send(JSON.stringify(['EVENT', sub, e]));
        }
      }
    }
  });
});

const probe = createSocket('udp4');
await new Promise((done) => probe.bind(0, '127.0.0.1', done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const lan = new LanTransport({ port, bindAddress: '127.0.0.1', broadcast: false });
const net = new RelayTransport({ urls: [relayUrl], socket: (url) => new WebSocket(url) });
// A real single-pixel WebP; both runtimes check its hash and WebView2 decodes it.
const still = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const hash = createHash('sha256').update(still).digest('hex').slice(0, 32);
const peers = [];
const checks = new Set();
const candidates = [['LANPeer', lan], ['RelayPeer', net]];
if (chat) candidates.push(['SpyPeer', new RelayTransport({ urls: [relayUrl], socket: (url) => new WebSocket(url) })]);
for (const [name, transport] of candidates) {
  const cache = new Map();
  const hdCache = new Map();
  const room = new RoomManager({ transports: [transport], now: Date.now, randomBytes, deriveKeys: deriveRoomKeys,
    appVersion: '0.6.7', profile: () => ({ name, color: 1, rgb: null, limit: 0, nf: panel ? [] : chat ? ['votes'] : ['text', 'votes'] }),
    resolveTarget: () => ({ displayId: 0, width: 1920, height: 1080 }), announceEmotes: () => [hash] });
  const transfer = new EmoteTransfer({ now: Date.now, enabled: () => true,
    have: (h) => h === hash || cache.has(h), still: (h) => h === hash ? still : null,
    link: (h) => linkedHd(h === hash ? still : cache.get(h) ?? new Uint8Array()),
    haveHd: (h) => hdCache.has(h), hd: () => null, announced: () => [hash],
    put: (h, bytes) => { cache.set(h, bytes); checks.add(`${name}:image`); },
    putHd: (h, bytes) => { hdCache.set(h, bytes); checks.add(`${name}:hd`); },
    routeOf: (peer) => room.routeKind(peer), sendToLan: (peer, body) => room.sendToLan(peer, body),
    broadcastShared: (body) => room.broadcastShared(body), spareSharedToken: (keep) => room.spareSharedToken(keep) });
  room.on('emotes', (peer, hashes) => transfer.announced(peer, hashes));
  room.on('want', (message) => transfer.onWant(message));
  room.on('chunk', (message) => transfer.onChunk(message));
  room.on('memberGone', (peer) => transfer.memberGone(peer));
  room.on('remotePing', (message) => {
    if (message.id === 'danger') checks.add(`${name}:ping`);
  });
  room.on('remoteEmote', (message) => { if (message.ref.startsWith('c:')) checks.add(`${name}:emote`); });
  let votes;
  if (panel) {
    votes = new RoomVotes({ room, now: Date.now, randomId: () => randomBytes(4).toString('hex'),
      onView: (view) => { if (view && view.starter !== room.self) votes.answer(true); },
      onResult: (outcome) => { if (outcome.passed) checks.add(`${name}:vote`); }, onKicked: () => room.quit() });
    room.on('remoteSpell', () => {
      checks.add(`${name}:spell`);
      room.sendSpell(room.self, 'f', DEFAULT_SUMMONER_STATE.f, { d: 1, x: 0.5, y: 0.5 });
    });
    room.on('remoteText', (message) => {
      if (name === 'LANPeer' && message.text === 'panel incoming ready') votes.start('ready');
    });
  }
  if (chat) {
    room.on('remoteText', (message) => {
      if (message.text !== 'Rust chat smoke' || name === 'SpyPeer') return;
      checks.add(`${name}:text`);
      room.whisper(message.peer, `private from ${name}`);
    });
    room.on('whisper', (message) => {
      if (name === 'SpyPeer') privacyFailure = true;
      else if (message.text === 'direct secret') checks.add(`${name}:whisper`);
      else if (message.text === 'reply secret') checks.add('reply');
    });
  }
  await room.join('PING-00000-00000');
  if (panel) room.setSummoners(DEFAULT_SUMMONER_STATE);
  const timer = setInterval(() => {
    if (room.state().members.length < 2 || name === 'SpyPeer') return;
    room.sendPing('push', { d: 1, x: 0.25, y: 0.5 });
    room.sendEmote(DEFAULT_CLICK_EMOTE, { d: 1, x: 0.5, y: 0.5 });
    if (checks.has(`${name}:image`)) room.sendEmote(`c:${hash}`, { d: 1, x: 0.5, y: 0.5 }, 2);
    if (chat) room.sendText(`hello from ${name}`, { d: 1, x: 0.5, y: 0.5 });
  }, 1000);
  peers.push({ room, transfer, timer, transport, votes });
}

const data = resolve(output, panel ? 'smoke-panel' : chat ? 'smoke-chat' : 'smoke-rooms');
await mkdir(data, { recursive: true });
await writeFile(resolve(data, 'settings.json'), JSON.stringify(desktopPilotSettings({ displayName: 'RustSmoke', rejoinRoom: false,
  features: { roomVotes: panel } })));
const env = { ...process.env,
    LOLPING_PILOT_ROOM_SMOKE: '1', LOLPING_PILOT_SIMULATE: '1', LOLPING_PILOT_SETTINGS: '1',
    LOLPING_PILOT_DATA_DIR: data, LOLPING_PILOT_ROOM_PORT: '0', LOLPING_PILOT_ROOM_SEED: `127.0.0.1:${port}`,
    LOLPING_PILOT_ROOM_RELAY: relayUrl, LOLPING_PILOT_SECONDS: '80' };
for (const key of ['LOLPING_PILOT_SMOKE', 'LOLPING_PILOT_DISPLAY_SMOKE', 'LOLPING_PILOT_BENCHMARK', 'LOLPING_PILOT_DEMO']) delete env[key];
if (chat) env.LOLPING_PILOT_CHAT_SMOKE = '1';
else delete env.LOLPING_PILOT_CHAT_SMOKE;
if (panel) env.LOLPING_PILOT_PANEL_SMOKE = '1';
else delete env.LOLPING_PILOT_PANEL_SMOKE;
const child = spawn(resolve(root, 'native/desktop-pilot/target/release/lolping-desktop-pilot.exe'), [], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
});
let log = '';
child.stdout.on('data', (bytes) => { log += bytes; process.stdout.write(bytes); });
child.stderr.on('data', (bytes) => { log += bytes; process.stderr.write(bytes); });
const exited = new Promise((done, reject) => { child.once('exit', done); child.once('error', reject); });
try {
  const code = await exited;
  const expected = ['LANPeer', 'RelayPeer'].flatMap((peer) => ['ping', 'emote', 'image', 'hd'].map((type) => `${peer}:${type}`));
  if (chat) expected.push('LANPeer:text', 'RelayPeer:text', 'LANPeer:whisper', 'RelayPeer:whisper', 'reply');
  if (panel) expected.push('LANPeer:spell', 'RelayPeer:spell', 'LANPeer:vote', 'RelayPeer:vote');
  if (code !== 0 || !log.includes('Pilot room smoke: passed') || (chat && (!log.includes('Pilot chat smoke: passed') || !log.includes('"type":"textRequested"')))
    || (panel && !log.includes('Pilot panel smoke: passed')) || signatureFailure || privacyFailure || expected.some((key) => !checks.has(key))) {
    throw new Error(`Room interoperability failed: exit=${code}, invalidSignature=${signatureFailure}, checks=${[...checks].join(',')}`);
  }
  console.log('Original TypeScript LAN/relay peers: bidirectional pings, emotes, stills and HD passed');
  if (chat) console.log('Chat page, original text/whispers, reply and relay identity privacy passed');
  if (panel) console.log('Roster, vote widgets and original TypeScript spell/vote interoperability passed');
} finally {
  for (const { room, transfer, timer, votes } of peers) { clearInterval(timer); transfer.stop(); votes?.stop(); room.quit(); }
  await Promise.all(peers.map(({ transport }) => transport.whenClosed()));
  for (const ws of relay.clients) ws.terminate();
  await new Promise((done) => relay.close(done));
}
