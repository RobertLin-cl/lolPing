import { displayAtPhysical, type DisplayMap } from './coords';
import type { OverlayChannel, OverlayEvents } from '../shared/ipc';
import type { HelperEvent } from '../shared/protocol';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import { desktopPilotArt } from '../shared/desktopPilot';

export interface PilotMessage {
  displayId: number;
  channel: OverlayChannel;
  payload: OverlayEvents[OverlayChannel];
}

/** Routes physical helper coordinates without depending on either desktop runtime. */
export class PilotInput {
  private wheelDisplay: number | null = null;

  constructor(private readonly displays: readonly DisplayMap[], private readonly settings: () => Settings = () => DEFAULT_SETTINGS) {}

  handle(event: HelperEvent): PilotMessage[] {
    if (event.type === 'cancel' || (event.type === 'toggled' && !event.enabled)) {
      this.wheelDisplay = null;
      return this.displays.flatMap((d) => [
        { displayId: d.id, channel: 'wheel:cancel' as const, payload: null },
        { displayId: d.id, channel: 'ping:unkeep' as const, payload: null },
        { displayId: d.id, channel: 'emote:clear' as const, payload: { owner: 'self' } },
      ]);
    }
    if (event.type !== 'wheelOpen' && event.type !== 'wheelMove' && event.type !== 'wheelRelease' && event.type !== 'click') return [];
    if (event.wheel === 'ask') return [];
    if (event.type === 'click') {
      const d = displayAtPhysical(event.x, event.y, this.displays);
      if (!d) return [];
      const s = this.settings();
      const at = { x: (event.x - d.phys.x) / d.scale, y: (event.y - d.phys.y) / d.scale };
      return [event.wheel === 'emote'
        ? { displayId: d.id, channel: 'emote:spawn', payload: { ...at, owner: 'self', art: desktopPilotArt(s, s.clickEmoteId) } }
        : { displayId: d.id, channel: 'ping:spawn', payload: { ...at, id: s.clickPingId, keep: s.keepLastPing } }];
    }
    if (event.type === 'wheelOpen') this.wheelDisplay = displayAtPhysical(event.x, event.y, this.displays)?.id ?? null;
    const d = this.displays.find((display) => display.id === this.wheelDisplay);
    if (!d) return [];
    const channel = event.type === 'wheelOpen' ? 'wheel:open'
      : event.type === 'wheelMove' ? 'wheel:move' : 'wheel:release';
    const message: PilotMessage = {
      displayId: d.id, channel,
      payload: { x: (event.x - d.phys.x) / d.scale, y: (event.y - d.phys.y) / d.scale, wheel: event.wheel },
    };
    if (event.type === 'wheelRelease') this.wheelDisplay = null;
    return [message];
  }
}
