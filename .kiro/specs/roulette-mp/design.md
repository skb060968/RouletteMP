# Roulette MP — Design

## Architecture

Single SPA at `index.html`. Home offers two role buttons → routes to `tv-controller.js` or `phone-controller.js`. Both observe the same Firebase node `roulette-rooms/{roomCode}` but render different UI.

The TV is the **single writer** for `game/*`, `wheel/*`, and chip-balance updates. Phones write only their own bets under `bets/player_N`.

```
                    Firebase RTDB
        roulette-rooms/{roomCode}
              │      │      │
       ┌──────┘      │      └──────────┐
       ▼             ▼                 ▼
  TV-host         Player phones       Player phones
  (opens bets,    (place bets,        …
   spins wheel,    write to
   pays out)        bets/player_N)
```

## Firebase data shape

```
roulette-rooms/
  {roomCode}/
    meta:
      host: { name, emoji, uid, connected }
      status: 'lobby' | 'betting' | 'spinning' | 'payout' | 'ended'
      createdAt, updatedAt
    players:
      player_0: { name, emoji, uid, connected, chips, broke }
      player_1: ...
      ...
      player_11: ...
    game:
      roundNumber: integer
      betsCloseAt: timestamp | null   # for the live countdown ring
      autoCloseSeconds: 30 | null
      lastResults: number[]           # last 10 winning numbers (most recent last)
    wheel:
      spinning: boolean
      winningNumber: number | null    # null until reveal
      spinStartedAt: number
    bets:
      player_0:
        # one entry per (betType, target) — chips field stacks tap by tap
        {betKey}: { type, target, chips }
        # examples:
        # 's-17':  { type: 'straight', target: 17, chips: 25 }
        # 'red':   { type: 'red',      target: null, chips: 50 }
        # 'd-1':   { type: 'dozen',    target: 1, chips: 10 }
      player_1: { ... }
    payouts:
      # written by TV on round resolution; phones read for "you won X" toast
      player_0: { wonChips, betAmount, netDelta }
      ...
```

### Bet key conventions

- `s-N` straight on number N (0-36)
- `red`, `black`, `even`, `odd`, `low`, `high`
- `d-1`, `d-2`, `d-3` dozens
- `c-1`, `c-2`, `c-3` columns

## Module layout

```
Roulette/
├── index.html
├── style.css
├── public/
│   ├── manifest.json
│   ├── sw.js                       # roulette-mp-v1
│   ├── icons/                      # 192 + 512 (lifted from Tambola MP)
│   ├── images/                      # wheel.png (background), pointer.png (optional)
│   └── sounds/                      # chip-click, bet-close, spin-loop, ball-pop, win, error
└── src/
    ├── firebase-config.js
    ├── firebase-sync.js             # roulette-rooms namespace, 12-player support
    ├── wheel.js                     # spin animation + winning-number resolution
    ├── bet-validator.js             # validateBet, computePayout
    ├── game-engine.js               # round state, payout computation, broke logic
    ├── sound-manager.js             # generic chime + click sound (no number TTS)
    ├── platform-ui.js               # showScreen, showToast, confirmModal
    ├── tv-controller.js             # TV flow: home → tv-create → tv-lobby → tv-game
    ├── phone-controller.js          # phone: home → join → lobby → bet board → results
    └── main.js                      # entry, role dispatch, SW registration
```

## Wheel animation (CSS)

The wheel is a visual element only — winning number is decided server-side (TV) before the spin starts.

- A circular `<div class="wheel">` with `background-image: url('/images/wheel.png')` (a static wheel face image with all 37 segments).
- Pointer is a small triangle CSS shape positioned at the top, fixed.
- Spin: TV computes `winningNumber`, calculates the rotation angle that lands segment N under the pointer, then sets `transform: rotate(<finalAngle + N*360deg>)` with a `transition: transform 5s cubic-bezier(0.2, 0.85, 0.3, 1)`. The transition does the easing.
- After 5s, settled state: a "halo" pulse around the winning segment.

Wheel sequence is the canonical European order (R4.2). Index in this array × `360/37` gives segment angle.

## Bet placement flow (phone)

```
player taps chip denomination (1, 5, 25, 100)
  │
  ▼
local: highlight chosen denomination
  │
  ▼
player taps a felt cell (e.g. number 17)
  │
  ▼
local: increment chips on that cell (visual chip stack)
local: update tray "Bets: 25" + "Balance: 975"
  │
  ▼
debounced 200ms write to bets/player_N/{betKey} with { type, target, chips }
  │
  ▼
TV listens to bets node — uses it to lock-out the player from over-betting,
and reads it on payout.
```

