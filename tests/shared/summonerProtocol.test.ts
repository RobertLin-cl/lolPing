import { describe, expect, it } from 'vitest';
import { validateSpellCooldown, validateSummonerState } from '../../src/shared/summonerProtocol';
import { castSpell, createSpellCooldown, SUMMONER_SPELL_IDS } from '../../src/shared/summonerSpells';

const now = 1780000000000;

describe('summonerProtocol', () => {
  it('rebuilds all ready and cast spells without keeping untrusted fields or array references', () => {
    for (const spell of SUMMONER_SPELL_IDS) {
      for (const state of [createSpellCooldown(spell), castSpell(createSpellCooldown(spell), now).cooldown]) {
        const decoded = validateSpellCooldown({ ...state, extra: 'ignored' }, now);
        expect(decoded).toEqual(state);
        expect(decoded).not.toBe(state);
        expect(decoded?.rechargeEndsAt).not.toBe(state.rechargeEndsAt);
      }
    }
  });

  it('accepts elapsed end times and sequential Smite charges bounded by the sender clock', () => {
    const first = castSpell(createSpellCooldown('smite'), now).cooldown;
    const second = castSpell(first, now + 15000).cooldown;
    expect(validateSpellCooldown(second, now + 15000)).toEqual(second);
    expect(validateSpellCooldown(second, now + 200000)).toEqual(second);
  });

  it('rejects unknown spells, oversized queues and impossible timestamps', () => {
    const state = createSpellCooldown('flash');
    for (const raw of [null, [], {}, { ...state, spell: 'unknown' },
      { ...state, rechargeEndsAt: [now, now + 1] }, { ...state, rechargeEndsAt: [now + 300001] },
      { ...state, rechargeEndsAt: [-1] }, { ...state, rechargeEndsAt: [NaN] },
      { ...state, rechargeEndsAt: ['100'] }, { ...state, rechargeEndsAt: [Infinity] },
      { ...state, castEndsAt: 1 }, { ...state, castEndsAt: -1 },
      { spell: 'smite', rechargeEndsAt: [now + 1, now + 2], castEndsAt: 0 },
      { spell: 'smite', rechargeEndsAt: [now + 90000], castEndsAt: now + 15001 },
      { spell: 'smite', rechargeEndsAt: [now + 90001, now + 180001], castEndsAt: 0 }]) {
      expect(validateSpellCooldown(raw, now), JSON.stringify(raw)).toBeNull();
    }
    expect(validateSpellCooldown(state, NaN)).toBeNull();
  });

  it('requires both distinct slots and drops malformed pairs as a whole', () => {
    const d = createSpellCooldown('heal');
    const f = createSpellCooldown('flash');
    expect(validateSummonerState({ d, f, extra: true }, now)).toEqual({ d, f });
    for (const raw of [undefined, null, [], {}, { d }, { d, f: d }, { d, f: { spell: 'unknown' } }]) {
      expect(validateSummonerState(raw, now)).toBeNull();
    }
  });
});
