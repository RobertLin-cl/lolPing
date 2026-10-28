import { describe, expect, it } from 'vitest';
import { CHAT_DEFAULT_SIZE, normalizeChatBounds, placeChat } from '../../src/shared/chatBounds';

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: 0, width: 1280, height: 984 };

describe('normalizeChatBounds', () => {
  it('keeps whole-number bounds within the size limits', () => {
    expect(normalizeChatBounds({ x: -300, y: 40, width: 400, height: 300 })).toEqual({ x: -300, y: 40, width: 400, height: 300 });
  });

  it('drops anything missing, broken, too small or too large', () => {
    for (const raw of [
      undefined, null, 'x', [1, 2, 3, 4],
      { x: 0, y: 0, width: 400 },
      { x: 0.5, y: 0, width: 400, height: 300 },
      { x: 0, y: 0, width: 100, height: 300 },
      { x: 0, y: 0, width: 400, height: 5000 },
      { x: Number.NaN, y: 0, width: 400, height: 300 },
      { x: 1e9, y: 0, width: 400, height: 300 },
    ]) {
      expect(normalizeChatBounds(raw)).toBeNull();
    }
  });
});

describe('placeChat', () => {
  it('opens in the default spot on the left of the primary screen when nothing is saved', () => {
    const b = placeChat(null, [PRIMARY], PRIMARY);
    expect(b).toEqual({ x: 24, y: Math.round((1040 - CHAT_DEFAULT_SIZE.height) / 2), ...CHAT_DEFAULT_SIZE });
  });

  it('opens where it was left, on any screen', () => {
    const saved = { x: 2200, y: 100, width: 500, height: 400 };
    expect(placeChat(saved, [PRIMARY, RIGHT], PRIMARY)).toEqual(saved);
  });

  it('keeps a window that hangs off the edge while enough of it can still be grabbed', () => {
    const saved = { x: -400, y: 100, width: 500, height: 300 };
    expect(placeChat(saved, [PRIMARY], PRIMARY)).toEqual(saved);
  });

  it('goes back to the default spot when its screen is gone or too little of it is showing', () => {
    expect(placeChat({ x: 2200, y: 100, width: 500, height: 400 }, [PRIMARY], PRIMARY).x).toBe(24);
    expect(placeChat({ x: -470, y: 100, width: 500, height: 300 }, [PRIMARY], PRIMARY).x).toBe(24);
  });

  it('shrinks to fit a smaller work area', () => {
    const small = { x: 0, y: 0, width: 800, height: 200 };
    expect(placeChat({ x: 10, y: 10, width: 1000, height: 600 }, [small], small)).toEqual({ x: 10, y: 10, width: 800, height: 200 });
    expect(placeChat(null, [small], small)).toMatchObject({ width: CHAT_DEFAULT_SIZE.width, height: 200, y: 0 });
  });
});
