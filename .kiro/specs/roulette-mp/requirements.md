# Roulette MP — Requirements

## Overview

Roulette MP is a "TV + phones" party version of European Roulette. Everyone gathers in one room. One device opens the URL on the TV/big screen and creates the room — that device is the **TV-host**, the authoritative game server. Every player (including the human who set up the TV) joins from their **phone** with a 4-letter room code. The TV runs the wheel, controls the bet window, computes payouts. Each phone shows the player's chip stack and a compact betting board.

## User Roles

- **TV-host** — first device to open the URL on the big screen. Holds no chips. Drives the round flow: opens betting, spins the wheel, reveals the winning number, distributes payouts.
- **Player** — every other device (phones), including the human who set up the TV. Each starts with 1000 chips that **carry forward across rounds** in the same room. If a player goes broke (chips = 0), they sit out future rounds with a "broke" badge but stay in the room.

## Core Requirements

### R1 — Home screen and role selection
- R1.1 Same URL serves both views. Home screen has two buttons:
  - **"📺 Play on TV (Host)"**
  - **"📱 Join as Player"**

### R2 — Room creation (TV)
- R2.1 4-letter room code from charset `ABCDEFGHJKLMNPQRSTUVWXYZ`.
- R2.2 TV-host record: `meta.host = { name, emoji, uid, connected }`. No chips.
- R2.3 Lobby shows: huge room code, live player list with name + emoji + chip balance.
- R2.4 Start Round button enables when ≥1 player has joined and at least one player has chips.

### R3 — Player join (phone)
- R3.1 Phone enters code, name, emoji on Join form.
- R3.2 Lobby on phone shows: room code, player list with chip balances, "Waiting for host to start round…".
- R3.3 **Maximum 12 players per room.** Joins past 12 are rejected with toast "Room is full (12)".
- R3.4 Each new player starts with **1000 chips**.
- R3.5 Players returning to the same room (refresh) keep their chip balance.

### R4 — European wheel (no double-zero)
- R4.1 37 numbers: 0 (green) and 1-36 (alternating red/black per the standard European wheel sequence).
- R4.2 Standard European wheel sequence used for the spinning animation:
  `0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26`
- R4.3 Red numbers: `1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36`. Black numbers: the remaining 1-36.

### R5 — Bet types supported
- R5.1 **Straight** (single 0-36): pays **35:1**
- R5.2 **Red / Black**: pays **1:1** (0 loses)
- R5.3 **Even / Odd**: pays **1:1** (0 loses, 0 is neither)
- R5.4 **Low (1-18) / High (19-36)**: pays **1:1** (0 loses)
- R5.5 **Dozen 1 (1-12), Dozen 2 (13-24), Dozen 3 (25-36)**: pays **2:1**
- R5.6 **Column 1 (1,4,7,…,34), Column 2 (2,5,8,…,35), Column 3 (3,6,9,…,36)**: pays **2:1**
- R5.7 (Out of scope for v1: split/street/corner/six-line — too cramped for phone UI.)

### R6 — Round flow
- R6.1 **Bets-open phase**: TV-host taps "Open Bets". Phones unlock the betting board. Default 30-second auto-close timer (host can disable).
- R6.2 During bets-open, players tap a chip denomination (1, 5, 25, 100) then tap a bet area on the felt to place that chip on it. Each tap stacks more chips. Tapping "Clear" wipes all bets for that round.
- R6.3 Total bet amount validated against chip balance — cannot bet more than you have.
- R6.4 **Bets-close**: timer expires OR host taps "Spin Now" early. Phones lock the board, show "Waiting for spin…".
- R6.5 **Spin**: TV runs a 5-second wheel animation (CSS-driven), settles on the random winning number computed by the host.
- R6.6 **Reveal + payout**: winning number shown big with red/black/green color. Host engine computes each player's total winnings, updates chip balances in Firebase. TV shows a winner banner.
- R6.7 **Next round**: host taps "Open Bets" again. Players' bet boards are reset; chip balances persist.

