/**
 * Optional voice-only chat client, powered by LiveKit Cloud. Standard across all
 * games — do not fork per game; only the `game` id and mount differ.
 *
 * Guarantees:
 * - Opt-in: nothing captures the mic until the player taps the voice button.
 * - Additive: every step is wrapped so a failure (token, network, LiveKit down,
 *   mic denied) only reports a status; it never throws into gameplay.
 * - livekit-client is imported dynamically, so the game bundle/startup are
 *   unaffected and a load failure can't break the app.
 * - All players in the room may join one shared voice call (LiveKit SFU).
 *
 * Token is minted by /api/livekit-token, which verifies the caller's Firebase
 * ID token. The LiveKit room is namespaced per game (`<game>-<code>`).
 */

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL;

export function createLiveKitVoice({ game, roomCode, identity, displayName, getIdToken, onStatus, onSpeakers }) {
  let room = null;
  let joined = false;
  let connecting = false;
  let muted = false;
  const audioElements = new Map();

  const emit = (state, detail = {}) => {
    try { onStatus?.({ state, joined, muted, ...detail }); } catch (_) {}
  };

  function cleanupAudio() {
    audioElements.forEach((el) => { try { el.remove(); } catch (_) {} });
    audioElements.clear();
  }

  async function join() {
    if (joined || connecting) return;
    if (!LIVEKIT_URL) { emit('error', { message: 'Voice is not configured.' }); return; }
    connecting = true;
    emit('connecting');
    try {
      const idToken = await getIdToken();
      if (!idToken) throw new Error('no-id-token');

      const response = await fetch('/api/livekit-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ game, room: roomCode, identity, name: displayName }),
      });
      if (!response.ok) throw new Error('token-request-failed');
      const { token } = await response.json();
      if (!token) throw new Error('no-token');

      const livekit = await import('livekit-client');
      const { Room, RoomEvent } = livekit;
      room = new Room({ adaptiveStream: false, dynacast: false });

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== 'audio') return;
        const el = track.attach();
        el.setAttribute('playsinline', '');
        el.autoplay = true;
        document.body.appendChild(el);
        audioElements.set(track.sid, el);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        const el = audioElements.get(track.sid);
        if (el) { try { track.detach(el); } catch (_) {} el.remove(); audioElements.delete(track.sid); }
      });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        try { onSpeakers?.(speakers.map((s) => s.identity)); } catch (_) {}
      });
      room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (room && !room.canPlaybackAudio) emit('needs-audio-unlock');
      });
      room.on(RoomEvent.Disconnected, () => { cleanupAudio(); joined = false; emit('idle'); });

      await room.connect(LIVEKIT_URL, token);
      try { await room.startAudio(); } catch (_) {}
      await room.localParticipant.setMicrophoneEnabled(true);

      joined = true;
      connecting = false;
      muted = false;
      emit('connected');
    } catch (error) {
      connecting = false;
      try { await room?.disconnect(); } catch (_) {}
      cleanupAudio();
      room = null;
      joined = false;
      emit('error', { message: 'Voice unavailable — try again.' });
    }
  }

  async function leave() {
    try { await room?.disconnect(); } catch (_) {}
    cleanupAudio();
    room = null;
    joined = false;
    connecting = false;
    muted = false;
    emit('idle');
    try { onSpeakers?.([]); } catch (_) {}
  }

  async function toggleMute() {
    if (!room) return muted;
    muted = !muted;
    try { await room.localParticipant.setMicrophoneEnabled(!muted); } catch (_) {}
    try { await room.startAudio(); } catch (_) {}
    emit('connected');
    return muted;
  }

  function destroy() { leave(); }

  return {
    join,
    leave,
    toggleMute,
    destroy,
    isJoined: () => joined,
    isMuted: () => muted,
  };
}
