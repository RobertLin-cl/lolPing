import { describe, expect, it } from 'vitest';
import { shouldPlayChatSound } from '../../src/shared/chatSound';
import { DEFAULT_CHAT_FILTER } from '../../src/shared/chatFilter';
import { RoomHistory } from '../../src/main/roomHistory';
import type { HistoryLine } from '../../src/shared/roomHistory';

const line = (n: number): HistoryLine => ({ at: n, kind: 'text', tag: null, text: `line ${n}` });

describe('RoomHistory', () => {
  it('keeps lines in the order they came', () => {
    const history = new RoomHistory();
    history.push(line(1));
    history.push(line(2));
    expect(history.lines().map((l) => l.text)).toEqual(['line 1', 'line 2']);
  });

  it('keeps only the newest 500 lines', () => {
    const history = new RoomHistory();
    for (let n = 1; n <= 505; n++) history.push(line(n));
    expect(history.lines()).toHaveLength(500);
    expect(history.lines()[0].text).toBe('line 6');
    expect(history.lines()[499].text).toBe('line 505');
  });

  it('tells its listener after each pushed line, with the line already in', () => {
    const seen: number[] = [];
    const history: RoomHistory = new RoomHistory(() => seen.push(history.lines().length));
    history.push(line(1));
    history.push(line(2));
    expect(seen).toEqual([1, 2]);
  });

  it('notifies once for each new visible message and never replays sounds when history or filters are reread', () => {
    let filter = { ...DEFAULT_CHAT_FILTER };
    const heard: string[] = [];
    const history = new RoomHistory(line => { if (shouldPlayChatSound(line, filter, true)) heard.push(line.text); });
    history.push(line(1));
    expect(heard).toEqual(['line 1']);
    history.lines();
    filter = { ...filter, text: false };
    history.push(line(2));
    filter = { ...filter, text: true };
    history.lines();
    expect(history.lines()).toHaveLength(2);
    expect(heard).toEqual(['line 1']);
    history.push({ ...line(3), kind: 'whisperFrom' });
    history.push({ ...line(4), kind: 'spell' });
    filter = { ...filter, scoreboard: false };
    history.push({ ...line(5), kind: 'alive' });
    history.push({ ...line(6), kind: 'spell' });
    filter = { ...filter, scoreboard: true };
    history.lines();
    history.push({ ...line(7), kind: 'alive' });
    history.clear();
    expect(heard).toEqual(['line 1', 'line 3', 'line 4', 'line 7']);
  });

  it('empties on clear', () => {
    const history = new RoomHistory();
    history.push(line(1));
    history.clear();
    expect(history.lines()).toEqual([]);
  });
});
