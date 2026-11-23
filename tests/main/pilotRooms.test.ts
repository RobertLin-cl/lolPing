import { describe, expect, it } from 'vitest';
import { pilotRoomMessages } from '../../src/main/pilotRooms';
import { desktopPilotSettings } from '../../src/shared/desktopPilot';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

const displays = [
  { id: 0, scale: 1, phys: { x: 0, y: 0, width: 1920, height: 1080 }, dip: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 1, scale: 2, phys: { x: -2560, y: 0, width: 2560, height: 1440 }, dip: { x: -1280, y: 0, width: 1280, height: 720 } },
];
const settings = desktopPilotSettings(DEFAULT_SETTINGS);
const message = { t: 'ping', peer: '0011223344556677', seq: 1, ts: 1000, ping: 'danger', d: 2, x: 0.25, y: 0.5 };
const tag = { name: 'Friend', color: 0, rgb: null };

describe('pilotRooms', () => {
  it('maps fractional room coordinates to CSS pixels and falls back to the primary display', () => {
    expect(pilotRoomMessages({ message, tag }, displays, settings)).toEqual([
      { displayId: 1, channel: 'ping:spawn', payload: { id: 'danger', x: 320, y: 360, tag } },
    ]);
    expect(pilotRoomMessages({ message: { ...message, d: 3 }, tag }, displays, settings)[0]).toMatchObject({
      displayId: 0, payload: { x: 480, y: 540 },
    });
  });

  it('rejects malformed messages and tags and respects room mute and feature switches', () => {
    for (const raw of [null, {}, { message: { ...message, x: 2 }, tag }, { message, tag: { ...tag, color: 90 } },
      { message, tag: { ...tag, rgb: ['red', 0, 0] } }]) {
      expect(pilotRoomMessages(raw, displays, settings)).toEqual([]);
    }
    expect(pilotRoomMessages({ message, tag }, displays, { ...settings, roomMuted: true })).toEqual([]);
    expect(pilotRoomMessages({ message, tag }, [], settings)).toEqual([]);
    expect(pilotRoomMessages({ message, tag }, displays, { ...settings, features: { ...settings.features, rooms: false } })).toEqual([]);
  });

  it('shows verified remote stills without playing local sounds or animations and clears the other displays', () => {
    const hash = 'a'.repeat(32);
    const m = { ...message, t: 'emote', e: `c:${hash}`, fx: 3 };
    const messages = pilotRoomMessages({ message: m, tag, available: true }, displays, settings);
    expect(messages).toEqual([
      { displayId: 0, channel: 'emote:clear', payload: { owner: message.peer } },
      { displayId: 1, channel: 'emote:spawn', payload: { x: 320, y: 360, owner: message.peer, tag,
        art: { kind: 'custom', url: `lolping://emotes/${hash}.hd`, animated: false, fx: 3 } } },
    ]);
    expect(pilotRoomMessages({ message: m, tag, available: true }, displays, { ...settings, friendEmotes: false })[1])
      .toMatchObject({ payload: { art: { kind: 'placeholder' } } });
    expect(pilotRoomMessages({ message: m, tag }, displays, { ...settings, features: { ...settings.features, emotes: false } })).toEqual([]);
  });
});
