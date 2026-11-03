export const SUMMONER_SPELL_IDS = [
  'flash', 'ignite', 'teleport', 'heal', 'barrier', 'exhaust', 'cleanse', 'ghost', 'smite', 'clarity', 'mark',
] as const;
export type SummonerSpellId = typeof SUMMONER_SPELL_IDS[number];

/** Base cooldowns without haste; Smite uses this as the recharge time of one charge. */
export const SUMMONER_COOLDOWN_MS: Readonly<Record<SummonerSpellId, number>> = {
  flash: 300_000, ignite: 180_000, teleport: 300_000, heal: 240_000, barrier: 180_000, exhaust: 240_000,
  cleanse: 240_000, ghost: 240_000, smite: 90_000, clarity: 240_000, mark: 80_000,
};
export const SMITE_CAST_GAP_MS = 15_000;

export const isSummonerSpellId = (value: unknown): value is SummonerSpellId =>
  typeof value === 'string' && SUMMONER_SPELL_IDS.some((id) => id === value);

export interface SpellCooldown {
  readonly spell: SummonerSpellId;
  /** One end time per missing charge, in recharge order. An ordinary spell has at most one. */
  readonly rechargeEndsAt: readonly number[];
  /** Smite's gap between casts, independent of its charge recharge. Zero for an ordinary spell. */
  readonly castEndsAt: number;
}

export interface SpellCooldownView {
  charges: number;
  ready: boolean;
  /** Time until another cast is allowed, including Smite's gap when it still has a charge. */
  remainingMs: number;
  /** Time until the next charge returns, even while another charge is ready. */
  rechargeRemainingMs: number;
}

export interface SpellCastResult {
  cast: boolean;
  cooldown: SpellCooldown;
}

/** A fresh session or spell selection starts ready, with both Smite charges full. */
export function createSpellCooldown(spell: SummonerSpellId): SpellCooldown {
  return { spell, rechargeEndsAt: [], castEndsAt: 0 };
}

export function spellCooldownView(cooldown: SpellCooldown, now: number): SpellCooldownView {
  const pending = cooldown.rechargeEndsAt.filter((end) => end > now);
  const charges = (cooldown.spell === 'smite' ? 2 : 1) - pending.length;
  const rechargeRemainingMs = Math.max(0, (pending[0] ?? now) - now);
  const gapRemainingMs = Math.max(0, cooldown.castEndsAt - now);
  const remainingMs = Math.max(charges > 0 ? 0 : rechargeRemainingMs, gapRemainingMs);
  return { charges, ready: remainingMs === 0, remainingMs, rechargeRemainingMs };
}

/** A rejected cast keeps its state; accepted casts return a new state without changing the input. */
export function castSpell(cooldown: SpellCooldown, now: number): SpellCastResult {
  if (!spellCooldownView(cooldown, now).ready) return { cast: false, cooldown };
  const pending = cooldown.rechargeEndsAt.filter((end) => end > now);
  // Missing Smite charges refill one after another; casting the second must not restart the first.
  const rechargeStartsAt = Math.max(now, pending.at(-1) ?? now);
  return {
    cast: true,
    cooldown: {
      spell: cooldown.spell,
      rechargeEndsAt: [...pending, rechargeStartsAt + SUMMONER_COOLDOWN_MS[cooldown.spell]],
      castEndsAt: cooldown.spell === 'smite' ? now + SMITE_CAST_GAP_MS : 0,
    },
  };
}

/** Clearing cooldown also restores both Smite charges and removes its cast gap. */
export function clearSpellCooldown(cooldown: SpellCooldown): SpellCooldown {
  return createSpellCooldown(cooldown.spell);
}

export interface SummonerSpellSelection {
  d: SummonerSpellId;
  f: SummonerSpellId;
}
export type SummonerSpellSlot = keyof SummonerSpellSelection;
export type SummonerState = Readonly<Record<SummonerSpellSlot, SpellCooldown>>;

/** Picking the other slot's spell swaps the pair, so a selection never introduces a duplicate. */
export function selectSummonerSpell(
  selection: SummonerSpellSelection, slot: SummonerSpellSlot, spell: SummonerSpellId,
): SummonerSpellSelection {
  const next = { ...selection };
  const other = slot === 'd' ? 'f' : 'd';
  if (selection[other] === spell) next[other] = selection[slot];
  next[slot] = spell;
  return next;
}
