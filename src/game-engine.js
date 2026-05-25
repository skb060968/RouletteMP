/**
 * Roulette MP — Game Engine
 *
 * Pure functions for the TV-host's authoritative round resolution.
 * No DOM, no Firebase. Reads bets + chip balances → returns updated balances
 * and per-player payout summaries.
 */

import { resolveBets, validateBet } from './bet-validator.js';

/** Default starting chip balance per player. */
export const STARTING_CHIPS = 1000;

/** Top-up amount given to broke players when host taps "Top Up". */
export const TOP_UP_AMOUNT = 500;

/**
 * Resolves a round given the current Firebase snapshots. Returns:
 *   {
 *     winningNumber,
 *     newBalances: { player_0: 950, ... },
 *     newBroke:    { player_0: false, ... },
 *     payouts:     { player_0: { wonChips, betAmount, netDelta }, ... },
 *   }
 *
 * The TV uses these values to write back to Firebase atomically.
 *
 * @param {object} bets        firebaseSnapshot.bets — { player_0: { betKey: {type,target,chips}, ... }, ... }
 * @param {object} players     firebaseSnapshot.players — { player_0: { chips, broke, ... }, ... }
 * @param {number} winningNumber
 */
export function resolveRound(bets, players, winningNumber) {
  const newBalances = {};
  const newBroke = {};
  const payouts = {};

  Object.keys(players || {}).forEach((key) => {
    const player = players[key] || {};
    const startingChips = typeof player.chips === 'number' ? player.chips : STARTING_CHIPS;

    const playerBets = bets && bets[key] ? Object.values(bets[key]) : [];
    const validBets = playerBets.filter(validateBet);

    if (validBets.length === 0) {
      // No bets — no change.
      newBalances[key] = startingChips;
      newBroke[key] = startingChips <= 0;
      payouts[key] = { wonChips: 0, betAmount: 0, netDelta: 0 };
      return;
    }

    const { totalReturn, totalStake } = resolveBets(validBets, winningNumber);

    // Players' bets were placed against their balance, but at this point
    // we haven't actually debited yet — the host engine debits at resolution
    // (so a refresh during betting doesn't lose chips). Net change = return - stake.
    const newChips = Math.max(0, startingChips - totalStake + totalReturn);

    newBalances[key] = newChips;
    newBroke[key] = newChips <= 0;
    payouts[key] = {
      wonChips: totalReturn,
      betAmount: totalStake,
      netDelta: totalReturn - totalStake,
    };
  });

  return { winningNumber, newBalances, newBroke, payouts };
}

/**
 * Top-up logic: returns updated balances giving every broke player TOP_UP_AMOUNT.
 * Called when host taps "Top Up Broke".
 */
export function applyTopUp(players) {
  const newBalances = {};
  const newBroke = {};
  Object.keys(players || {}).forEach((key) => {
    const player = players[key] || {};
    const isBroke = !!player.broke || (player.chips || 0) <= 0;
    if (isBroke) {
      newBalances[key] = TOP_UP_AMOUNT;
      newBroke[key] = false;
    } else {
      newBalances[key] = player.chips || 0;
      newBroke[key] = false;
    }
  });
  return { newBalances, newBroke };
}

/**
 * Reset logic: returns updated balances giving every player STARTING_CHIPS.
 */
export function applyReset(players) {
  const newBalances = {};
  const newBroke = {};
  Object.keys(players || {}).forEach((key) => {
    newBalances[key] = STARTING_CHIPS;
    newBroke[key] = false;
  });
  return { newBalances, newBroke };
}

/**
 * Returns the total amount currently committed to bets for a single player.
 * Used by the phone to enforce "can't bet more than balance".
 */
export function totalCommitted(playerBets) {
  if (!playerBets) return 0;
  return Object.values(playerBets).reduce((sum, b) => sum + (b.chips || 0), 0);
}
