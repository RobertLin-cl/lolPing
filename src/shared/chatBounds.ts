/** Where the room chat window sits, in screen DIPs. */
export interface ChatBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const CHAT_MIN_SIZE = { width: 260, height: 140 } as const;
export const CHAT_MAX_SIZE = { width: 1600, height: 1200 } as const;
export const CHAT_DEFAULT_SIZE = { width: 360, height: 240 } as const;
/** How much of a saved window must still be on a screen for it to open there: enough to grab and drag back. */
const VISIBLE_MIN = { width: 80, height: 40 } as const;
const MARGIN = 24;

const isCoord = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 100_000;
const isSize = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Saved bounds from a settings file, or null when they are missing or broken (the window then opens in its default spot). */
export function normalizeChatBounds(raw: unknown): ChatBounds | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { x, y, width, height } = raw as Record<string, unknown>;
  if (!isCoord(x) || !isCoord(y)) return null;
  if (!isSize(width, CHAT_MIN_SIZE.width, CHAT_MAX_SIZE.width) || !isSize(height, CHAT_MIN_SIZE.height, CHAT_MAX_SIZE.height)) {
    return null;
  }
  return { x, y, width, height };
}

const overlap = (a: ChatBounds, b: ChatBounds): { width: number; height: number } => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
});

/**
 * Where the window opens: the saved bounds while enough of them is still on a work area (a screen may have been
 * unplugged or rearranged since), otherwise the default spot on the left of the primary work area. Never larger than
 * the work area it lands on.
 */
export function placeChat(saved: ChatBounds | null, workAreas: readonly ChatBounds[], primary: ChatBounds): ChatBounds {
  const area = saved && workAreas.find((a) => {
    const o = overlap(saved, a);
    return o.width >= VISIBLE_MIN.width && o.height >= VISIBLE_MIN.height;
  });
  if (saved && area) {
    return { ...saved, width: Math.min(saved.width, area.width), height: Math.min(saved.height, area.height) };
  }
  const width = Math.min(CHAT_DEFAULT_SIZE.width, primary.width);
  const height = Math.min(CHAT_DEFAULT_SIZE.height, primary.height);
  return {
    x: primary.x + Math.min(MARGIN, primary.width - width),
    y: primary.y + Math.round((primary.height - height) / 2),
    width,
    height,
  };
}
