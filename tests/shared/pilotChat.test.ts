import { describe, expect, it } from 'vitest';
import { pilotChatLines, pilotChatSubmission } from '../../src/shared/pilotChat';
import { desktopPilotSettings } from '../../src/shared/desktopPilot';
import type { RoomMember, RoomState } from '../../src/shared/room';
import { strings } from '../../src/shared/i18n';
import { summonerText } from '../../src/shared/summonerText';

const member = (peer: string, name: string, self = false): RoomMember => ({
  peer, name, self, color: 0, rgb: null, path: 'lan', status: 'on', needsUpdate: false, noEmotes: false,
  noChat: false, textOff: false, votesOff: false, muted: false,
});
const room: RoomState = { phase: 'active', code: 'PING-00000-00000', members: [member('self', 'Me', true),
  member('alice', 'Alice'), member('bob', 'Alice Bob')], lan: 'ok', internet: 'off', lonely: false, clockSkew: false, displays: [] };

describe('pilotChat', () => {
  it('keeps ordinary text plain and distinguishes missing names, messages, replies and unavailable votes', () => {
    expect(pilotChatSubmission(' hello\u202e ', room, null)).toEqual({ answer: 'sent', command: { type: 'text', text: 'hello' } });
    expect(pilotChatSubmission('/w Alice Bob hello', room, null)).toEqual({ answer: 'sent', command: { type: 'whisper', peers: ['bob'], text: 'hello' } });
    expect(pilotChatSubmission('/w unknown hello', room, null).answer).toBe('noMember');
    expect(pilotChatSubmission('/w Alice', room, null).answer).toBe('noMessage');
    expect(pilotChatSubmission('/r hello', room, null).answer).toBe('noReply');
    expect(pilotChatSubmission('/r hello', room, 'alice').command).toEqual({ type: 'whisper', peers: ['alice'], text: 'hello' });
    expect(pilotChatSubmission('/ready', room, null).answer).toBe('votesOff');
    expect(pilotChatSubmission('/ready', room, null, true).command).toEqual({ type: 'vote', kind: 'ready' });
    expect(pilotChatSubmission('/noff', room, null, true).command).toEqual({ type: 'vote', kind: 'noff' });
    expect(pilotChatSubmission('/other', room, null).answer).toBe('unknown');
  });

  it('toggles one member or every other member without exposing our mute command to peers', () => {
    expect(pilotChatSubmission('/mute Alice', room, null)).toEqual({ answer: 'sent', command: { type: 'mute', peers: ['alice'], on: true, all: false } });
    expect(pilotChatSubmission('/mute all', room, null).command).toEqual({ type: 'mute', peers: ['alice', 'bob'], on: true, all: true });
    const muted = { ...room, members: room.members.map((m) => ({ ...m, muted: true })) };
    expect(pilotChatSubmission('/mute Alice', muted, null).command).toMatchObject({ on: false });
  });

  it('uses the existing translated ping, scoreboard and command wording while preserving timestamps and tags', () => {
    const settings = desktopPilotSettings({ language: 'en' });
    const tag = { name: 'Alice', color: 0, rgb: null };
    const lines = pilotChatLines([
      { kind: 'text', at: 1, tag, text: '<b>hello</b>' },
      { kind: 'ping', at: 2, tag, ping: 'danger' },
      { kind: 'alive', at: 3, tag, whoName: 'Bob' },
      { kind: 'note', at: 4, tag: null, note: { name: null, on: true } },
    ], settings, 'en');
    expect(lines[0]).toEqual({ kind: 'text', at: 1, tag, text: '<b>hello</b>' });
    expect(lines[1].text).not.toBe('');
    expect(lines[2].text).toContain('Bob');
    expect(lines[3].text).not.toBe('');
  });

  it('reports spells at the sender click time and translates semantic vote outcomes', () => {
    const settings = desktopPilotSettings({ language: 'en' });
    const t = strings('en','win');
    const cooldown = { spell: 'flash' as const, rechargeEndsAt: [301000], castEndsAt: 0 };
    const lines = pilotChatLines([
      { kind: 'spell', at: 900000, cooldownAt: 1000, tag: null, whoName: 'Alice', cooldown, ownWho: false },
      { kind: 'vote', at: 900001, tag: null, outcome: { id: 'test', kind: 'ready', passed: false, yes: 1, voters: 2,
        declined: [], missing: ['alice'], names: { alice: 'Alice' } } },
    ],settings,'en');
    expect(lines[0].text).toBe(summonerText(t,cooldown,1000,'Alice',false));
    expect(lines[0].at).toBe(900000);
    expect(lines[1].text).toBe(t.readyMissing(['Alice']));
  });
});
