import { PILOT_CH } from '../../shared/settingsChannels';
import { desktopPilotSettings } from '../../shared/desktopPilot';
import { pilotChatLines, pilotChatSubmission, pilotChatWords, type PilotChatHistory } from '../../shared/pilotChat';
import type { TextAnswer } from '../../shared/ipc';
import type { RoomState } from '../../shared/room';
import { pilotHost, type PilotSnapshot } from '../shared/pilotHost';

const host = pilotHost();
let currentGeneration: number | undefined;
interface ChatSnapshot extends PilotSnapshot { history: PilotChatHistory; room: RoomState; chatSmoke?: boolean; generation: number }

async function start(): Promise<void> {
  let data = await host.invoke<ChatSnapshot>(PILOT_CH.chat, { action: 'snapshot' });
  const generation = data.generation;
  currentGeneration = generation;
  let settings = desktopPilotSettings(data.settings);
  let history = data.history;
  const lineCallbacks = new Set<Parameters<NonNullable<typeof window.textApi>['onLines']>[0]>();
  const filterCallbacks = new Set<Parameters<NonNullable<typeof window.textApi>['onFilter']>[0]>();
  const refresh = (): void => { for (const cb of lineCallbacks) cb(pilotChatLines(history.lines, settings, navigator.language)); };
  await host.listen(PILOT_CH.chatHistory, ({ payload }) => {
    const next = JSON.parse(payload) as PilotChatHistory;
    if (next.revision < history.revision) return;
    history = next; refresh();
  });
  await host.listen(PILOT_CH.settingsChanged, ({ payload }) => {
    const snapshot = JSON.parse(payload) as PilotSnapshot;
    settings = desktopPilotSettings(snapshot.settings);
    for (const cb of filterCallbacks) cb(settings.chatFilter);
    refresh();
  });
  window.textApi = {
    submit: async (raw) => {
      data = await host.invoke<ChatSnapshot>(PILOT_CH.chat, { action: 'snapshot' });
      const result = pilotChatSubmission(raw, data.room, data.history.replyTo, desktopPilotSettings(data.settings).features.roomVotes);
      return result.command ? host.invoke<TextAnswer>(PILOT_CH.chat, { action: 'submit', command: result.command, generation }) : result.answer;
    },
    hide: () => { void host.invoke(PILOT_CH.chat, { action: 'hide', generation }); },
    strings: async () => pilotChatWords(settings, navigator.language),
    filter: async () => settings.chatFilter,
    lines: async () => pilotChatLines(history.lines, settings, navigator.language),
    names: async () => (await host.invoke<ChatSnapshot>(PILOT_CH.chat, { action: 'snapshot' })).room.members.filter((m) => !m.self).map((m) => m.name),
    hover: (on) => { void host.invoke(PILOT_CH.chat, { action: 'hover', on, generation }); },
    onLines: (cb) => { lineCallbacks.add(cb); return () => lineCallbacks.delete(cb); },
    onFilter: (cb) => { filterCallbacks.add(cb); return () => filterCallbacks.delete(cb); },
  };
  document.getElementById('bar')?.addEventListener('mousedown', (event) => {
    if (event.button === 0 && !(event.target instanceof HTMLElement && event.target.closest('button'))) {
      void host.invoke(PILOT_CH.chat, { action: 'drag', generation });
    }
  });
  await import('./main');
  const latest = await host.invoke<ChatSnapshot>(PILOT_CH.chat, { action: 'snapshot' });
  if (latest.history.revision >= history.revision) { history = latest.history; refresh(); }
  await host.invoke(PILOT_CH.chat, { action: 'ready', generation });
  let smokeStarted = false;
  const smoke = async (): Promise<void> => {
    if (smokeStarted) return;
    smokeStarted = true;
    const { runPilotChatSmoke } = await import('./pilotChatSmoke');
    await runPilotChatSmoke(host);
  };
  await host.listen(PILOT_CH.chatSmokeStart, () => { void smoke(); });
  if ((await host.invoke<ChatSnapshot>(PILOT_CH.chat, { action: 'snapshot' })).chatSmoke) void smoke();
}

void start().catch((error: unknown) => {
  console.error(error);
  if (currentGeneration !== undefined) void host.invoke(PILOT_CH.chat, { action: 'hide', generation: currentGeneration }).catch(() => undefined);
});
