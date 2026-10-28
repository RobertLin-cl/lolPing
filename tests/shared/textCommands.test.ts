import { describe, expect, it } from 'vitest';
import { MAX_TEXT } from '../../src/shared/roomProtocol';
import type { RoomMember } from '../../src/shared/room';
import { commandMatches, completeCommand, muteToggle, parseTextInput } from '../../src/shared/textCommands';

describe('parseTextInput', () => {
  it('reads /ff and /surrender, in any case and with spaces around', () => {
    expect(parseTextInput('/ff')).toEqual({ kind: 'ff' });
    expect(parseTextInput(' /FF ')).toEqual({ kind: 'ff' });
    expect(parseTextInput('/surrender')).toEqual({ kind: 'ff' });
  });

  it('reads /noff and /ready', () => {
    expect(parseTextInput('/noff')).toEqual({ kind: 'noff' });
    expect(parseTextInput('/ready')).toEqual({ kind: 'ready' });
  });

  it('calls any other slash word unknown', () => {
    expect(parseTextInput('/remake')).toEqual({ kind: 'unknown' });
    expect(parseTextInput('/')).toEqual({ kind: 'unknown' });
    expect(parseTextInput('/ff now')).toEqual({ kind: 'unknown' });
  });

  it('calls blank or invisible input empty', () => {
    expect(parseTextInput('   ')).toEqual({ kind: 'empty' });
    expect(parseTextInput('\u200b')).toEqual({ kind: 'empty' });
    expect(parseTextInput('')).toEqual({ kind: 'empty' });
  });

  it('keeps plain words as text, including "ff" without a slash', () => {
    expect(parseTextInput('gg wp')).toEqual({ kind: 'text', text: 'gg wp' });
    expect(parseTextInput('ff')).toEqual({ kind: 'text', text: 'ff' });
  });

  it('cuts long text to the message limit', () => {
    const r = parseTextInput('a'.repeat(130));
    expect(r).toEqual({ kind: 'text', text: 'a'.repeat(MAX_TEXT) });
    expect([...(r.kind === 'text' ? r.text : '')]).toHaveLength(120);
  });
});

describe('commandMatches', () => {
  it('offers the commands that start with what was typed, in any case', () => {
    expect(commandMatches('/r')).toEqual(['/ready']);
    expect(commandMatches('/N')).toEqual(['/noff']);
    expect(commandMatches('/')).toEqual(['/ff', '/mute ', '/noff', '/ready', '/surrender']);
    expect(commandMatches('/ff')).toEqual(['/ff']);
  });

  it('offers nothing for plain text, a second word, or a start no command has', () => {
    expect(commandMatches('ff')).toEqual([]);
    expect(commandMatches('')).toEqual([]);
    expect(commandMatches('/ff now')).toEqual([]);
    expect(commandMatches(' /ff')).toEqual([]);
    expect(commandMatches('/x')).toEqual([]);
  });
});

describe('completeCommand', () => {
  it('completes a start that only one command has', () => {
    expect(completeCommand('/re', null)?.value).toBe('/ready');
    expect(completeCommand('/S', null)?.value).toBe('/surrender');
  });

  it('cycles through the matches on each press while the box shows its last completion, and wraps round', () => {
    let step = completeCommand('/', null);
    const seen: string[] = [];
    for (let i = 0; i < 6 && step; i++) {
      seen.push(step.value);
      step = completeCommand(step.value, step.cycle);
    }
    expect(seen).toEqual(['/ff', '/mute ', '/noff', '/ready', '/surrender', '/ff']);
  });

  it('cycles backwards with Shift+Tab, starting from the last match', () => {
    const first = completeCommand('/', null, true);
    expect(first?.value).toBe('/surrender');
    expect(first && completeCommand(first.value, first.cycle, true)?.value).toBe('/ready');
  });

  it('starts again from the box when it was edited after a completion', () => {
    const first = completeCommand('/', null);
    expect(first?.value).toBe('/ff');
    // The user typed over it: "/n" is completed on its own, not as the next match of "/".
    expect(first && completeCommand('/n', first.cycle)?.value).toBe('/noff');
  });

  it('leaves the box alone when nothing completes', () => {
    expect(completeCommand('gg', null)).toBeNull();
    expect(completeCommand('/x', null)).toBeNull();
    expect(completeCommand('/ff now', null)).toBeNull();
  });
});

