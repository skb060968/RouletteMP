/**
 * Roulette MP — Bet types, validation, and payout computation.
 *
 * Bet keys (used as Firebase child names under bets/player_N/):
 *   s-N        — straight on number N (0..36)
 *   red, black — color bets
 *   even, odd  — parity bets
 *   low, high  — 1-18 / 19-36 bets
 *   d-1, d-2, d-3 — dozens
 *   c-1, c-2, c-3 — columns
 *
 * Payout multiplier × stake = chips returned (does NOT include the original
 * stake). To compute net profit on a winning bet: stake * multiplier.
 * Total returned = stake + (stake * multiplier) = stake * (multiplier + 1).
 */

import { isRed, isBlack, dozenOf, columnOf } from './wheel.js';

export const BET_TYPES = Object.freeze({
  STRAIGHT: 'straight',
  RED:      'red',
  BLACK:    'black',
  EVEN:     'even',
  ODD:      'odd',
  LOW:      'low',
  HIGH:     'high',
  DOZEN:    'dozen',
  COLUMN:   'column',
});

/** Multiplier on stake (i.e. profit ratio). Total returned = stake * (mult + 1). */
const PAYOUT_MULTIPLIER = {
  [BET_TYPES.STRAIGHT]: 35,
  [BET_TYPES.RED]: 1,
  [BET_TYPES.BLACK]: 1,
  [BET_TYPES.EVEN]: 1,
  [BET_TYPES.ODD]: 1,
  [BET_TYPES.LOW]: 1,
  [BET_TYPES.HIGH]: 1,
  [BET_TYPES.DOZEN]: 2,
  [BET_TYPES.COLUMN]: 2,
};

/**
 * Returns the canonical Firebase key for a (type, target) bet.
 * @param {string} type    one of BET_TYPES
 * @param {number|null} target  number for straight/dozen/column, null otherwise
 */
export function betKey(type, target) {
  switch (type) {
    case BET_TYPES.STRAIGHT: return `s-${target}`;
    case BET_TYPES.DOZEN:    return `d-${target}`;
    case BET_TYPES.COLUMN:   return `c-${target}`;
    case BET_TYPES.RED:      return 'red';
    case BET_TYPES.BLACK:    return 'black';
    case BET_TYPES.EVEN:     return 'even';
    case BET_TYPES.ODD:      return 'odd';
    case BET_TYPES.LOW:      return 'low';
    case BET_TYPES.HIGH:     return 'high';
    default:                 return null;
  }
}

/**
 * Returns whether a single bet wins on the given winningNumber.
 * @param {{type: string, target: number|null}} bet
 * @param {number} n  winning number 0..36
 */
export function betWins(bet, n) {
  const { type, target } = bet;
  switch (type) {
    case BET_TYPES.STRAIGHT: return n === target;
    case BET_TYPES.RED:      return isRed(n);
    case BET_TYPES.BLACK:    return isBlack(n);
    case BET_TYPES.EVEN:     return n !== 0 && n % 2 === 0;
    case BET_TYPES.ODD:      return n !== 0 && n % 2 === 1;
    case BET_TYPES.LOW:      return n >= 1 && n <= 18;
    case BET_TYPES.HIGH:     return n >= 19 && n <= 36;
    case BET_TYPES.DOZEN:    return dozenOf(n) === target;
    case BET_TYPES.COLUMN:   return columnOf(n) === target;
    default:                 return false;
  }
}

/**
 * Returns the profit multiplier for a bet type. Used at payout to compute:
 *   totalReturned = stake * (multiplier + 1)  // includes original stake
 *   profit        = stake * multiplier        // net win
 * On loss the player gets nothing back (stake already debited).
 */
export function payoutMultiplier(type) {
  return PAYOUT_MULTIPLIER[type] ?? 0;
}

/**
 * Computes the total chips returned to a player given their bets and the
 * winning number. Returns:
 *   { totalReturn, totalStake, byBet: [{type, target, stake, returned}] }
 * `totalReturn` = chips paid back to the player (0 for full loss; for a
 * winning bet, includes both the stake refund and the profit).
 *
 * @param {Array<{type:string,target:number|null,chips:number}>} bets
 * @param {number} winningNumber
 */
export function resolveBets(bets, winningNumber) {
  let totalReturn = 0;
  let totalStake = 0;
  const byBet = [];
  for (const b of bets) {
    const stake = Math.max(0, b.chips || 0);
    totalStake += stake;
    let returned = 0;
    if (betWins({ type: b.type, target: b.target }, winningNumber)) {
      returned = stake * (payoutMultiplier(b.type) + 1);
    }
    totalReturn += returned;
    byBet.push({ type: b.type, target: b.target, stake, returned });
  }
  return { totalReturn, totalStake, byBet };
}

/**
 * Validates that a bet's type and target are well-formed.
 * Used as a defence-in-depth on the host side before resolving payouts.
 */
export function validateBet(bet) {
  const { type, target } = bet || {};
  switch (type) {
    case BET_TYPES.STRAIGHT:
      return typeof target === 'number' && target >= 0 && target <= 36;
    case BET_TYPES.DOZEN:
    case BET_TYPES.COLUMN:
      return typeof target === 'number' && target >= 1 && target <= 3;
    case BET_TYPES.RED:
    case BET_TYPES.BLACK:
    case BET_TYPES.EVEN:
    case BET_TYPES.ODD:
    case BET_TYPES.LOW:
    case BET_TYPES.HIGH:
      return target == null;
    default:
      return false;
  }
}
