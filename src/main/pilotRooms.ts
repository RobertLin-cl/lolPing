import type { DisplayMap } from './coords';
import type { PilotMessage } from './pilotInput';
import { customHdUrl, catalogEmote, type EmoteArt } from '../shared/emotes';
import { isTagColor, isTagRgb } from '../shared/roomColors';
import { validateMessage } from '../shared/roomProtocol';
import type { Settings } from '../shared/settings';

/** Maps an accepted native room event to the same overlay messages Electron uses. */
export function pilotRoomMessages(raw: unknown, displays: readonly DisplayMap[], settings: Settings): PilotMessage[] {
  if (!settings.features.rooms || settings.roomMuted || typeof raw !== 'object' || raw === null) return [];
  const value = raw as Record<string, unknown>;
  const message = validateMessage(value.message);
  if (!message || (message.t !== 'ping' && message.t !== 'emote')) return [];
  const tag = value.tag;
  if (typeof tag !== 'object' || tag === null) return [];
  const name = tag as Record<string, unknown>;
  if (typeof name.name !== 'string' || !isTagColor(name.color) || (name.rgb !== null && !isTagRgb(name.rgb))) return [];
  const display = displays.find((d) => d.id === message.d - 1) ?? displays[0];
  if (!display) return [];
  const at = { x: message.x * display.phys.width / display.scale, y: message.y * display.phys.height / display.scale };
  const label = { name: name.name, color: name.color, rgb: name.rgb };
  if (message.t === 'ping') return [{ displayId: display.id, channel: 'ping:spawn', payload: { ...at, id: message.ping, tag: label } }];
  if (!settings.features.emotes) return [];
  let art: EmoteArt = { kind: 'placeholder' };
  if (catalogEmote(message.e)) art = { kind: 'bundled', slug: message.e };
  else if (message.e.startsWith('c:') && (settings.customEmotes.some((c) => c.id === message.e)
    || (settings.friendEmotes && value.available === true))) {
    art = { kind: 'custom', url: customHdUrl(message.e.slice(2)), animated: false, fx: message.fx ?? 0 };
  }
  return [
    ...displays.filter((d) => d.id !== display.id).map((d): PilotMessage => ({
      displayId: d.id, channel: 'emote:clear', payload: { owner: message.peer },
    })),
    { displayId: display.id, channel: 'emote:spawn', payload: { ...at, owner: message.peer, art, tag: label } },
  ];
}
