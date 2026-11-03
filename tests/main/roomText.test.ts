import { DEFAULT_CHAT_FILTER, type ChatFilter } from '../../src/shared/chatFilter';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { RoomHistory } from '../../src/main/roomHistory';
import { postLine, postPing, startRoomText, type RoomPingTextDeps, type RoomTextDeps } from '../../src/main/roomText';
import { castSpell, createSpellCooldown } from '../../src/shared/summonerSpells';
import type { RemoteSpell } from '../../src/main/roomManager';
import type { RemoteText, RemoteWhisper } from '../../src/main/roomManager';
import { ALL_PINGS } from '../../src/shared/pings';
import { strings } from '../../src/shared/i18n';
import type { RoomMember } from '../../src/shared/room';

type Shown = Parameters<RoomTextDeps['show']>[0];

const member = (peer: string, name: string, self = false): RoomMember => ({
  peer, name, color: 2, rgb: null, path: 'lan', status: 'on', needsUpdate: false, noEmotes: false, noChat: false,
  textOff: false, votesOff: false, muted: false, self,
});

/** A room that only has members and events, which is all the text unit looks at. */
class FakeRoom extends EventEmitter {
  members = [member('me', 'Sam', true), member('alex', 'Alex'), member('kim', 'Kim')];
  state(): { members: RoomMember[] } {
    return { members: this.members };
  }
}

function setup(lang: 'en' | 'zh-CN' = 'en', filter: ChatFilter = { ...DEFAULT_CHAT_FILTER }) {
  const room = new FakeRoom();
  const history = new RoomHistory();
  const shown: Shown[] = [];
  const whispered: string[] = [];
  const visibility: boolean[] = [];
  const whisperVisibility: boolean[] = [];
  const deps: RoomTextDeps = {
    room: room as unknown as RoomTextDeps['room'],
    show: (p, visible) => { shown.push(p); visibility.push(visible); },
    filter: () => filter,
    history,
    text: () => strings(lang),
    now: () => 1234,
    whispered: (peer, visible) => { whispered.push(peer); whisperVisibility.push(visible); },
  };
  return { room, history, shown, whispered, visibility, whisperVisibility, deps, stop: startRoomText(deps) };
}

const spoken = (over: Partial<RemoteText>): RemoteText => ({
  kind: 'text', peer: 'alex', tag: { name: 'Alex', color: 2, rgb: [10, 20, 30] }, displayId: 7, x: 100, y: 50, text: 'push mid', ...over,
});