### R7 — Chips and broke handling
- R7.1 Each player's chip balance is stored under `players/player_N/chips`.
- R7.2 New player joins with 1000 chips.
- R7.3 Chips persist across rounds, refreshes, and disconnect/reconnect within the same room.
- R7.4 If a player's chips hit 0, they're flagged "broke" — phone shows "🙅 You're out — wait for next room" and the betting board is disabled. They remain in the room (so others can see them).
- R7.5 Host can use a "Top Up" button on TV to give all broke players a fresh 500 chips (party-friendly, optional). Single-tap, no per-player choosing.
- R7.6 If host clicks "Reset Chips", every player goes back to 1000 (with confirm modal).

### R8 — Phone betting board
- R8.1 Compact felt:
  - Top row: 0 (green, single tall cell on the left side) + numbers 1-36 in a 3×12 grid (matching the standard European table layout: rows of 3 going up — col 1 has 1,2,3 / col 2 has 4,5,6 / etc).
  - Below the grid: 3 dozens cells (1-12, 13-24, 25-36)
  - Below that: outside bets row (1-18, EVEN, RED, BLACK, ODD, 19-36)
  - 3 column-bet cells on the right edge of the number grid
- R8.2 Chip denominations row: **1, 5, 25, 100** + **Clear** button.
- R8.3 Currently-selected denomination highlighted gold.
- R8.4 Tap a bet area → places one chip of the current denomination there. Visual chip stack appears on the cell. Total bet amount in tray.
- R8.5 **Lock state**: when bets close, all cells go disabled; "Waiting for spin…" overlay appears. After reveal, winning bets briefly highlight green and the chip-tray balance updates.

### R9 — TV layout
- R9.1 Title centered at top.
- R9.2 Center: animated wheel — large, dominant. Inside the wheel a pointer.
- R9.3 During betting: countdown timer ring around the wheel + "BETS OPEN" badge. After spin: winning number shown big + colored.
- R9.4 Bottom strip: "Recent Numbers" — last 10 results as colored chips (red/black/green).
- R9.5 Below recent numbers: per-player chip-balance row (12 player cards, name + emoji + chip count, with broke-grey overlay for broke players).
- R9.6 Host controls (always visible): Open Bets, Spin Now, Top Up Broke, Reset Chips, Mute, End Game.

### R10 — Sound
- R10.1 TV plays: ball-drop chime when bets close, wheel spin sound (subtle whoosh, ~5s), pop when winning number lands, win fanfare when payouts apply.
- R10.2 Phone plays: chip-place click on each tap, soft chime when bets close, win sound if their bets won.
- R10.3 Mute toggles per device, persisted in localStorage.

### R11 — Connectivity / sessions
- R11.1 `onDisconnect` flips `connected: false` on player slots.
- R11.2 If host disconnects, the room is deleted after 60 seconds.
- R11.3 Phones save `{ roomCode, playerIndex, role: 'phone' }` in localStorage so refresh rejoins.
- R11.4 TV saves `{ roomCode, role: 'tv' }` so a TV browser refresh re-attaches.

### R12 — UI patterns (consistent with Tambola MP / SnL MP)
- R12.1 Custom modals (no `prompt`/`confirm`).
- R12.2 Back buttons on every setup screen.
- R12.3 BOM-free UTF-8 source files.
- R12.4 Idempotent listener wiring (`_wired` flag).
- R12.5 `_resultsShown` guards.
- R12.6 Listener cleanup on screen exit.
- R12.7 LocalStorage (not session).
- R12.8 Service worker `roulette-mp-v1`, network-first HTML/JS/CSS, cache-first assets.

## Non-functional

- **Mobile-first phones, TV-friendly host view.** Phone targets 360-414px portrait. TV targets 1280-3840px landscape.
- **Single SPA**, runtime role selection.
- **One Firebase write per bet placement** (debounced ~200ms client-side so rapid taps batch).
- **One Firebase write per round resolution** (TV computes payouts and writes everyone's new balances atomically).

## Out of scope (v1)

- Split/street/corner/six-line bets
- Multi-spin "rapid roulette"
- Chat/emoji reactions
- Spectators
- Internationalization
