import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  castSpell, clearSpellCooldown, createSpellCooldown, isSummonerSpellId, spellCooldownView, SUMMONER_COOLDOWN_MS, SUMMONER_SPELL_IDS,
} from '../../src/shared/summonerSpells';

describe('summonerSpells', () => {
  it('offers eleven spells with matching icons and sounds', () => {
    expect(new Set(SUMMONER_SPELL_IDS).size).toBe(11);
    for (const spell of SUMMONER_SPELL_IDS) {
      for (const ext of ['png', 'wav']) {
        expect(existsSync(resolve(__dirname, '../../assets/summoners', spell + '.' + ext)), spell).toBe(true);
      }
    }
  });

  it('accepts only known spell IDs from settings or room data', () => {
    for (const spell of SUMMONER_SPELL_IDS) expect(isSummonerSpellId(spell)).toBe(true);
    for (const value of ['Flash', 'revive', '__proto__', '', 4, null, {}, ['flash']]) {
      expect(isSummonerSpellId(value)).toBe(false);
    }
  });

  it('uses the agreed base cooldowns without haste', () => {
    expect(SUMMONER_COOLDOWN_MS).toEqual({
      flash: 300_000, ignite: 180_000, teleport: 300_000, heal: 240_000, barrier: 180_000, exhaust: 240_000,
      cleanse: 240_000, ghost: 240_000, smite: 90_000, clarity: 240_000, mark: 80_000,
    });
  });

  it('starts ordinary spells ready and starts Smite with two charges', () => {
    for (const spell of SUMMONER_SPELL_IDS) {
      expect(spellCooldownView(createSpellCooldown(spell), 1_000)).toEqual({
        charges: spell === 'smite' ? 2 : 1, ready: true, remainingMs: 0, rechargeRemainingMs: 0,
      });
    }
  });

  it('blocks each ordinary spell until its exact cooldown end', () => {
    for (const spell of SUMMONER_SPELL_IDS.filter((id) => id !== 'smite')) {
      const initial = createSpellCooldown(spell);
      const first = castSpell(initial, 1_000);
      const end = 1_000 + SUMMONER_COOLDOWN_MS[spell];
      expect(first.cast, spell).toBe(true);
      expect(first.cooldown.rechargeEndsAt).toEqual([end]);
      expect(spellCooldownView(first.cooldown, end - 1)).toEqual({
        charges: 0, ready: false, remainingMs: 1, rechargeRemainingMs: 1,
      });
      expect(castSpell(first.cooldown, end - 1)).toEqual({ cast: false, cooldown: first.cooldown });
      expect(castSpell(first.cooldown, end).cooldown.rechargeEndsAt).toEqual([end + SUMMONER_COOLDOWN_MS[spell]]);
      expect(initial).toEqual(createSpellCooldown(spell));
    }
  });

  it('keeps time as an end timestamp so views agree after a long delay', () => {
    const cast = castSpell(createSpellCooldown('flash'), 1_000);
    expect(spellCooldownView(cast.cooldown, 46_000).remainingMs).toBe(255_000);
    expect(spellCooldownView(cast.cooldown, 999_000)).toEqual({
      charges: 1, ready: true, remainingMs: 0, rechargeRemainingMs: 0,
    });
  });

  it('keeps Smite from casting again for 15 seconds despite its remaining charge', () => {
    const first = castSpell(createSpellCooldown('smite'), 1_000);
    expect(first.cooldown.rechargeEndsAt).toEqual([91_000]);
    expect(spellCooldownView(first.cooldown, 1_000)).toEqual({
      charges: 1, ready: false, remainingMs: 15_000, rechargeRemainingMs: 90_000,
    });
    const blocked = castSpell(first.cooldown, 15_999);
    expect(blocked.cast).toBe(false);
    expect(blocked.cooldown).toBe(first.cooldown);
    expect(castSpell(first.cooldown, 16_000).cast).toBe(true);
  });

  it('refills two missing Smite charges in sequence without restarting the first', () => {
    const first = castSpell(createSpellCooldown('smite'), 1_000);
    const second = castSpell(first.cooldown, 16_000);
    expect(second.cooldown.rechargeEndsAt).toEqual([91_000, 181_000]);
    expect(spellCooldownView(second.cooldown, 90_999)).toEqual({
      charges: 0, ready: false, remainingMs: 1, rechargeRemainingMs: 1,
    });
    expect(castSpell(second.cooldown, 90_999).cast).toBe(false);
    expect(spellCooldownView(second.cooldown, 91_000)).toEqual({
      charges: 1, ready: true, remainingMs: 0, rechargeRemainingMs: 90_000,
    });
    expect(spellCooldownView(second.cooldown, 181_000)).toEqual({
      charges: 2, ready: true, remainingMs: 0, rechargeRemainingMs: 0,
    });
    expect(first.cooldown.rechargeEndsAt).toEqual([91_000]);
  });

  it('queues a cast made as a Smite charge returns behind the charge still recharging', () => {
    const first = castSpell(createSpellCooldown('smite'), 1_000);
    const second = castSpell(first.cooldown, 16_000);
    const third = castSpell(second.cooldown, 91_000);
    expect(third.cast).toBe(true);
    expect(third.cooldown.rechargeEndsAt).toEqual([181_000, 271_000]);
    expect(spellCooldownView(third.cooldown, 91_000)).toEqual({
      charges: 0, ready: false, remainingMs: 90_000, rechargeRemainingMs: 90_000,
    });
  });

  it('preserves the cast gap when the first Smite charge returns just after a second cast', () => {
    const first = castSpell(createSpellCooldown('smite'), 1_000);
    const second = castSpell(first.cooldown, 90_000);
    expect(spellCooldownView(second.cooldown, 91_000)).toEqual({
      charges: 1, ready: false, remainingMs: 14_000, rechargeRemainingMs: 90_000,
    });
    expect(castSpell(second.cooldown, 104_999).cast).toBe(false);
    expect(castSpell(second.cooldown, 105_000).cast).toBe(true);
  });

  it('starts a new recharge from the cast time after Smite has been full for a while', () => {
    const first = castSpell(createSpellCooldown('smite'), 1_000);
    const second = castSpell(first.cooldown, 16_000);
    const later = castSpell(second.cooldown, 300_000);
    expect(later.cooldown.rechargeEndsAt).toEqual([390_000]);
    expect(spellCooldownView(later.cooldown, 315_000)).toEqual({
      charges: 1, ready: true, remainingMs: 0, rechargeRemainingMs: 75_000,
    });
  });

  it('clears ordinary cooldowns and both Smite charges without mutating the old state', () => {
    for (const spell of SUMMONER_SPELL_IDS) {
      const cast = castSpell(createSpellCooldown(spell), 1_000);
      const cleared = clearSpellCooldown(cast.cooldown);
      expect(cleared).toEqual(createSpellCooldown(spell));
      expect(castSpell(cleared, 1_001).cast).toBe(true);
      expect(cast.cooldown.rechargeEndsAt).toHaveLength(1);
    }
  });
});