describe('startRoomText', () => {
  it('shows a member\'s text under their tag and keeps it in the history', () => {
    const { room, shown, history } = setup();
    room.emit('remoteText', spoken({}));
    expect(shown).toEqual([
      { displayId: 7, x: 100, y: 50, text: 'push mid', owner: 'alex', tag: { name: 'Alex', color: 2, rgb: [10, 20, 30] } },
    ]);
    expect(history.lines()).toEqual([
      { at: 1234, kind: 'text', tag: { name: 'Alex', color: 2, rgb: [10, 20, 30] }, text: 'push mid' },
    ]);
  });

  it('writes an alive line with the clicked member\'s name under the clicker\'s tag', () => {
    const { room, shown, history } = setup();
    room.emit('remoteText', spoken({ kind: 'alive', text: undefined, who: 'kim' }));
    expect(shown).toHaveLength(1);
    expect(shown[0].text).toBe('Kim - Alive');
    expect(shown[0].tag?.name).toBe('Alex');
    expect(history.lines()[0]).toMatchObject({ kind: 'alive', text: 'Kim - Alive', tag: { name: 'Alex' } });
  });

  it('writes the alive line in our own language', () => {
    const { room, shown } = setup('zh-CN');
    room.emit('remoteText', spoken({ kind: 'alive', text: undefined, who: 'kim' }));
    expect(shown[0].text).toBe('Kim - 存活');
  });

  it('shows our own name when the clicked member is us', () => {
    const { room, shown } = setup();
    room.emit('remoteText', spoken({ kind: 'alive', text: undefined, who: 'me' }));
    expect(shown[0].text).toBe('Sam - Alive');
  });

  it('formats a spell snapshot at click time and records it under scoreboard without popping hidden chat', () => {
    const { room, history, visibility, shown, stop } = setup('en', { ...DEFAULT_CHAT_FILTER, scoreboard: false });
    const click: RemoteSpell = { at: 55000, peer: 'alex', who: 'kim', slot: 'f',
      cooldown: castSpell(createSpellCooldown('flash'), 0).cooldown,
      tag: { name: 'Alex', color: 2, rgb: null }, displayId: 7, x: 100, y: 50 };
    room.emit('remoteSpell', click);
    expect(shown[0].text).toBe('Wait For Kim Flash - 245s');
    expect(history.lines()[0]).toMatchObject({ kind: 'spell', tag: { name: 'Alex' } });
    expect(visibility).toEqual([false]);
    room.emit('remoteSpell', { ...click, who: 'stranger' });
    expect(history.lines()).toHaveLength(1);
    stop();
    room.emit('remoteSpell', click);
    expect(history.lines()).toHaveLength(1);
  });

  it('drops an alive line for a member we do not know', () => {
    const { room, shown, history } = setup();
    room.emit('remoteText', spoken({ kind: 'alive', text: undefined, who: 'stranger' }));
    expect(shown).toEqual([]);
    expect(history.lines()).toEqual([]);
  });

  it('ignores a text event that carries no text', () => {
    const { room, shown } = setup();
    room.emit('remoteText', spoken({ text: undefined }));
    expect(shown).toEqual([]);
  });

  it('keeps a whisper in the history only, under the sender\'s tag, and says who sent it', () => {
    const { room, shown, history, whispered } = setup();
    const whisper: RemoteWhisper = { peer: 'alex', tag: { name: 'Alex', color: 2, rgb: [10, 20, 30] }, text: 'come bot' };
    room.emit('whisper', whisper);
    expect(shown).toEqual([]); // it has no spot on the screen
    expect(history.lines()).toEqual([
      { at: 1234, kind: 'whisperFrom', tag: { name: 'Alex', color: 2, rgb: [10, 20, 30] }, text: 'come bot' },
    ]);
    expect(whispered).toEqual(['alex']);
  });

  it('keeps hidden text and scoreboard lines while marking them not to pop chat', () => {
    const { room, history, visibility } = setup('en', { ...DEFAULT_CHAT_FILTER, text: false, scoreboard: false });
    room.emit('remoteText', spoken({}));
    room.emit('remoteText', spoken({ kind: 'alive', who: 'kim' }));
    expect(history.lines().map((line) => line.kind)).toEqual(['text', 'alive']);
    expect(visibility).toEqual([false, false]);
  });

  it('keeps a hidden whisper and its reply target without popping chat', () => {
    const { room, history, whispered, whisperVisibility } = setup('en', { ...DEFAULT_CHAT_FILTER, whisper: false });
    room.emit('whisper', { peer: 'alex', tag: { name: 'Alex', color: 2, rgb: null }, text: 'hi' } satisfies RemoteWhisper);
    expect(history.lines()[0]).toMatchObject({ kind: 'whisperFrom', text: 'hi' });
    expect(whispered).toEqual(['alex']);
    expect(whisperVisibility).toEqual([false]);
  });

  it('stops listening when stopped', () => {
    const { room, shown, history, whispered, stop } = setup();
    stop();
    room.emit('remoteText', spoken({}));
    room.emit('whisper', { peer: 'alex', tag: { name: 'Alex', color: 2, rgb: null }, text: 'hi' } satisfies RemoteWhisper);
    expect(shown).toEqual([]);
    expect(history.lines()).toEqual([]);
    expect(whispered).toEqual([]);
    expect(room.listenerCount('remoteText')).toBe(0);
    expect(room.listenerCount('whisper')).toBe(0);
  });
});

