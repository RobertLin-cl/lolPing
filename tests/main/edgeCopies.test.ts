import { describe, expect, it } from 'vitest';
import type { DisplayMap } from '../../src/main/coords';
import { edgeCopies, emoteExtent, pingExtent, type Extent } from '../../src/main/edgeCopies';

// Ultrawide primary at 100%, a 1080p monitor at 150% to its right, a 1080p monitor at 100% below it.
const A: DisplayMap = { id: 1, scale: 1, dip: { x: 0, y: 0, width: 3440, height: 1440 }, phys: { x: 0, y: 0, width: 3440, height: 1440 } };
const B: DisplayMap = { id: 2, scale: 1.5, dip: { x: 3440, y: 0, width: 1280, height: 720 }, phys: { x: 3440, y: 0, width: 1920, height: 1080 } };
const D: DisplayMap = { id: 3, scale: 1, dip: { x: 0, y: 1440, width: 1920, height: 1080 }, phys: { x: 0, y: 1440, width: 1920, height: 1080 } };
const maps = [A, B, D];
const box: Extent = { side: 100, up: 100, down: 100 };

describe('edgeCopies', () => {
  it('copies nothing for a mark well inside its display', () => {
    expect(edgeCopies({ displayId: 1, x: 1000, y: 500 }, box, maps)).toEqual([]);
  });

  it('copies a mark on a shared edge to the display beside it, at the same spot on screen', () => {
    // 15 physical px left of B, which draws 1.5 physical px per CSS px.
    expect(edgeCopies({ displayId: 1, x: 3425, y: 300 }, box, maps)).toEqual([
      { displayId: 2, x: -10, y: 200, scale: expect.closeTo(2 / 3) },
    ]);
  });

  it('draws the copy larger on a display with a smaller scale, so both parts match', () => {
    expect(edgeCopies({ displayId: 2, x: 5, y: 100 }, box, maps)).toEqual([{ displayId: 1, x: 3447.5, y: 150, scale: 1.5 }]);
  });

  it('leaves out a display the mark stops short of', () => {
    expect(edgeCopies({ displayId: 1, x: 3340, y: 300 }, box, maps)).toEqual([]);
    expect(edgeCopies({ displayId: 1, x: 3341, y: 300 }, box, maps)).toHaveLength(1);
  });

  it('copies past a top or bottom edge as well', () => {
    expect(edgeCopies({ displayId: 1, x: 500, y: 1430 }, box, maps)).toEqual([{ displayId: 3, x: 500, y: -10, scale: 1 }]);
    expect(edgeCopies({ displayId: 3, x: 500, y: 10 }, box, maps)).toEqual([{ displayId: 1, x: 500, y: 1450, scale: 1 }]);
    expect(edgeCopies({ displayId: 3, x: 500, y: 10 }, { side: 100, up: 0, down: 100 }, maps)).toEqual([]);
  });

  it('copies onto every display a mark in a corner reaches', () => {
    const at = (id: number, x: number, y: number, width: number): DisplayMap => {
      const r = { x, y, width, height: 1080 };
      return { id, scale: 1, dip: r, phys: r };
    };
    const corner = [at(1, 0, 0, 1920), at(2, 1920, 0, 1920), at(3, 0, 1080, 3840)];
    expect(edgeCopies({ displayId: 1, x: 1910, y: 1070 }, box, corner).map((c) => c.displayId)).toEqual([2, 3]);
  });

  it('copies nothing for a display it does not know', () => {
    expect(edgeCopies({ displayId: 9, x: 0, y: 0 }, box, maps)).toEqual([]);
  });
});

describe('pingExtent and emoteExtent', () => {
  it('reach far enough for a whole name tag however small the mark', () => {
    expect(pingExtent(60).side).toBeGreaterThanOrEqual(110);
    expect(emoteExtent(80).side).toBeGreaterThanOrEqual(110);
  });

  it('grow with the mark', () => {
    expect(pingExtent(220).up).toBeGreaterThan(pingExtent(110).up);
    expect(emoteExtent(300).side).toBeGreaterThan(emoteExtent(150).side);
  });
});
