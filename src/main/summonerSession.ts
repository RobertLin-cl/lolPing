import type { Settings } from '../shared/settings';
import { clearSpellCooldown, castSpell, createSpellCooldown, type SummonerState, type SummonerSpellSlot } from '../shared/summonerSpells';

type Selection = Pick<Settings, 'summonerD' | 'summonerF'>;

/** Keeps local cooldowns for one room session; pausing input does not restart them. */
export class SummonerSession {
  private room: string | null = null;
  private cooldowns: SummonerState | null = null;

  constructor(private readonly now: () => number) {}

  sync(selection: Selection, room: string | null): void {
    if (room === null) {
      this.room = null;
      this.cooldowns = null;
      return;
    }
    if (room !== this.room || selection.summonerD !== this.cooldowns?.d.spell ||
        selection.summonerF !== this.cooldowns?.f.spell) {
      this.cooldowns = { d: createSpellCooldown(selection.summonerD), f: createSpellCooldown(selection.summonerF) };
    }
    this.room = room;
  }

  state(): SummonerState | null { return this.cooldowns; }

  /** Restores one slot, including both Smite charges, without changing the other. */
  clear(slot: SummonerSpellSlot): boolean {
    if (!this.cooldowns) return false;
    this.cooldowns = { ...this.cooldowns, [slot]: clearSpellCooldown(this.cooldowns[slot]) };
    return true;
  }

  cast(slot: SummonerSpellSlot, enabled: boolean): boolean {
    if (!enabled || !this.cooldowns) return false;
    const result = castSpell(this.cooldowns[slot], this.now());
    if (!result.cast) return false;
    this.cooldowns = { ...this.cooldowns, [slot]: result.cooldown };
    return true;
  }
}
