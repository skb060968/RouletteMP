# Roulette MP

A "TV + phones" party version of European Roulette. One device opens the URL on a TV/big screen and creates the room — that device runs the wheel, opens betting, spins, and computes payouts. Every player joins from their phone and places bets on a compact felt-style board.

## Roles

- **TV-host** — first device to open the URL and tap "📺 Play on TV". Holds no chips. Drives the round flow: opens betting, spins the wheel, reveals the winning number, distributes payouts.
- **Player** — every other device. Each starts with 1000 chips that **carry forward across rounds**. If chips hit 0, the player goes "broke" and sits out future rounds. Host can tap "Top Up Broke" to give 500 chips to all broke players, or "Reset Chips" to put everyone back to 1000.

## Bet types

- **Straight** (single 0-36) — pays 35:1
- **Red / Black** — pays 1:1 (0 loses)
- **Even / Odd** — pays 1:1 (0 loses)
- **Low (1-18) / High (19-36)** — pays 1:1
- **Dozens (1-12, 13-24, 25-36)** — pays 2:1
- **Columns** — pays 2:1

## Stack

- Vite + Vanilla JS
- Firebase Realtime Database (shared with the rest of the workspace)
- PWA with service worker `roulette-mp-v1`
- Single SPA, runtime role selection on the home screen

## Local development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Deploy

- New Vercel project pointing at this folder
- Build command: `npm run build`
- Output directory: `dist`
- Framework: Vite

## Firebase rule

Append the contents of `firebase-rules.json` into your existing rules file (sibling to `snl-rooms`, `tambola-mp-rooms`, etc.).

## Round flow

1. **Lobby** — players join, see chip balances. Host taps "Start Round".
2. **Bets open** (30s by default) — phones unlock the felt. Tap a chip denomination, then tap a bet area. Tap again to stack more chips. "Clear" wipes your bets.
3. **Spin** — host taps "Spin Now" or auto-close timer fires. Phones lock the board. TV runs the 5-second wheel animation.
4. **Reveal + payout** — TV shows the winning number colored red/black/green. Each player's chip balance updates. Winning bet cells flash gold.
5. **Auto-open next round** — 3.5 seconds after the reveal, betting opens again automatically.

## Notes

- Up to 12 players per room.
- Letters-only 4-character room codes.
- Chips persist across rounds, refreshes, disconnects within the same room.
- Per-bet writes are debounced (~200ms) so rapid taps batch.
- Confetti on the TV celebrates each result, colored to the winning segment.
