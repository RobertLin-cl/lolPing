import { describe, expect, it } from 'vitest';
import { historyTime } from '../../src/shared/roomHistory';

describe('historyTime', () => {
  it('pads each local time component to two digits', () => {
    expect(historyTime(new Date(2026, 10, 3, 1, 2, 3).getTime())).toBe('[01:02:03]');
  });

  it('uses the 24-hour clock at midnight, noon and the end of the day', () => {
    for (const [hour, minute, second, expected] of [
      [0, 0, 0, '[00:00:00]'],
      [12, 0, 0, '[12:00:00]'],
      [23, 59, 59, '[23:59:59]'],
    ] as const) {
      expect(historyTime(new Date(2026, 10, 3, hour, minute, second).getTime())).toBe(expected);
    }
  });
});
