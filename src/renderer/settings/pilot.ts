import { PILOT_CH } from '../../shared/settingsChannels';
import { desktopPilotRuntime, desktopPilotSettings, updateDesktopPilotSettings } from '../../shared/desktopPilot';
import type { AppStatus, SettingsApi, SetSettingsResult } from '../../shared/ipc';
import type { ImportResult, SoundResult } from '../../shared/emotes';
import { emoteUpload, imageUpload } from '../../shared/emoteUpload';
import { resolveLang, strings } from '../../shared/i18n';
import type { Settings } from '../../shared/settings';
import { pilotHost, type PilotSnapshot } from '../shared/pilotHost';
import { isEmoteFx } from '../../shared/emotes';
import type { RoomState } from '../../shared/room';
import { formatRoomCode, parseRoomCode } from '../../shared/roomCode';
import './pilot.css';
import { pilotUpdateState } from '../../shared/pilotUpdate';

const host = pilotHost();
let updateSettings = desktopPilotSettings(null);
const unsupported = (): Promise<never> => Promise.reject(new Error('This desktop service has not been migrated'));
const subscribe = <T>(event: string, pick: (snapshot: PilotSnapshot) => T, cb: (value: T) => void): (() => void) => {
  let stopped = false;
  let unlisten: (() => void) | undefined;
  void host.listen(event, ({ payload }) => { if (!stopped) cb(pick(JSON.parse(payload) as PilotSnapshot)); })
    .then((off) => { if (stopped) off(); else unlisten = off; });
  return () => { stopped = true; unlisten?.(); };
};

let writing: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(run: () => Promise<T>): Promise<T> => {
  const next = writing.then(run);
  writing = next.catch(() => undefined);
  return next;
};
const save = (edit: (settings: Settings) => SetSettingsResult): Promise<SetSettingsResult> => {
  return oneAtATime(async () => {
    const snapshot = await host.invoke<PilotSnapshot>(PILOT_CH.snapshot);
    const current = desktopPilotSettings(snapshot.settings);
    const result = edit(current);
    if (!result.ok) return result;
    const runtime = desktopPilotRuntime(result.settings, snapshot.status.enabled, navigator.language);
    try {
      await host.invoke(PILOT_CH.save, { settings: result.settings, config: runtime.config, revision: snapshot.revision });
    } catch (error) {
      console.error(error);
      const t = strings(resolveLang(current.language, navigator.language), 'win');
      return { ok: false, error: t.pilotSaveFailed, settings: current } as const;
    }
    return result;
  });
};
const update = (patch: Partial<Settings>): Promise<SetSettingsResult> =>
  save((settings) => updateDesktopPilotSettings(settings, patch, navigator.language));

async function mutationSettings() {
  const snapshot = await host.invoke<PilotSnapshot>(PILOT_CH.snapshot);
  const settings = desktopPilotSettings(snapshot.settings);
  return { settings, revision: snapshot.revision,
    config: desktopPilotRuntime(settings, snapshot.status.enabled, navigator.language).config };
}

