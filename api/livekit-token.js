import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AccessToken } from 'livekit-server-sdk';

/**
 * Vercel serverless function: mints a short-lived LiveKit access token for the
 * voice feature. Verifies the caller's Firebase anonymous ID token (jose)
 * against Google's public keys and this app's Firebase project, then issues a
 * LiveKit JWT scoped to a per-game namespaced room (`<game>-<code>`).
 *
 * Required Vercel env (server-side, NOT VITE_): LIVEKIT_API_KEY, LIVEKIT_API_SECRET
 * Optional: FIREBASE_PROJECT_ID (defaults to this app's project).
 */

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'skb-games';
const ROOM_RE = /^[A-HJ-NP-Z]{4}$/;
// Supports every game's slot range (up to 12 players → player_0..player_11).
const IDENTITY_RE = /^player_(?:[0-9]|1[01])$/;
const GAME_RE = /^[a-z][a-z0-9-]{1,15}$/;

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

function sanitizeName(value) {
  return String(value || 'Player').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 16) || 'Player';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }
  try {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      res.status(500).json({ error: 'voice-not-configured' });
      return;
    }

    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).json({ error: 'missing-token' });
      return;
    }

    let uid;
    try {
      const { payload } = await jwtVerify(idToken, JWKS, {
        issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
        audience: FIREBASE_PROJECT_ID,
      });
      uid = payload.sub;
      if (!uid) throw new Error('no-subject');
    } catch (_) {
      res.status(401).json({ error: 'invalid-token' });
      return;
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const code = String(body.room || '').toUpperCase();
    const game = String(body.game || '').toLowerCase();
    const identity = String(body.identity || '');
    if (!ROOM_RE.test(code) || !GAME_RE.test(game) || !IDENTITY_RE.test(identity)) {
      res.status(400).json({ error: 'invalid-room-or-identity' });
      return;
    }
    const room = `${game}-${code}`;

    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      name: sanitizeName(body.name),
      ttl: '2h',
      metadata: JSON.stringify({ uid }),
    });
    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });

    const jwt = await token.toJwt();
    res.status(200).json({ token: jwt });
  } catch (error) {
    res.status(500).json({ error: 'token-failed' });
  }
}
