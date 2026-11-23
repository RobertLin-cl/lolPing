import type { SettingsApi } from '../../shared/ipc';
import type { RoomState } from '../../shared/room';
import type { VoteView } from '../../shared/voteTally';
import type { PilotChatHistory } from '../../shared/pilotChat';
import { PILOT_CH } from '../../shared/settingsChannels';
import type { PilotHost } from '../shared/pilotHost';

interface Status {
  room: RoomState & { vote: VoteView | null; voteOver: boolean };
  history: PilotChatHistory;
  roster: boolean; vote: boolean; focused: boolean;
  config: { panelVk: number; summonerKeys: boolean; enabled: boolean };
  result: Record<string, string>;
}
const status = (host: PilotHost): Promise<Status> => host.invoke(PILOT_CH.panelSmoke, { phase: 'status' });

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Panel smoke timed out: ${label}`);
}

function click(selector: string): void {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (!button || button.disabled) throw new Error(`Missing enabled button: ${selector}`);
  button.click();
}

export async function runPanelPageSmoke(host: PilotHost, view: 'roster' | 'vote'): Promise<void> {
  let detail = 'passed';
  try {
    await until(async () => (await status(host))[view], `${view} visible`);
    if ((await status(host)).focused) throw new Error('Panel took focus');
    const data = await host.invoke<{ room: Status['room'] }>(PILOT_CH.panel);
    const session = data.room.members[0]?.peer;
    if (!session) throw new Error('No native session');
    if (view === 'vote') {
      await until(async () => {
        const state = await status(host);
        const own = state.room.members.find((m) => m.self)?.peer;
        return state.room.vote?.kind === 'ready' && !state.room.voteOver && own !== undefined && state.room.vote.ballots[own] === undefined;
      }, 'incoming ready check');
      const denied = await host.invoke(PILOT_CH.panel, { session, action: { t: 'kick', peer: session } }).then(() => false, () => true);
      if (!denied) throw new Error('Vote window could perform roster actions');
      await until(() => document.querySelector<HTMLButtonElement>('.accept')?.disabled === false, 'accept button');
      click('.accept');
      await until(async () => {
        const state = await status(host);
        return state.room.voteOver && state.room.vote?.ballots[session] === true;
      }, 'native ready answer');
    } else {
      await until(() => document.querySelector('.member.me .panel-spell.cooling') !== null, 'cooldown drawing');
      const spells = [...document.querySelectorAll<HTMLImageElement>('.panel-spell img')];
      await until(() => spells.every((image) => image.complete && image.naturalWidth > 0), 'spell icons');
      click('.member.me .tag');
      await until(async () => (await status(host)).history.lines.some((line) => line.kind === 'alive'), 'alive history');
      click('.member.me [data-slot="d"]');
      await until(async () => (await status(host)).history.lines.some((line) => line.kind === 'spell'), 'spell history');
      document.querySelector('.member.me [data-slot="d"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      await until(async () => (await status(host)).room.members[0]?.spells?.d.rechargeEndsAt.length === 0, 'clear cooldown');
      click('.speaker');
      await until(async () => (await status(host)).room.members.some((m) => m.muted), 'mute');
      click('.speaker.on');
      await until(async () => !(await status(host)).room.members.some((m) => m.muted), 'unmute');
      click('.tab:not(.current)');
      await until(() => document.querySelector('[data-category="ping"]') !== null, 'history filter');
      click('[data-category="ping"]');
      await until(() => document.querySelector('[data-category="ping"]')?.getAttribute('aria-pressed') === 'false', 'saved filter');
      click('[data-category="ping"]');
      click('.tab:not(.current)');
      await until(() => document.querySelector('.lol-button.ready') !== null, 'roster return');
      click('.lol-button.ready');
      await until(async () => (await status(host)).history.lines.some((line) => line.kind === 'vote' && line.outcome?.kind === 'ready' && line.outcome.passed), 'ready result');
    }
  } catch (error) { detail = String(error); console.error(error); }
  await host.invoke(PILOT_CH.panelSmoke, { phase: `${view}-page`, detail });
}

export async function runPanelSmoke(api: SettingsApi, host: PilotHost): Promise<void> {
  let detail = '';
  try {
    const original = await api.getSettings();
    const result = await api.setSettings({ features: { ...original.features, roomPanel: true, roomVotes: true, roomSpells: true },
      summonerD: 'heal', summonerF: 'flash', panelHoldS: 0.5, roomTextStyle: 'spot', roomMuted: false });
    if (!result.ok) throw new Error('Could not enable room controls');
    await until(async () => {
      const state = await status(host);
      return state.config.summonerKeys && state.room.members[0]?.spells?.d.spell === 'heal';
    }, 'live spell keys');
    const denied = await host.invoke(PILOT_CH.panel).then(() => false, () => true);
    if (!denied) throw new Error('Settings accessed panel IPC');
    await api.setCapturing(true);
    await host.invoke(PILOT_CH.panelSmoke, { phase: 'cast' });
    await api.setCapturing(false);
    if ((await status(host)).room.members[0]?.spells?.d.rechargeEndsAt.length !== 0) throw new Error('Cast during settings capture');
    await host.invoke(PILOT_CH.panelSmoke, { phase: 'cast' });
    await until(async () => (await status(host)).room.members[0]?.spells?.d.rechargeEndsAt.length === 1, 'passive D cast');
    const cooldown = (await status(host)).room.members[0]?.spells;
    await api.setEnabled(false);
    await until(async () => !(await status(host)).config.summonerKeys, 'pause keys');
    await host.invoke(PILOT_CH.panelSmoke, { phase: 'cast' });
    if (JSON.stringify((await status(host)).room.members[0]?.spells) !== JSON.stringify(cooldown)) throw new Error('Pause changed cooldown');
    await api.setEnabled(true);
    await host.invoke(PILOT_CH.panelSmoke, { phase: 'tap' });
    if ((await status(host)).roster) throw new Error('Quick Tab opened roster');
    await host.invoke(PILOT_CH.panelSmoke, { phase: 'down' });
    await until(async () => {
      const state = await status(host);
      if (state.result['roster-page'] && state.result['roster-page'] !== 'passed') throw new Error(state.result['roster-page']);
      return state.result['roster-page'] === 'passed';
    }, 'roster page');
    await host.invoke(PILOT_CH.panelSmoke, { phase: 'up' });
    await until(async () => !(await status(host)).roster, 'Tab release');
    await host.invoke(PILOT_CH.panelSmoke, { phase: 'incoming' });
    await until(async () => {
      const state = await status(host);
      if (state.result['vote-page'] && state.result['vote-page'] !== 'passed') throw new Error(state.result['vote-page']);
      return state.result['vote-page'] === 'passed';
    }, 'vote page');
    await api.setSettings({ features: { ...result.settings.features, roomPanel: false, roomVotes: false, roomSpells: false } });
    await until(async () => {
      const state = await status(host);
      return !state.roster && !state.vote && state.config.panelVk === 0 && !state.config.summonerKeys && state.room.members[0]?.spells === undefined;
    }, 'disabled features');
  } catch (error) { detail = String(error); console.error(error); }
  await host.invoke(PILOT_CH.panelSmoke, { phase: detail ? 'failed' : 'passed', detail });
  if (detail) throw new Error(detail);
}
