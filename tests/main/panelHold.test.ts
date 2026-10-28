import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelHold } from '../../src/main/panelHold';

describe('PanelHold', () => {
  let holdMs: number;
  let calls: string[];
  let hold: PanelHold;

  beforeEach(() => {
    vi.useFakeTimers();
    holdMs = 500;
    calls = [];
    hold = new PanelHold({ holdMs: () => holdMs, show: () => calls.push('show'), hide: () => calls.push('hide') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the panel once the key has been held long enough, and hides it when the key comes up', () => {
    hold.down();
    vi.advanceTimersByTime(499);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['show']);
    hold.up();
    expect(calls).toEqual(['show', 'hide']);
  });

  it('shows nothing for a quick tap, even after the hold time has passed', () => {
    hold.down();
    vi.advanceTimersByTime(200);
    hold.up();
    vi.advanceTimersByTime(1000);
    expect(calls).not.toContain('show');
  });

  it('shows the panel at once when the hold time is 0', () => {
    holdMs = 0;
    hold.down();
    expect(calls).toEqual(['show']);
  });

  it('reads the hold time on every press, so a settings change applies to the next one', () => {
    hold.down();
    hold.up();
    holdMs = 1500;
    hold.down();
    vi.advanceTimersByTime(1000);
    expect(calls).not.toContain('show');
    vi.advanceTimersByTime(500);
    expect(calls).toContain('show');
  });

  it('starts the wait again on a second press instead of showing twice', () => {
    hold.down();
    vi.advanceTimersByTime(400);
    hold.down();
    vi.advanceTimersByTime(400);
    expect(calls).not.toContain('show');
    vi.advanceTimersByTime(100);
    expect(calls.filter((c) => c === 'show')).toHaveLength(1);
  });
});