describe('postLine', () => {
  it('shows our own line and keeps it in the history, like a member\'s', () => {
    const { deps, shown, history } = setup();
    postLine(deps, {
      kind: 'text', owner: 'self', tag: { name: 'Sam', color: 0, rgb: null }, displayId: 3, x: 5, y: 6, text: 'gg',
    });
    expect(shown).toEqual([{ displayId: 3, x: 5, y: 6, text: 'gg', owner: 'self', tag: { name: 'Sam', color: 0, rgb: null } }]);
    expect(history.lines()).toEqual([{ at: 1234, kind: 'text', tag: { name: 'Sam', color: 0, rgb: null }, text: 'gg' }]);
  });

  it('marks a hidden vote result not to pop chat while keeping it in history', () => {
    const { deps, visibility, history } = setup('en', { ...DEFAULT_CHAT_FILTER, vote: false });
    postLine(deps, { kind: 'vote', owner: 'vote', tag: null, displayId: 3, x: 5, y: 6, text: 'Everyone is ready' });
    expect(visibility).toEqual([false]);
    expect(history.lines()[0]).toMatchObject({ kind: 'vote', text: 'Everyone is ready' });
  });

  it('shows a vote result with no name tag and keeps it in the history', () => {
    const { deps, shown, history } = setup();
    postLine(deps, { kind: 'vote', owner: 'vote', tag: null, displayId: 3, x: 5, y: 6, text: 'Everyone is ready' });
    expect(shown).toEqual([{ displayId: 3, x: 5, y: 6, text: 'Everyone is ready', owner: 'vote' }]);
    expect(history.lines()).toEqual([{ at: 1234, kind: 'vote', tag: null, text: 'Everyone is ready' }]);
  });
});

describe('postPing', () => {
  function setupPing(over: Partial<RoomPingTextDeps> = {}) {
    const history = new RoomHistory();
    const shown: number[] = [];
    const deps: RoomPingTextDeps = {
      history, filter: () => ({ ...DEFAULT_CHAT_FILTER }), now: () => 1234, text: () => strings('en'), enabled: () => true, style: () => 'window',
      show: () => shown.push(history.lines().length), ...over,
    };
    return { deps, history, shown };
  }
  const own = { name: 'Sam', color: 0, rgb: null };
  const remote = { name: 'Alex', color: 2, rgb: [10, 20, 30] as const };

  it('records our own pings and other members pings with their tags before showing chat', () => {
    const { deps, history, shown } = setupPing();
    postPing(deps, 'danger', own);
    postPing(deps, 'omw', remote);
    expect(history.lines()).toEqual([
      { at: 1234, kind: 'ping', tag: own, text: 'signals to retreat' },
      { at: 1234, kind: 'ping', tag: remote, text: 'is on the way' },
    ]);
    expect(shown).toEqual([1, 2]);
  });

  it('records every non-generic ping in each UI language', () => {
    for (const lang of ['en', 'zh-CN', 'zh-TW'] as const) {
      const { deps, history } = setupPing({ text: () => strings(lang) });
      for (const ping of ALL_PINGS) postPing(deps, ping.id, remote);
      expect(history.lines()).toHaveLength(11);
      expect(history.lines().every((line) => line.kind === 'ping' && line.text.length > 0)).toBe(true);
      expect(history.lines().at(-1)?.text).toBe(lang === 'en' ? 'signals ¿' : lang === 'zh-CN' ? '发出了 ¿' : '發出了 ¿');
    }
  });

  it('uses the local language for the sentence', () => {
    const { deps, history } = setupPing({ text: () => strings('zh-TW') });
    postPing(deps, 'danger', remote);
    postPing(deps, 'assist', own);
    expect(history.lines().map((line) => line.text)).toEqual(['發出信號請求撤退', '要求隊友盡速支援']);
  });

  it('records pings without popping chat for spot and scrolling text styles', () => {
    for (const style of ['spot', 'danmaku'] as const) {
      const { deps, history, shown } = setupPing({ style: () => style });
      postPing(deps, 'missing', own);
      expect(history.lines()).toHaveLength(1);
      expect(shown).toEqual([]);
    }
  });

  it('records a hidden ping without popping chat', () => {
    const { deps, history, shown } = setupPing({ filter: () => ({ ...DEFAULT_CHAT_FILTER, ping: false }) });
    postPing(deps, 'danger', own);
    expect(history.lines()[0]).toMatchObject({ kind: 'ping', text: 'signals to retreat' });
    expect(shown).toEqual([]);
  });

  it('does not record generic pings or show chat for them', () => {
    const { deps, history, shown } = setupPing();
    postPing(deps, 'generic', own);
    expect(history.lines()).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('does not record or show pings when room chat is not active', () => {
    const { deps, history, shown } = setupPing({ enabled: () => false });
    postPing(deps, 'danger', own);
    postPing(deps, 'missing', remote);
    expect(history.lines()).toEqual([]);
    expect(shown).toEqual([]);
  });
});