const api: SettingsApi = {
  platform: 'win',
  capabilities: { features: ['emotes', 'rooms', 'roomText', 'roomVotes', 'roomPanel', 'roomSpells'], autoStart: false, emoteFiles: true },
  getSettings: async () => desktopPilotSettings((await host.invoke<PilotSnapshot>(PILOT_CH.snapshot)).settings),
  setSettings: update,
  onSettings: (cb) => subscribe(PILOT_CH.settingsChanged, (s) => desktopPilotSettings(s.settings), cb),
  getStatus: async () => (await host.invoke<PilotSnapshot>(PILOT_CH.snapshot)).status,
  onStatus: (cb) => subscribe<AppStatus>(PILOT_CH.statusChanged, (s) => s.status, cb),
  setEnabled: (enabled) => host.invoke(PILOT_CH.enabled, { enabled }),
  previewPing: (ref) => host.invoke(PILOT_CH.preview, { kind: 'ping', reference: ref }),
  previewEmote: (ref) => host.invoke(PILOT_CH.preview, { kind: 'emote', reference: ref }),
  importEmote: (file) => oneAtATime(async (): Promise<ImportResult> => {
    const live = await mutationSettings();
    return host.invoke(PILOT_CH.importEmote, imageUpload(live, file));
  }),
  removeEmote: (id) => oneAtATime(async () => {
    const live = await mutationSettings();
    const settings = desktopPilotSettings({ ...live.settings, customEmotes: live.settings.customEmotes.filter((c) => c.id !== id) });
    await host.invoke(PILOT_CH.removeEmote, { id, live: { ...live, settings } });
  }),
  setEmoteSound: (id, bytes) => oneAtATime(async (): Promise<SoundResult> => {
    const live = await mutationSettings();
    return host.invoke(PILOT_CH.emoteSound, emoteUpload({ live, id, length: bytes?.length ?? null }, bytes ? [bytes] : []));
  }),
  setEmoteFx: async (id, fx) => {
    if (fx !== undefined && !isEmoteFx(fx)) return;
    await save((s) => ({ ok: true, settings: desktopPilotSettings({ ...s,
      customEmotes: s.customEmotes.map((c) => c.id === id ? { ...c, fx } : c) }) }));
  },
  getAbout: async () => {
    const snapshot = await host.invoke<PilotSnapshot>(PILOT_CH.snapshot);
    const s = desktopPilotSettings(snapshot.settings);
    const t = strings(resolveLang(s.language, navigator.language), 'win');
    return { version: snapshot.version ?? '0.1.0', problems: [], limitations: [t.pilotLimitations] };
  },
  openSettingsFolder: () => host.invoke(PILOT_CH.openFolder),
  openProjectPage: () => host.invoke(PILOT_CH.openProject),
  retryHelper: () => host.invoke(PILOT_CH.retry),
  setCapturing: (on) => host.invoke(PILOT_CH.capture, { on }),
  openAccessibility: unsupported,
  getRoom: () => host.invoke(PILOT_CH.room, { action: 'get' }),
  onRoom: (cb) => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void host.listen(PILOT_CH.roomChanged, ({ payload }) => { if (!stopped) cb(JSON.parse(payload) as RoomState); })
      .then((off) => { if (stopped) off(); else unlisten = off; });
    return () => { stopped = true; unlisten?.(); };
  },
  createRoom: async () => { await host.invoke(PILOT_CH.room, { action: 'create' }); },
  joinRoom: async (text) => {
    const parsed = parseRoomCode(text);
    if (!parsed.ok) return parsed;
    try { await host.invoke(PILOT_CH.room, { action: 'join', code: parsed.code }); return { ok: true }; }
    catch { return { ok: false, error: 'failed' }; }
  },
  leaveRoom: async () => { await host.invoke(PILOT_CH.room, { action: 'leave' }); },
  muteMember: async (peer, on) => { await host.invoke(PILOT_CH.room, { action: 'mute', peer, on }); },
  clipboardRoomCode: async () => {
    try {
      const text = await host.invoke<string>(PILOT_CH.room, { action: 'clipboard' });
      const code = parseRoomCode(text, { strict: true });
      return code.ok ? formatRoomCode(code.code) : null;
    } catch { return null; }
  },
  copyRoomCode: async () => { await host.invoke(PILOT_CH.room, { action: 'copy' }); },
  retryInternet: async () => { await host.invoke(PILOT_CH.room, { action: 'retry' }); },
  onShowSection: () => () => {},
  getUpdate: async () => pilotUpdateState(await host.invoke(PILOT_CH.update, { action: 'get' }), updateSettings, navigator.language),
  onUpdate: (cb) => {
    let stopped = false;
    let revision = -1;
    const stops: (() => void)[] = [];
    const push = (raw: unknown): void => {
      if (typeof raw === 'object' && raw !== null) {
        const next = (raw as Record<string, unknown>).revision;
        if (typeof next === 'number') {
          if (next < revision) return;
          revision = next;
        }
      }
      const state = pilotUpdateState(raw, updateSettings, navigator.language);
      if (!stopped && state) cb(state);
    };
    const listen = async (): Promise<void> => {
      const off = await host.listen(PILOT_CH.updateChanged, ({ payload }) => push(JSON.parse(payload) as unknown));
      if (stopped) off(); else stops.push(off);
      const settingsOff = await host.listen(PILOT_CH.settingsChanged, ({ payload }) => {
        updateSettings = desktopPilotSettings((JSON.parse(payload) as PilotSnapshot).settings);
        void host.invoke(PILOT_CH.update, { action: 'get' }).then(push);
      });
      if (stopped) settingsOff(); else stops.push(settingsOff);
    };
    void listen();
    return () => { stopped = true; for (const stop of stops) stop(); };
  },
  checkForUpdates: async () => { await host.invoke(PILOT_CH.update, { action: 'check' }); },
  startUpdate: async () => { await host.invoke(PILOT_CH.update, { action: 'start' }); },
  openReleasePage: async () => { await host.invoke(PILOT_CH.update, { action: 'open' }); },
  setTeammateKey: unsupported, hasTeammateKey: unsupported, checkTeammateKey: unsupported,
  checkTeammateAgent: unsupported, pickTeammateFolder: unsupported, getTeammateAgentSnippet: unsupported,
  getTeammateConnectSnippet: unsupported, getTeammateRecentApps: unsupported, getTeammateEditors: unsupported,
  setTeammateInstructions: unsupported, getTeammateInstructions: unsupported, getTeammateUsage: unsupported,
  teammateHistory: unsupported, getTeammateStatus: unsupported, openScreenRecording: unsupported,
};

window.settingsApi = api;

void host.invoke<PilotSnapshot & { smoke?: boolean; roomSmoke?: boolean; startupSmoke?: boolean; updateSmoke?: boolean }>(PILOT_CH.snapshot).then(async (snapshot) => {
  if (api.capabilities) api.capabilities.autoStart = snapshot.autoStart === true;
  updateSettings = desktopPilotSettings(snapshot.settings);
  await import('./main');
  if (snapshot.updateSmoke) {
    const { runUpdateSmoke } = await import('./pilotUpdateSmoke');
    await runUpdateSmoke(api,host); return;
  }
  if (snapshot.startupSmoke) {
    const { runStartupSmoke } = await import('./pilotStartupSmoke');
    await runStartupSmoke(api,host); return;
  }
  if (snapshot.roomSmoke) {
    const { runPilotRoomSmoke } = await import('./pilotRoomSmoke');
    await runPilotRoomSmoke(api, host);
    return;
  }
  if (!snapshot.smoke) return;
  const { runPilotSmoke } = await import('./pilotSmoke');
  await runPilotSmoke(api, host, snapshot);
});
