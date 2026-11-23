import { PILOT_CH } from '../../shared/settingsChannels';
import { desktopPilotSettings } from '../../shared/desktopPilot';
import { pilotChatLines, type PilotChatHistory } from '../../shared/pilotChat';
import { resolveLang } from '../../shared/i18n';
import type { PanelState } from '../../shared/ipc';
import type { RoomState } from '../../shared/room';
import { pilotHost, type PilotSnapshot } from '../shared/pilotHost';

interface Snapshot extends PilotSnapshot {
  room: RoomState & { vote: PanelState['vote']; voteOver: boolean };
  history: PilotChatHistory;
  view: PanelState['view'];
  panelSmoke?: boolean;
}

async function start(): Promise<void> {
  const host = pilotHost();
  let data = await host.invoke<Snapshot>(PILOT_CH.panel);
  const callbacks = new Set<(state: PanelState) => void>();
  let last = '';
  const refresh = async (): Promise<void> => {
    data = await host.invoke<Snapshot>(PILOT_CH.panel);
    const settings = desktopPilotSettings(data.settings);
    const state: PanelState = { view: data.view, lang: resolveLang(settings.language, navigator.language), max: 16,
      room: data.room, history: pilotChatLines(data.history.lines, settings, navigator.language), chatFilter: settings.chatFilter,
      vote: data.room.vote, voteOver: data.room.voteOver, textOn: settings.features.roomText,
      votesOn: settings.features.roomVotes, volume: settings.muted ? 0 : settings.volume / 100 };
    const next = JSON.stringify(state);
    if (next === last) return;
    last = next;
    for (const cb of callbacks) cb(state);
    if (state.view === 'vote' && state.vote) await host.invoke(PILOT_CH.panel, { action: { t: 'title', text: document.title } });
  };
  window.panelApi = {
    on: (cb) => { callbacks.add(cb); return () => callbacks.delete(cb); },
    act: (action) => { void host.invoke(PILOT_CH.panel, { action: { ...action, ...(action.t === 'ballot' ? { voteId: data.room.vote?.id } : {}) },
      session: data.room.members[0]?.peer }).catch(console.error); },
  };
  await import('./main');
  await refresh();
  for (const event of [PILOT_CH.roomChanged, PILOT_CH.settingsChanged, PILOT_CH.chatHistory]) {
    await host.listen(event, () => { void refresh().catch(console.error); });
  }
  await refresh();
  await host.invoke(PILOT_CH.panel, { action: { t: 'ready' } });
  if (data.panelSmoke) {
    const { runPanelPageSmoke } = await import('./pilotSmoke');
    void runPanelPageSmoke(host, data.view);
  }
}

void start().catch(console.error);
