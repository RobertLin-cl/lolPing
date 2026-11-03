import { describe, expect, it } from 'vitest';
import { barFrames, sectionAt } from '../../src/renderer/settings/navIndicator';

describe('barFrames', () => {
  it('stretches down over the gap, then settles on the lower item', () => {
    expect(barFrames(10, 100, 16)).toEqual([
      { top: '10px', height: '16px' },
      { top: '10px', height: '106px', offset: 0.5 },
      { top: '100px', height: '16px' },
    ]);
  });

  it('stretches up from the top of the higher item when moving up', () => {
    expect(barFrames(100, 10, 16)).toEqual([
      { top: '100px', height: '16px' },
      { top: '10px', height: '106px', offset: 0.5 },
      { top: '10px', height: '16px' },
    ]);
  });

  it('has no frames when the bar stays where it is', () => {
    expect(barFrames(42, 42, 16)).toEqual([]);
  });
});

describe('sectionAt', () => {
  // Five sections; the page scrolls 3000 px, so the last one's top (3400) never comes within 40 px of the top.
  const tops = [0, 800, 1600, 2400, 3400];

  it('selects the first section at the top of the page', () => {
    expect(sectionAt(tops, 0, 3000)).toBe(0);
  });

  it('selects the last section whose heading has reached the reading line', () => {
    expect(sectionAt(tops, 1570, 3000)).toBe(2);
    expect(sectionAt(tops, 1550, 3000)).toBe(1);
  });

  it('selects the last section at the very bottom, though its heading never got that high', () => {
    expect(sectionAt(tops, 3000, 3000)).toBe(4);
    expect(sectionAt(tops, 2999.5, 3000)).toBe(4);
  });

  it('keeps the first section on a page too short to scroll', () => {
    expect(sectionAt([0, 300], 0, 0)).toBe(0);
  });
});
