/**
 * Canonical roulette bet validation and payout computation.
 * Stored bet keys are part of the integrity boundary and must agree exactly
 * with the payload's type and target.
 */
import { isRed, isBlack, dozenOf, columnOf } from './wheel.js';

export const BET_TYPES = Object.freeze({
  STRAIGHT: 'straight',
  RED: 'red',
  BLACK: 'black',
  EVEN: 'even',
  ODD: 'odd',
  LOW: 'low',
  HIGH: 'high',
  DOZEN: 'dozen',
  COLUMN: 'column',
});

export const BET_INCREMENT = 100;
export const MAX_BET_CHIPS = 1_000_000;

const PAYOUT_MULTIPLIER = Object.freeze({
  [BET_TYPES.STRAIGHT]: 35,
  [BET_TYPES.RED]: 1,
  [BET_TYPES.BLACK]: 1,
  [BET_TYPES.EVEN]: 1,
  [BET_TYPES.ODD]: 1,
  [BET_TYPES.LOW]: 1,
  [BET_TYPES.HIGH]: 1,
  [BET_TYPES.DOZEN]: 2,
  [BET_TYPES.COLUMN]: 2,
});

const isIntegerIn = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

export function betKey(type, target) {
  switch (type) {
    case BET_TYPES.STRAIGHT:
      return isIntegerIn(target, 0, 36) ? `s-${target}` : null;
    case BET_TYPES.DOZEN:
      return isIntegerIn(target, 1, 3) ? `d-${target}` : null;
    case BET_TYPES.COLUMN:
      return isIntegerIn(target, 1, 3) ? `c-${target}` : null;
    case BET_TYPES.RED:
    case BET_TYPES.BLACK:
    case BET_TYPES.EVEN:
    case BET_TYPES.ODD:
    case BET_TYPES.LOW:
    case BET_TYPES.HIGH:
      return target == null ? type : null;
    default:
      return null;
  }
}

export function validateBet(bet) {
  if (!bet || typeof bet !== 'object' || Array.isArray(bet)) return false;
  if (!Number.isSafeInteger(bet.chips) || bet.chips <= 0 ||
      bet.chips % BET_INCREMENT !== 0 || bet.chips > MAX_BET_CHIPS) {
    return false;
  }
  const { type, target } = bet;
  switch (type) {
    case BET_TYPES.STRAIGHT:
      return isIntegerIn(target, 0, 36);
    case BET_TYPES.DOZEN:
    case BET_TYPES.COLUMN:
      return isIntegerIn(target, 1, 3);
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

/** Validates key/payload canonicality and, when supplied, betting authority. */
export function validateStoredBet(key, bet, authority = null) {
  if (typeof key !== 'string' || !validateBet(bet)) return false;
  if (betKey(bet.type, bet.target) !== key) return false;
  if (authority) {
    if (!Number.isSafeInteger(authority.roundNumber) || !Number.isSafeInteger(authority.revision)) {
      return false;
    }
    if (bet.roundNumber !== authority.roundNumber || bet.revision !== authority.revision) {
      return false;
    }
  }
  return true;
}

export function betWins(bet, n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 36) return false;
  const { type, target } = bet || {};
  switch (type) {
    case BET_TYPES.STRAIGHT: return n === target;
    case BET_TYPES.RED: return isRed(n);
    case BET_TYPES.BLACK: return isBlack(n);
    case BET_TYPES.EVEN: return n !== 0 && n % 2 === 0;
    case BET_TYPES.ODD: return n !== 0 && n % 2 === 1;
    case BET_TYPES.LOW: return n >= 1 && n <= 18;
    case BET_TYPES.HIGH: return n >= 19 && n <= 36;
    case BET_TYPES.DOZEN: return dozenOf(n) === target;
    case BET_TYPES.COLUMN: return columnOf(n) === target;
    default: return false;
  }
}

export function payoutMultiplier(type) {
  return PAYOUT_MULTIPLIER[type] ?? 0;
}

export function resolveBets(bets, winningNumber) {
  if (!Array.isArray(bets)) throw new Error('Bet list must be an array');
  if (!isIntegerIn(winningNumber, 0, 36)) throw new Error('Invalid winning number');

  let totalReturn = 0;
  let totalStake = 0;
  const byBet = [];
  for (const bet of bets) {
    if (!validateBet(bet)) throw new Error('Malformed bet');
    const stake = bet.chips;
    const returned = betWins(bet, winningNumber)
      ? stake * (payoutMultiplier(bet.type) + 1)
      : 0;
    if (!Number.isSafeInteger(returned)) throw new Error('Unsafe payout');
    totalStake += stake;
    totalReturn += returned;
    if (!Number.isSafeInteger(totalStake) || !Number.isSafeInteger(totalReturn)) {
      throw new Error('Unsafe aggregate bet value');
    }
    byBet.push({ type: bet.type, target: bet.target ?? null, stake, returned });
  }
  return { totalReturn, totalStake, byBet };
}
