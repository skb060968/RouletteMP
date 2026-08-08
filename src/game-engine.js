/** Pure, defensive roulette settlement helpers. */
import { resolveBets, validateStoredBet } from './bet-validator.js';

export const STARTING_CHIPS = 1000;
export const TOP_UP_AMOUNT = 500;
const PLAYER_KEY = /^player_([0-9]|1[01])$/;
const MAX_BETS_PER_PLAYER = 49;

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

/**
 * Resolve a room's locked books defensively. Malformed data still rejects the
 * settlement, but aggregate over-bets are reduced deterministically by key so
 * an untrusted player cannot block the host or wager more than their balance.
 */
export function resolveRound(bets, players, winningNumber, authority = null) {
  const books = bets || {};
  const roster = players || {};
  assertPlainObject(books, 'Bet books');
  assertPlainObject(roster, 'Players');

  for (const [playerKey, book] of Object.entries(books)) {
    if (!PLAYER_KEY.test(playerKey) || !roster[playerKey]) {
      if (book && Object.keys(book).length) throw new Error('Bet book has no valid owner');
    }
  }

  const newBalances = {};
  const newBroke = {};
  const payouts = {};
  const acceptedBets = {};

  for (const [playerKey, player] of Object.entries(roster)) {
    if (!PLAYER_KEY.test(playerKey)) throw new Error('Malformed player key');
    assertPlainObject(player, 'Player');
    const startingChips = player.chips;
    if (!Number.isSafeInteger(startingChips) || startingChips < 0) {
      throw new Error('Malformed player balance');
    }

    const book = books[playerKey] || {};
    assertPlainObject(book, 'Player bet book');
    const entries = Object.entries(book).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length > MAX_BETS_PER_PLAYER) throw new Error('Too many bets');

    const validBets = [];
    const acceptedBook = {};
    let acceptedStake = 0;
    for (const [key, bet] of entries) {
      if (!validateStoredBet(key, bet, authority)) throw new Error('Malformed bet book');
      if (acceptedStake + bet.chips > startingChips) continue;
      acceptedStake += bet.chips;
      validBets.push(bet);
      acceptedBook[key] = bet;
    }
    if (Object.keys(acceptedBook).length) acceptedBets[playerKey] = acceptedBook;

    const { totalReturn, totalStake } = resolveBets(validBets, winningNumber);
    const newChips = startingChips - totalStake + totalReturn;
    if (!Number.isSafeInteger(newChips) || newChips < 0) throw new Error('Unsafe balance');

    newBalances[playerKey] = newChips;
    newBroke[playerKey] = newChips === 0;
    payouts[playerKey] = {
      wonChips: totalReturn,
      betAmount: totalStake,
      netDelta: totalReturn - totalStake,
    };
  }

  return { winningNumber, newBalances, newBroke, payouts, acceptedBets };
}

export function applyTopUp(players) {
  const newBalances = {};
  const newBroke = {};
  Object.entries(players || {}).forEach(([key, player]) => {
    const chips = Number.isSafeInteger(player?.chips) && player.chips >= 0 ? player.chips : 0;
    const broke = !!player?.broke || chips === 0;
    newBalances[key] = broke ? TOP_UP_AMOUNT : chips;
    newBroke[key] = false;
  });
  return { newBalances, newBroke };
}

export function applyReset(players) {
  const newBalances = {};
  const newBroke = {};
  Object.keys(players || {}).forEach((key) => {
    newBalances[key] = STARTING_CHIPS;
    newBroke[key] = false;
  });
  return { newBalances, newBroke };
}

export function totalCommitted(playerBets) {
  let total = 0;
  for (const bet of Object.values(playerBets || {})) {
    if (!Number.isSafeInteger(bet?.chips) || bet.chips <= 0) return Number.POSITIVE_INFINITY;
    total += bet.chips;
    if (!Number.isSafeInteger(total)) return Number.POSITIVE_INFINITY;
  }
  return total;
}
