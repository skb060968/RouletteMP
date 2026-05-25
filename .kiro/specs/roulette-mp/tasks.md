# Roulette MP — Implementation Tasks

- [x] 1. Project scaffold (package.json, vite.config, vercel.json, .env, .gitignore, manifest)

- [x] 2. Lift assets — icons + sounds (chip-click, bet-close, spin-loop, win, error) from Tambola MP. Wheel rendered as inline SVG (no external bitmap).

- [x] 3. Source modules
  - [x] firebase-config.js
  - [x] firebase-sync.js (roulette-rooms namespace, 12-player support, bet writes, atomic payout updates)
  - [x] wheel.js (canonical European sequence, color helpers, segment-angle math)
  - [x] bet-validator.js (10 bet types: straight, red/black, even/odd, low/high, 3 dozens, 3 columns, payout multipliers)
  - [x] game-engine.js (resolveRound, applyTopUp, applyReset, totalCommitted)
  - [x] sound-manager.js (lifted, simplified — no number TTS)
  - [x] platform-ui.js (showScreen, showToast, confirmModal)
  - [x] tv-controller.js (TV flow: home → create → lobby → betting → spinning → payout)
  - [x] phone-controller.js (phone: home → join → lobby → bet board → spin lock → payout)
  - [x] main.js

- [x] 4. HTML + CSS
  - [x] index.html (single SPA — all screens)
  - [x] style.css (felt-green table, gold chips, animated SVG wheel)

- [x] 5. Service worker (roulette-mp-v1)

- [x] 6. Firebase rules block (firebase-rules.json with roulette-rooms validation)

- [x] 7. Build verification — `npm install` + `npm run build` succeed
  - 26 modules transformed
  - dist/index.html 8.78 kB
  - dist/assets/index.css 16.19 kB (gzip 3.82 kB)
  - dist/assets/index.js 31.72 kB (gzip 10.12 kB)
  - dist/assets/firebase.js 230.97 kB (gzip 68.53 kB)

- [x] 8. README.md with deploy notes and Firebase rule snippet