## Round resolution flow (TV)

```
host taps "Spin Now" (or auto-close timer fires)
  │
  ▼
write meta/status = 'spinning', wheel/spinning = true, wheel/spinStartedAt = now
phones see this — lock all bet cells, show "Waiting for spin…"
  │
  ▼
host computes winning number = randomInt(0..36)
write wheel/winningNumber = N
  │
  ▼
TV runs 5s rotation animation to land on N. Phones do nothing visual.
  │
  ▼
After 5s:
  - host engine reads bets node for every player
  - computes payout for each bet (returns winningChips)
  - new chip balance = old balance - totalBet + winningChips
  - if new balance == 0: broke = true
  - write atomically: players/{key}/chips, players/{key}/broke for all players
  - write payouts/{key} = { wonChips, betAmount, netDelta }
  - write meta/status = 'payout', game/lastResults push number
  - TV banner: "Winning number: N · 🔴 RED" + "Top winner: Sam +350"
  │
  ▼
After 3 seconds, host writes meta/status = 'lobby'-equivalent (back to ready-for-bet).
Bets node is cleared. Phones reset their bet boards but keep balances.
```

## Phone betting board layout

```
┌────────────────────────────────────────┐
│  Player tag (emoji + name + 💰 1000)   │
├────────────────────────────────────────┤
│  Last result: 17 BLACK     Round #4    │
├────────────────────────────────────────┤
│ ╔═╗  ┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐ │
│ ║0║  │ 3│ 6│ 9│12│15│18│21│24│27│30│33│36│2:1│
│ ║ ║  ├──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┤    │
│ ║ ║  │ 2│ 5│ 8│11│14│17│20│23│26│29│32│35│2:1│
│ ║ ║  ├──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┼──┤    │
│ ╚═╝  │ 1│ 4│ 7│10│13│16│19│22│25│28│31│34│2:1│
│      └──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┘ │
│      │  1st 12   │  2nd 12  │  3rd 12  │  │
│      │ 1-18 │EVEN│RED│BLACK│ODD│ 19-36 │  │
├────────────────────────────────────────┤
│ Chips: [1] [5] [25] [100]    Clear     │
├────────────────────────────────────────┤
│ Bets: 50    Spin in 23s                │
└────────────────────────────────────────┘
```

## TV layout

```
┌───────────────────────────────────────────────┐
│           ROULETTE MULTIPLAYER                │
├───────────────────────────────────────────────┤
│                                               │
│            ┌────────────────┐                 │
│            │                │                 │
│            │   WHEEL.png    │   ← spinning    │
│            │   (rotating)   │                 │
│            │                │                 │
│            └────────────────┘                 │
│                                               │
│   "BETS OPEN  · 23s"  /  "WINNING NUMBER: 17" │
├───────────────────────────────────────────────┤
│ Recent: 17R · 22B · 0G · 14R · 32R · 8B · …   │
├───────────────────────────────────────────────┤
│ [Sam 💰850] [Pat 💰1200] [Asha 💰0💀] …       │
├───────────────────────────────────────────────┤
│ [Open Bets] [Spin Now] [Top Up] [Reset] [✕]   │
└───────────────────────────────────────────────┘
```

## Service worker (roulette-mp-v1)

Same approach as Tambola MP:
- Network-first for `.js`, `.css`, `/index.html`, `/assets/*`
- Cache-first for `/images/*`, `/icons/*`, `/sounds/*`
- `SKIP_WAITING` postMessage support

## Build and deploy

- Vite single-entry build
- New Vercel project
- `.env` shared with the rest of the workspace
- **Firebase rules need a `roulette-rooms` block.** Will be appended to `firebase-rules.json`.

## Firebase rule snippet (will be added in tasks)

```json
"roulette-rooms": {
  "$roomCode": {
    ".read": "auth != null",
    ".write": "auth != null",
    "meta": { ... },
    "players": {
      "$playerId": {
        "name": { ".validate": "..." },
        "chips": { ".validate": "newData.isNumber() && newData.val() >= 0" },
        "broke": { ".validate": "newData.isBoolean()" },
        ...
      }
    },
    "bets": { ... },
    "wheel": { ... },
    "payouts": { ... }
  }
}
```
