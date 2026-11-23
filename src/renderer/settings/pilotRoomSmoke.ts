import type { SettingsApi } from '../../shared/ipc';
import type { RoomState } from '../../shared/room';
import { customHdUrl } from '../../shared/emotes';
import { PILOT_CH } from '../../shared/settingsChannels';
import type { PilotHost } from '../shared/pilotHost';
import { prepareEmote } from './emoteImport';

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Room smoke timed out: ${label}`);
}

/** Uses real helper simulation, native sockets and original TypeScript peers on loopback. */
export async function runPilotRoomSmoke(api: SettingsApi, host: PilotHost): Promise<void> {
  let passed = false;
  let failure = '';
  let off: (() => void) | undefined;
  let receivedCustom: string | undefined;
  const seen = new Set<string>();
  try {
    const original = await api.getSettings();
    const result = await api.setSettings({ features: { ...original.features, rooms: true, emotes: true },
      allowInternet: true, rejoinRoom: false, roomMuted: false, friendEmotes: true, displayName: 'RustSmoke',
      trigger: 'alt', clickPing: true, clickPingId: 'danger', emoteTrigger: 'ctrl', emoteClick: true, gameCheck: false });
    if (!result.ok) throw new Error('Could not configure room smoke');
    await api.setEnabled(true);
    off = await host.listen(PILOT_CH.roomInput, ({ payload }) => {
      const value = JSON.parse(payload) as { message: { t: string; e?: string }; tag: { name: string }; available: boolean };
      seen.add(`${value.tag.name}:${value.message.t}`);
      if (value.message.e?.startsWith('c:') && value.available) {
        seen.add(`${value.tag.name}:custom`); receivedCustom = value.message.e;
      }
    });
    await api.createRoom();
    await until(async () => (await api.getRoom()).phase === 'active', 'create room');
    if (!(await api.getSettings()).lastRoomCode) throw new Error('Created room was not remembered');
    await api.leaveRoom();
    if ((await api.getRoom()).phase !== 'idle' || (await api.getSettings()).lastRoomCode !== null) throw new Error('Leave did not clear the room');
    if (!(await api.joinRoom('PING-00000-00000')).ok) throw new Error('Join failed');
    await until(async () => {
      const room = await api.getRoom();
      return room.phase === 'active' && room.internet === 'ok'
        && room.members.some((m) => m.name === 'LANPeer' && m.path === 'lan')
        && room.members.some((m) => m.name === 'RelayPeer' && m.path === 'internet');
    }, 'both original peers');
    await until(() => ['LANPeer:ping', 'LANPeer:emote', 'RelayPeer:ping', 'RelayPeer:emote'].every((key) => seen.has(key)), 'incoming pings and emotes');
    const room = await api.getRoom();
    const peer = room.members.find((m) => m.name === 'LANPeer');
    if (!peer) throw new Error('LAN peer disappeared');
    await api.muteMember(peer.peer, true);
    if (!(await api.getRoom()).members.some((m) => m.peer === peer.peer && m.muted)) throw new Error('Member mute failed');
    await api.muteMember(peer.peer, false);
    await api.setEnabled(false);
    await until(async () => (await api.getRoom()).members.some((m) => m.self && m.status === 'paused'), 'pause presence');
    await api.setEnabled(true);
    await api.setSettings({ allowInternet: false });
    await until(async () => (await api.getRoom()).internet === 'off', 'internet off');
    await api.setSettings({ allowInternet: true });
    await api.retryInternet();
    await until(async () => (await api.getRoom()).internet === 'ok', 'internet reconnect');

    const canvas = new OffscreenCanvas(320, 240);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = '#234c98'; context.fillRect(0, 0, 320, 240);
    context.fillStyle = '#ffffff'; context.fillRect(80, 60, 160, 120);
    const prepared = await prepareEmote(new File([await canvas.convertToBlob({ type: 'image/png' })], 'room smoke.png'));
    if (!prepared.ok) throw new Error('Image preparation failed');
    const imported = await api.importEmote(prepared.file);
    if (!imported.ok) throw new Error(`Image import failed: ${imported.error}`);
    await api.setSettings({ clickEmoteId: imported.id });
    await host.invoke(PILOT_CH.roomSmoke, { kind: 'ping' });
    await host.invoke(PILOT_CH.roomSmoke, { kind: 'emote' });
    await until(() => seen.has('LANPeer:custom') && seen.has('RelayPeer:custom'), 'custom image transfers');
    const cached = await host.invoke<RoomState>(PILOT_CH.room, { action: 'get' });
    if (cached.members.length < 3) throw new Error('Room lost members during transfers');
    // The peer uses one known real WebP still, announced in its presence.
    if (!receivedCustom) throw new Error('No received image reference');
    const response = await fetch(customHdUrl(receivedCustom.slice(2)));
    if (!response.ok) throw new Error('Received still is not served');
    const decoded = await createImageBitmap(await response.blob());
    decoded.close();
    const snapshot = await host.invoke<{ chatSmoke?: boolean; panelSmoke?: boolean }>(PILOT_CH.snapshot);
    if (snapshot.chatSmoke) {
      const denied = await host.invoke(PILOT_CH.chat, { action: 'snapshot' }).then(() => false, () => true);
      if (!denied) throw new Error('Settings window accessed private chat IPC');
      const quiet = await host.invoke<{ focused?: boolean }>(PILOT_CH.chatSmoke, { phase: 'status' });
      if (quiet.focused) throw new Error('Incoming chat took focus');
      await host.invoke(PILOT_CH.chatSmoke, { phase: 'start' });
      await until(async () => {
        const state = await host.invoke<{ result: boolean | null }>(PILOT_CH.chatSmoke, { phase: 'status' });
        if (state.result === false) throw new Error('Chat page smoke failed');
        return state.result === true;
      }, 'chat page smoke');
    }
    if (snapshot.panelSmoke) {
      const { runPanelSmoke } = await import('../panel/pilotSmoke');
      await runPanelSmoke(api, host);
    }
    await api.removeEmote(imported.id);
    await api.leaveRoom();
    if ((await api.getRoom()).phase !== 'idle') throw new Error('Final leave failed');
    passed = true;
  } catch (error) { failure = String(error); console.error(error); }
  finally { off?.(); await host.invoke(PILOT_CH.roomSmoke, { kind: passed ? 'passed' : 'failed', detail: failure }); }
}
