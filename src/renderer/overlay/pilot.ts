import { PILOT_CH } from '../../shared/settingsChannels';
import { OVERLAY_CHANNELS, type OverlayChannel, type OverlayEvents } from '../../shared/ipc';
import { PilotInput } from '../../main/pilotInput';
import { pilotRoomMessages } from '../../main/pilotRooms';
import { HELPER_VERSION, parseHelperLine } from '../../shared/protocol';
import { desktopPilotArt, desktopPilotRuntime, desktopPilotSettings } from '../../shared/desktopPilot';
import { isEmoteRefShape } from '../../shared/emotes';
import { isPingId } from '../../shared/pings';
import { pilotHost, type PilotBootstrap, type PilotSnapshot } from '../shared/pilotHost';
import { resolveLang, strings } from '../../shared/i18n';
import { pilotChatLines, type PilotChatLine } from '../../shared/pilotChat';
import { historyVisible } from '../../shared/chatFilter';
import { shouldPlayChatSound } from '../../shared/chatSound';
import { isSummonerSpellId } from '../../shared/summonerSpells';

async function start(): Promise<void> {
  const host = pilotHost();
  const data = await host.invoke<PilotBootstrap>(PILOT_CH.bootstrap);
  let settings = desktopPilotSettings(data.settings);
  let enabled = data.status.enabled;
  let revision = data.revision;
  const input = new PilotInput(data.displays, () => settings);
  const handlers = new Map<OverlayChannel, ((payload: OverlayEvents[OverlayChannel]) => void)[]>();
  const dispatch = (channel: OverlayChannel, payload: OverlayEvents[OverlayChannel]): void => {
    for (const cb of handlers.get(channel) ?? []) cb(payload);
  };
  const stop = (error: unknown): void => { console.error(error); void host.invoke(PILOT_CH.stop); };
  window.overlay = {
    keepAudioOutputActive: true,
    on(channel, cb) {
      if (!OVERLAY_CHANNELS.includes(channel)) throw new Error(`Unknown channel: ${channel}`);
      const callbacks = handlers.get(channel) ?? [];
      callbacks.push(cb as (payload: OverlayEvents[OverlayChannel]) => void);
      handlers.set(channel, callbacks);
    },
    reportMissingAssets(names) { if (names.length) console.warn('Missing pilot assets', names); },
    reportPing(reference, x, y) { void host.invoke(PILOT_CH.placed, { kind: 'ping', reference, x, y }).catch(stop); },
    reportEmote(reference, x, y) { void host.invoke(PILOT_CH.placed, { kind: 'emote', reference, x, y }).catch(stop); },
    reportIdle(idle) { void host.invoke(PILOT_CH.idle, { idle }).catch(stop); },
  };
  await import('./main');
  dispatch('overlay:settings', desktopPilotRuntime(settings, data.status.enabled, navigator.language).overlay);
  const applySnapshot = (snapshot: PilotSnapshot): void => {
    if (snapshot.revision < revision) return;
    revision = snapshot.revision;
    settings = desktopPilotSettings(snapshot.settings);
    enabled = snapshot.status.enabled;
    dispatch('overlay:settings', desktopPilotRuntime(settings, snapshot.status.enabled, navigator.language).overlay);
    dispatch('wheel:cancel', null);
  };
  await host.listen(PILOT_CH.settingsChanged, ({ payload }) => applySnapshot(JSON.parse(payload) as PilotSnapshot));
  await host.listen(PILOT_CH.statusChanged, ({ payload }) => applySnapshot(JSON.parse(payload) as PilotSnapshot));
  await host.listen(PILOT_CH.chatLine, ({ payload }) => {
    const raw = JSON.parse(payload) as PilotChatLine;
    if (!settings.features.rooms || (raw.kind === 'vote' ? !settings.features.roomVotes : !settings.features.roomText)) return;
    const line = pilotChatLines([raw], settings, navigator.language)[0];
    if (!line) return;
    if (data.displayId === 0 && shouldPlayChatSound(line, settings.chatFilter, enabled && settings.chatSound)) dispatch('chat:message', null);
      if ((raw.kind !== 'text' && raw.kind !== 'alive' && raw.kind !== 'spell' && raw.kind !== 'vote') || !historyVisible(line, settings.chatFilter)
      || settings.roomTextStyle === 'window' || raw.x === undefined || raw.y === undefined || raw.d === undefined) return;
    const number = raw.d;
    const display = data.displays.find((d) => d.id === number - 1) ?? data.displays[0];
    if (display?.id === data.displayId) dispatch('text:spawn', { x: raw.x * display.dip.width, y: raw.y * display.dip.height,
      owner: raw.owner ?? raw.peer ?? 'self', text: line.text, style: settings.roomTextStyle, ...(line.tag ? { tag: line.tag } : {}) });
  });
    await host.listen(PILOT_CH.summoner, ({ payload }) => {
      const spell: unknown = JSON.parse(payload);
      if (data.displayId === 0 && enabled && isSummonerSpellId(spell)) dispatch('summoner:cast', { spell });
    });
  await host.listen(PILOT_CH.roomInput, ({ payload }) => {
    for (const message of pilotRoomMessages(JSON.parse(payload) as unknown, data.displays, settings)) {
      if (message.displayId === data.displayId) dispatch(message.channel, message.payload);
    }
  });
  await host.listen(PILOT_CH.roomGone, ({ payload }) => dispatch('emote:clear', { owner: payload }));
  let roomMembers: string[] = [];
  await host.listen(PILOT_CH.roomChanged, ({ payload }) => {
    const state = JSON.parse(payload) as { phase: string; members: { peer: string }[] };
    if (state.phase === 'idle') for (const owner of roomMembers) dispatch('emote:clear', { owner });
    roomMembers = state.members.map((m) => m.peer);
  });
  await host.listen(PILOT_CH.roomNotice, ({ payload }) => {
    if (data.displayId !== 0) return;
    const notice = JSON.parse(payload) as { kind: string; name?: string; code?: string };
    const t = strings(resolveLang(settings.language, navigator.language), 'win');
    let title = '';
    let body = '';
    if (notice.kind === 'joinedRoom' && notice.code) { title = t.toastRoomJoined(notice.code); body = t.toastRoomJoinedBody; }
    if (notice.kind === 'full') { title = t.toastRoomFull; body = t.toastRoomFullBody; }
      if (notice.kind === 'voteBusy') title = t.voteBusy;
      if (notice.kind === 'kickedYou') title = t.kickedYou;
    if (notice.name) {
      if (notice.kind === 'joined') title = t.toastMemberJoined(notice.name);
      if (notice.kind === 'left') title = t.toastMemberLeft(notice.name);
      if (notice.kind === 'lost') title = t.toastMemberLost(notice.name);
    }
    if (title) dispatch('toast:show', { title, body });
  });
  await host.listen(PILOT_CH.placementChanged, ({ payload }) => {
    const placed = JSON.parse(payload) as { displayId: number; kind: string };
    if (placed.displayId !== data.displayId) {
      if (placed.kind === 'ping') dispatch('ping:unkeep', null);
      if (placed.kind === 'emote') dispatch('emote:clear', { owner: 'self' });
    }
  });
  await host.listen(PILOT_CH.previewed, ({ payload }) => {
    if (data.displayId !== 0) return;
    const preview = JSON.parse(payload) as { kind: string; ref: unknown };
    const display = data.displays.find((d) => d.id === data.displayId);
    if (!display) return;
    const at = { x: display.phys.width / display.scale / 2, y: display.phys.height / display.scale / 2 };
    if (preview.kind === 'ping' && isPingId(preview.ref)) dispatch('ping:spawn', { ...at, id: preview.ref });
    if (preview.kind === 'emote' && isEmoteRefShape(preview.ref)) {
      dispatch('emote:spawn', { ...at, owner: 'preview', art: desktopPilotArt(settings, preview.ref) });
    }
  });
  await host.listen(PILOT_CH.input, ({ payload }) => {
    const event = parseHelperLine(payload);
    if (!event) return;
    if (event.type === 'ready' && event.version !== HELPER_VERSION) return stop(new Error('Helper version mismatch'));
    for (const message of input.handle(event)) {
      if (message.displayId === data.displayId) {
        dispatch(message.channel, message.payload);
        if (event.type === 'click') {
          const display = data.displays.find((d) => d.id === message.displayId);
          if (display) void host.invoke(PILOT_CH.placed, { kind: event.wheel,
            reference: event.wheel === 'emote' ? settings.clickEmoteId : settings.clickPingId,
            x: (event.x - display.phys.x) / display.scale, y: (event.y - display.phys.y) / display.scale }).catch(stop);
        }
      }
    }
  });
  const latest = await host.invoke<PilotSnapshot>(PILOT_CH.ready, {
    config: desktopPilotRuntime(settings, data.status.enabled, navigator.language).config,
    settings,
  });
  if (latest) applySnapshot(latest);
  if (data.demo) {
    const display = data.displays.find((d) => d.id === data.displayId);
    if (!display) return;
    const x = display.phys.width / display.scale / 2;
    const y = display.phys.height / display.scale / 2;
    dispatch('wheel:open', { x, y, wheel: 'ping' });
    dispatch('wheel:move', { x: x + 100, y, wheel: 'ping' });
    setTimeout(() => dispatch('wheel:release', { x: x + 100, y, wheel: 'ping' }), 30000);
  }
}

void start().catch((error: unknown) => {
  console.error(error);
  void pilotHost().invoke(PILOT_CH.stop);
});
