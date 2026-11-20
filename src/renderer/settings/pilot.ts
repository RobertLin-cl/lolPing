import { PILOT_CH } from '../../shared/settingsChannels';
import { desktopPilotRuntime, desktopPilotSettings, updateDesktopPilotSettings } from '../../shared/desktopPilot';
import type { AppStatus, SettingsApi, SetSettingsResult } from '../../shared/ipc';
import { resolveLang, strings } from '../../shared/i18n';
import type { Settings } from '../../shared/settings';
import { pilotHost, type PilotSnapshot } from '../shared/pilotHost';
import { customHash, customStillUrl, isEmoteFx } from '../../shared/emotes';
import './pilot.css';

const host = pilotHost();
const unsupported = (): Promise<never> => Promise.reject(new Error('This desktop service has not been migrated'));
const subscribe = <T>(event: string, pick: (snapshot: PilotSnapshot) => T, cb: (value: T) => void): (() => void) => {
  let stopped = false;
  let unlisten: (() => void) | undefined;
  void host.listen(event, ({ payload }) => { if (!stopped) cb(pick(JSON.parse(payload) as PilotSnapshot)); })
    .then((off) => { if (stopped) off(); else unlisten = off; });
  return () => { stopped = true; unlisten?.(); };
};

let writing: Promise<unknown> = Promise.resolve();
const save = (edit: (settings: Settings) => SetSettingsResult): Promise<SetSettingsResult> => {
  const next = writing.then(async () => {
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
  writing = next.catch(() => undefined);
  return next;
};
const update = (patch: Partial<Settings>): Promise<SetSettingsResult> =>
  save((settings) => updateDesktopPilotSettings(settings, patch, navigator.language));

const api: SettingsApi = {
  platform: 'win',
  capabilities: { features: ['emotes'], autoStart: false, emoteFiles: false },
  getSettings: async () => desktopPilotSettings((await host.invoke<PilotSnapshot>(PILOT_CH.snapshot)).settings),
  setSettings: update,
  onSettings: (cb) => subscribe(PILOT_CH.settingsChanged, (s) => desktopPilotSettings(s.settings), cb),
  getStatus: async () => (await host.invoke<PilotSnapshot>(PILOT_CH.snapshot)).status,
  onStatus: (cb) => subscribe<AppStatus>(PILOT_CH.statusChanged, (s) => s.status, cb),
  setEnabled: (enabled) => host.invoke(PILOT_CH.enabled, { enabled }),
  previewPing: (ref) => host.invoke(PILOT_CH.preview, { kind: 'ping', reference: ref }),
  previewEmote: (ref) => host.invoke(PILOT_CH.preview, { kind: 'emote', reference: ref }),
  importEmote: unsupported, removeEmote: unsupported, setEmoteSound: unsupported,
  setEmoteFx: async (id, fx) => {
    if (fx !== undefined && !isEmoteFx(fx)) return;
    await save((s) => ({ ok: true, settings: desktopPilotSettings({ ...s,
      customEmotes: s.customEmotes.map((c) => c.id === id ? { ...c, fx } : c) }) }));
  },
  getAbout: async () => {
    const s = desktopPilotSettings((await host.invoke<PilotSnapshot>(PILOT_CH.snapshot)).settings);
    const t = strings(resolveLang(s.language, navigator.language), 'win');
    return { version: '0.1.0', problems: [], limitations: [t.pilotLimitations] };
  },
  openSettingsFolder: () => host.invoke(PILOT_CH.openFolder),
  openProjectPage: () => host.invoke(PILOT_CH.openProject),
  retryHelper: () => host.invoke(PILOT_CH.retry),
  setCapturing: (on) => host.invoke(PILOT_CH.capture, { on }),
  openAccessibility: unsupported,
  getRoom: unsupported, onRoom: () => () => {}, createRoom: unsupported, joinRoom: unsupported,
  leaveRoom: unsupported, muteMember: unsupported, clipboardRoomCode: unsupported, copyRoomCode: unsupported,
  retryInternet: unsupported, onShowSection: () => () => {},
  getUpdate: async () => null, onUpdate: () => () => {}, checkForUpdates: unsupported,
  startUpdate: unsupported, openReleasePage: unsupported,
  setTeammateKey: unsupported, hasTeammateKey: unsupported, checkTeammateKey: unsupported,
  checkTeammateAgent: unsupported, pickTeammateFolder: unsupported, getTeammateAgentSnippet: unsupported,
  getTeammateConnectSnippet: unsupported, getTeammateRecentApps: unsupported, getTeammateEditors: unsupported,
  setTeammateInstructions: unsupported, getTeammateInstructions: unsupported, getTeammateUsage: unsupported,
  teammateHistory: unsupported, getTeammateStatus: unsupported, openScreenRecording: unsupported,
};

window.settingsApi = api;
void import('./main');

async function smokeTest(): Promise<void> {
  const snapshot = await host.invoke<PilotSnapshot & { smoke?: boolean }>(PILOT_CH.snapshot);
  if (!snapshot.smoke) return;
  const original = desktopPilotSettings(snapshot.settings);
  try {
    await api.setEnabled(false);
    const changed = await update({ volume: original.volume === 41 ? 42 : 41 });
    const stored = await api.getSettings();
    if (!changed.ok || stored.volume !== changed.settings.volume || (await api.getStatus()).enabled) {
      throw new Error('Settings round trip failed');
    }
    const restored = await update({ volume: original.volume });
    if (!restored.ok) throw new Error('Could not restore settings');
    await api.setEnabled(snapshot.status.enabled);
    await api.previewPing('danger');
    await api.previewEmote(original.clickEmoteId);
    if (original.customEmotes.length) {
      const res = await fetch(customStillUrl(customHash(original.customEmotes[0].id)));
      if (!res.ok || (await res.arrayBuffer()).byteLength === 0) throw new Error('Custom image could not be read');
    }
    await host.invoke(PILOT_CH.smokeResult, { passed: true });
  } catch (error) {
    console.error(error);
    await host.invoke(PILOT_CH.smokeResult, { passed: false });
  }
}
void smokeTest();
