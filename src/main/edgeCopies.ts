import type { DisplayMap, LocalPoint } from './coords';

/** How far a mark is drawn from its point, in its overlay's CSS px: to either side, above and below. */
export interface Extent {
  side: number;
  up: number;
  down: number;
}

/**
 * A ping of `sizePx` (overlay.css): its rings as they grow, its art as it pops, the teammate's words above it (20
 * characters) and the name tag under it (at most 220 px wide).
 */
export const pingExtent = (sizePx: number): Extent => ({
  side: Math.max(sizePx * 0.75 + 24, 140),
  up: sizePx * 0.85 + 44,
  down: sizePx * 0.75 + 24,
});

/** An emote of `sizePx` (emoteFx.css): its art as it pops in, its rise as it leaves, and the name tag under it. */
export const emoteExtent = (sizePx: number): Extent => ({
  side: Math.max(sizePx * 0.8, 110),
  up: sizePx * 1.5,
  down: sizePx * 0.8 + 28,
});

/** Where a copy of a mark goes in another display's overlay, and how many times its usual size to draw it there. */
export interface EdgeCopy extends LocalPoint {
  scale: number;
}

/**
 * Each display's overlay clips at its own edges, so a mark near an edge another display shares is cut in half. These
 * are the other displays it reaches into, with the same spot on screen in each one's overlay. The scale makes both
 * parts the same size on screen when the displays have different scales. Empty when the mark stays on its display.
 */
export function edgeCopies(at: LocalPoint, extent: Extent, maps: readonly DisplayMap[]): EdgeCopy[] {
  const home = maps.find((m) => m.id === at.displayId);
  if (!home) return [];

  // Displays meet in physical px: the point and the mark's box there.
  const x = home.phys.x + at.x * home.scale;
  const y = home.phys.y + at.y * home.scale;
  const left = x - extent.side * home.scale;
  const right = x + extent.side * home.scale;
  const top = y - extent.up * home.scale;
  const bottom = y + extent.down * home.scale;

  return maps
    .filter((m) => m.id !== home.id
      && left < m.phys.x + m.phys.width && m.phys.x < right && top < m.phys.y + m.phys.height && m.phys.y < bottom)
    .map((m) => ({ displayId: m.id, x: (x - m.phys.x) / m.scale, y: (y - m.phys.y) / m.scale, scale: home.scale / m.scale }));
}
