# EchoLink — Your Voice. Live. Anywhere.
Created By Shiv Yogi

Turn one phone into a live wireless microphone. Approved devices listen in real time through their browsers.

## Architecture
- `public/` static app (vanilla HTML/CSS/JS), served by Workers Assets.
- `src/worker.js` Worker + `Room` Durable Object (one per 6-digit code). It relays JSON signaling only; audio is never sent through, recorded or stored.
- Host opens one `RTCPeerConnection` per approved receiver (host sends the offer, receiver answers). STUN: `stun.l.google.com:19302`. Add TURN in `ICE` at the top of `public/app.js`.
- Signaling messages: client→server `join`, `signal`, `config`, `approve`, `deny`, `kick`, `kick-all`, `block`; server→client `waiting`, `request`, `approved`, `denied`, `kicked`, `blocked`, `left`, `host-left`, `error`, `signal`.

## Run
```
npm install
npm run dev      # local; microphone works on http://localhost
npm run deploy   # needs `npx wrangler login`; Durable Object migration is in wrangler.jsonc
```
Microphone access requires HTTPS (or localhost). Deployed `*.workers.dev` URLs are HTTPS.

## Test scenario
PHONE 1: open EchoLink → Start Mic & Create Room → allow microphone → copy code.
PHONE 2: open EchoLink → Join Room → enter code → Request access.
PHONE 1: Allow PHONE 2.
PHONE 2: tap "Tap to start audio" if shown. Speak into PHONE 1; PHONE 2 plays it.
Repeat with a laptop, an Android TV browser (enable TV mode in Settings), and several receivers at once.

## Known limitations
- Hardware mic gain, sample rate and stereo are not controllable from the browser; "gain" is a software gain. Bitrate is a *maximum* requested via `setParameters`; the card shows the measured rate.
- Without TURN, some networks cannot connect peers.
- iOS/Safari requires a tap before audio plays.

## v2 changes
- **Root-cause fix:** host signals use `to`, but the Durable Object looked receivers up by `id`, so every offer/ICE candidate was dropped and receivers stayed on "Connecting…".
- ICE candidates are buffered on both sides until the remote description exists; one RTCPeerConnection per receiver; host-driven ICE restart (auto, max 3 tries) on `failed`, or `disconnected` for 4 s; receivers reconnect with backoff and trusted devices skip re-approval.
- 11 real visualizers, RMS/peak/clipping meters, per-device RTT/jitter/loss/bitrate, normalization, regenerate code, offline shell (`sw.js`), arrow-key remote navigation.
