/**
 * Roulette MP — Wheel constants and helpers.
 *
 * European single-zero wheel (37 numbers). Numbers in the array below appear
 * in the canonical European wheel order (clockwise starting at 0). Index in
 * this array × (360 / 37) gives the angular position of that number on the
 * wheel face image.
 */

export const WHEEL_SEQUENCE = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23,
  10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

/** Standard red numbers in European Roulette. */
const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

/**
 * @param {number} n  0..36
 * @returns {'red' | 'black' | 'green'}
 */
export function colorOf(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

/**
 * @param {number} n
 * @returns {boolean}
 */
export function isRed(n) { return colorOf(n) === 'red'; }
export function isBlack(n) { return colorOf(n) === 'black'; }

/** Dozen 1 = 1-12, Dozen 2 = 13-24, Dozen 3 = 25-36. 0 belongs to no dozen. */
export function dozenOf(n) {
  if (n < 1 || n > 36) return null;
  if (n <= 12) return 1;
  if (n <= 24) return 2;
  return 3;
}

/** Column 1 = 1,4,7,...,34. Column 2 = 2,5,...,35. Column 3 = 3,6,...,36. */
export function columnOf(n) {
  if (n < 1 || n > 36) return null;
  return ((n - 1) % 3) + 1;
}

/**
 * Returns the number of degrees a wheel must rotate from its current
 * 0-degree position so that the given winningNumber sits under the pointer.
 * Adds full extra rotations for spin theatrics.
 *
 * @param {number} winningNumber  0..36
 * @param {number} extraSpins     full 360-degree spins to add for animation
 * @returns {number} degrees (positive)
 */
export function rotationForWinning(winningNumber, extraSpins = 5) {
  const idx = WHEEL_SEQUENCE.indexOf(winningNumber);
  if (idx < 0) return 0;
  const segmentDeg = 360 / WHEEL_SEQUENCE.length;
  // The wheel image's "0" segment starts at the 12 o'clock pointer.
  // We want segment idx to land at the pointer, so rotate -idx*segDeg
  // (i.e. 360 - idx*segDeg) plus full spins.
  const targetDeg = (360 - idx * segmentDeg) % 360;
  return extraSpins * 360 + targetDeg;
}
