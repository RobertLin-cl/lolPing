import { PILOT_CH } from '../../shared/settingsChannels';
import { OVERLAY_CHANNELS, type OverlayChannel, type OverlayEvents } from '../../shared/ipc';
import { PilotInput } from '../../main/pilotInput';
import { HELPER_VERSION, parseHelperLine } from '../../shared/protocol';
import { desktopPilotArt, desktopPilotRuntime, desktopPilotSettings } from '../../shared/desktopPilot';
import { isEmoteRefShape } from '../../shared/emotes';
import { isPingId } from '../../shared/pings';
import { pilotHost, type PilotBootstrap, type PilotSnapshot } from '../shared/pilotHost';

async function start(): Promise<void> {
  const host = pilotHost();
  const data = await host.invoke<PilotBootstrap>(PILOT_CH.bootstrap);
  let settings = desktopPilotSettings(data.settings);
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
    reportPing() { void host.invoke(PILOT_CH.placed, { kind: 'ping' }).catch(stop); },
    reportEmote() { void host.invoke(PILOT_CH.placed, { kind: 'emote' }).catch(stop); },
    reportIdle(idle) { void host.invoke(PILOT_CH.idle, { idle }).catch(stop); },
  };
  await import('./main');
  dispatch('overlay:settings', desktopPilotRuntime(settings, data.status.enabled, navigator.language).overlay);
  const applySnapshot = (snapshot: PilotSnapshot): void => {
    if (snapshot.revision < revision) return;
    revision = snapshot.revision;
    settings = desktopPilotSettings(snapshot.settings);
    dispatch('overlay:settings', desktopPilotRuntime(settings, snapshot.status.enabled, navigator.language).overlay);
    dispatch('wheel:cancel', null);
  };
  await host.listen(PILOT_CH.settingsChanged, ({ payload }) => applySnapshot(JSON.parse(payload) as PilotSnapshot));
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
        if (event.type === 'click') void host.invoke(PILOT_CH.placed, { kind: event.wheel }).catch(stop);
      }
    }
  });
  const latest = await host.invoke<PilotSnapshot>(PILOT_CH.ready, {
    config: desktopPilotRuntime(settings, data.status.enabled, navigator.language).config,
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
