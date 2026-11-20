import { describe, expect, it } from 'vitest';
import { PilotInput } from '../../src/main/pilotInput';

const displays = [
  { id: 0, scale: 1, phys: { x: 0, y: 0, width: 1920, height: 1080 }, dip: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 1, scale: 2, phys: { x: -2560, y: 0, width: 2560, height: 1440 }, dip: { x: -1280, y: 0, width: 1280, height: 720 } },
];

describe('PilotInput', () => {
  it('uses local CSS coordinates on a scaled display with a negative origin', () => {
    const input = new PilotInput(displays);
    expect(input.handle({ type: 'wheelOpen', x: -2360, y: 100, wheel: 'ping' })).toEqual([
      { displayId: 1, channel: 'wheel:open', payload: { x: 100, y: 50, wheel: 'ping' } },
    ]);
  });

  it('keeps the wheel on its original display when dragging across a boundary', () => {
    const input = new PilotInput(displays);
    input.handle({ type: 'wheelOpen', x: -200, y: 100, wheel: 'ping' });
    expect(input.handle({ type: 'wheelRelease', x: 100, y: 200, wheel: 'ping' })).toEqual([
      { displayId: 1, channel: 'wheel:release', payload: { x: 1330, y: 100, wheel: 'ping' } },
    ]);
    expect(input.handle({ type: 'wheelMove', x: 110, y: 200, wheel: 'ping' })).toEqual([]);
  });

  it('clears every display and forgets a gesture when paused', () => {
    const input = new PilotInput(displays);
    input.handle({ type: 'wheelOpen', x: 100, y: 100, wheel: 'ping' });
    expect(input.handle({ type: 'toggled', enabled: false })).toHaveLength(6);
    expect(input.handle({ type: 'wheelRelease', x: 200, y: 100, wheel: 'ping' })).toEqual([]);
  });

  it('ignores unrelated events and missing displays', () => {
    expect(new PilotInput(displays).handle({ type: 'textRequested' })).toEqual([]);
    expect(new PilotInput([]).handle({ type: 'wheelOpen', x: 0, y: 0, wheel: 'ping' })).toEqual([]);
  });

  it('routes the emote wheel through the same physical coordinate map', () => {
    const input = new PilotInput(displays);
    expect(input.handle({ type: 'wheelOpen', x: -2360, y: 100, wheel: 'emote' })).toEqual([
      { displayId: 1, channel: 'wheel:open', payload: { x: 100, y: 50, wheel: 'emote' } },
    ]);
  });

  it('places click pings and emotes using the current settings', () => {
    const input = new PilotInput(displays);
    expect(input.handle({ type: 'click', x: 100, y: 100, wheel: 'ping' })[0]).toMatchObject({
      displayId: 0, channel: 'ping:spawn', payload: { x: 100, y: 100 },
    });
    expect(input.handle({ type: 'click', x: 100, y: 100, wheel: 'emote' })[0]).toMatchObject({
      displayId: 0, channel: 'emote:spawn', payload: { owner: 'self', art: { kind: 'bundled' } },
    });
  });
});
