import {
  isSummonerSpellId, SMITE_CAST_GAP_MS, SUMMONER_COOLDOWN_MS, type SpellCooldown, type SummonerState,
} from './summonerSpells';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Rebuild a cooldown from a peer, bounding its charge queue against the sender's packet clock. */
export function validateSpellCooldown(raw: unknown, at: number): SpellCooldown | null {
  if (!isObject(raw) || !isTime(at)) return null;
  const { spell, rechargeEndsAt, castEndsAt } = raw;
  if (!isSummonerSpellId(spell) || !Array.isArray(rechargeEndsAt) || !isTime(castEndsAt)) return null;
  const charges = spell === 'smite' ? 2 : 1;
  if (rechargeEndsAt.length > charges) return null;
  const ends: number[] = [];
  for (const end of rechargeEndsAt) {
    if (!isTime(end) || end > at + charges * SUMMONER_COOLDOWN_MS[spell]) return null;
    if (ends.length && end - ends[ends.length - 1] !== SUMMONER_COOLDOWN_MS[spell]) return null;
    ends.push(end);
  }
  if (spell === 'smite' ? castEndsAt > at + SMITE_CAST_GAP_MS : castEndsAt !== 0) return null;
  return { spell, rechargeEndsAt: ends, castEndsAt };
}

/** Missing or malformed spell data falls back to the legacy ready pair without dropping the member. */
export function validateSummonerState(raw: unknown, at: number): SummonerState | null {
  if (!isObject(raw)) return null;
  const d = validateSpellCooldown(raw.d, at);
  const f = validateSpellCooldown(raw.f, at);
  return d && f && d.spell !== f.spell ? { d, f } : null;
}