describe('/mute', () => {
  const member = (peer: string, name: string, extra: Partial<RoomMember> = {}): RoomMember => ({
    peer, name, color: 0, rgb: null, path: 'lan', status: 'on', needsUpdate: false, noEmotes: false, noChat: false,
    textOff: false, votesOff: false, muted: false, self: false, ...extra,
  });
  const members = [
    member('me', 'Robert', { self: true }),
    member('a', 'Ahri 小队长'),
    member('b', 'Alex'),
    member('c', 'Garen', { muted: true }),
  ];

  it('reads the name after /mute, keeping its spaces and case', () => {
    expect(parseTextInput('/mute Ahri 小队长')).toEqual({ kind: 'mute', name: 'Ahri 小队长' });
    expect(parseTextInput('/MUTE   alex  ')).toEqual({ kind: 'mute', name: 'alex' });
    expect(parseTextInput('/mute')).toEqual({ kind: 'mute', name: '' });
    expect(parseTextInput('/muted')).toEqual({ kind: 'unknown' });
  });

  it('completes /m to /mute and a space, and the next Tab goes on to all and the names', () => {
    const names = ['Alex', 'Garen'];
    const command = completeCommand('/m', null, false, names);
    expect(command?.value).toBe('/mute ');
    const first = command && completeCommand(command.value, command.cycle, false, names);
    expect(first?.value).toBe('/mute all');
    expect(first && completeCommand(first.value, first.cycle, false, names)?.value).toBe('/mute Alex');
  });

  it('keeps a lone completion as it is on further presses', () => {
    const step = completeCommand('/mute ale', null, false, ['Alex']);
    expect(step?.value).toBe('/mute Alex');
    expect(step && completeCommand(step.value, step.cycle, false, ['Alex'])?.value).toBe('/mute Alex');
  });

  it('cycles through all and then the names after /mute, only those that start with what was typed', () => {
    const names = ['Ahri 小队长', 'Alex', 'Garen'];
    let step = completeCommand('/mute ', null, false, names);
    const seen: string[] = [];
    for (let i = 0; i < 5 && step; i++) {
      seen.push(step.value);
      step = completeCommand(step.value, step.cycle, false, names);
    }
    expect(seen).toEqual(['/mute all', '/mute Ahri 小队长', '/mute Alex', '/mute Garen', '/mute all']);
    const al = completeCommand('/mute al', null, false, names);
    expect(al?.value).toBe('/mute all');
    expect(al && completeCommand(al.value, al.cycle, false, names)?.value).toBe('/mute Alex');
    expect(completeCommand('/mute x', null, false, names)).toBeNull();
    expect(completeCommand('/mute ', null, false, [])?.value).toBe('/mute all');
  });

  it('leaves a member called "all" out of the names, since /mute all means everyone', () => {
    const step = completeCommand('/mute a', null, false, ['ALL', 'Alex']);
    expect(step?.value).toBe('/mute all');
    expect(step && completeCommand(step.value, step.cycle, false, ['ALL', 'Alex'])?.value).toBe('/mute Alex');
  });

  it('offers a name two members share once', () => {
    const step = completeCommand('/mute ', null, false, ['Player', 'Player']);
    expect(step && completeCommand(step.value, step.cycle, false, ['Player', 'Player'])?.value).toBe('/mute Player');
  });

  it('mutes the member with that name, in any case, and never us', () => {
    expect(muteToggle(members, 'alex')).toEqual({ peers: ['b'], on: true, name: 'Alex' });
    expect(muteToggle(members, 'Robert')).toBeNull();
    expect(muteToggle(members, 'Nobody')).toBeNull();
    expect(muteToggle(members, '')).toBeNull();
  });

  it('unmutes a member who is muted already, as League does', () => {
    expect(muteToggle(members, 'Garen')).toEqual({ peers: ['c'], on: false, name: 'Garen' });
  });

  it('mutes every other member with all, in any case, and unmutes them once every one of them is muted', () => {
    expect(muteToggle(members, 'all')).toEqual({ peers: ['a', 'b', 'c'], on: true, name: null });
    expect(muteToggle(members, 'ALL')?.on).toBe(true);
    const allMuted = members.map((m) => ({ ...m, muted: !m.self }));
    expect(muteToggle(allMuted, 'all')).toEqual({ peers: ['a', 'b', 'c'], on: false, name: null });
    expect(muteToggle([members[0]], 'all')).toBeNull(); // alone in the room
  });

  it('takes all as everyone even when a member is called that', () => {
    expect(muteToggle([...members, member('d', 'All')], 'all')?.peers).toEqual(['a', 'b', 'c', 'd']);
  });

  it('treats members who share a name alike: muted unless every one of them already is', () => {
    const twins = [member('x', 'Player', { muted: true }), member('y', 'Player')];
    expect(muteToggle(twins, 'player')).toEqual({ peers: ['x', 'y'], on: true, name: 'Player' });
  });
});
