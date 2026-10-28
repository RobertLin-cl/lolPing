import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatAutoHide } from '../../src/main/chatAutoHide';

describe('ChatAutoHide', () => {
  let hideAfterMs: number;
  let hides: number;
  let auto: ChatAutoHide;

  beforeEach(() => {
    vi.useFakeTimers();
    hideAfterMs = 8000;
    hides = 0;
    auto = new ChatAutoHide({ hideAfterMs: () => hideAfterMs, hide: () => hides++ });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides the window once no new line has come for the set time', () => {
    auto.restart();
    vi.advanceTimersByTime(7999);
    expect(hides).toBe(0);
    vi.advanceTimersByTime(1);
    expect(hides).toBe(1);
  });

  it('starts the countdown again on every new line', () => {
    auto.restart();
    vi.advanceTimersByTime(6000);
    auto.restart();
    vi.advanceTimersByTime(6000);
    expect(hides).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(hides).toBe(1);
  });

  it('stays up while the pointer is over it, and counts down again once it leaves', () => {
    auto.restart();
    auto.setHovered(true);
    auto.restart(); // a line arriving while hovered doesn't start a countdown
    vi.advanceTimersByTime(60_000);
    expect(hides).toBe(0);
    auto.setHovered(false);
    vi.advanceTimersByTime(8000);
    expect(hides).toBe(1);
  });

  it('stays up while it has the keyboard, and counts down again once the keyboard goes back', () => {
    auto.setFocused(true);
    auto.restart();
    vi.advanceTimersByTime(60_000);
    expect(hides).toBe(0);
    auto.setFocused(false);
    vi.advanceTimersByTime(8000);
    expect(hides).toBe(1);
  });

  it('needs both the pointer and the keyboard gone before it counts down', () => {
    auto.setFocused(true);
    auto.setHovered(true);
    auto.setFocused(false);
    vi.advanceTimersByTime(60_000);
    expect(hides).toBe(0);
  });

  it('never hides by itself when the time is 0', () => {
    hideAfterMs = 0;
    auto.restart();
    vi.advanceTimersByTime(600_000);
    expect(hides).toBe(0);
  });

  it('drops a pending hide and forgets pointer and keyboard when stopped', () => {
    auto.setHovered(true);
    auto.stop();
    vi.advanceTimersByTime(60_000);
    expect(hides).toBe(0);
    auto.restart(); // no longer counted as hovered
    vi.advanceTimersByTime(8000);
    expect(hides).toBe(1);
  });
});
