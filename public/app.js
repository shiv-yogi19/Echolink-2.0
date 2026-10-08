'use strict';
const $ = (id) => document.getElementById(id);
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }]; // add TURN servers here for restrictive networks
const DEF = { layout: 'glass', theme: 'dark', echo: true, noise: true, agc: true, gain: 1, bitrate: 64000, mic: '', approval: true, max: 10, viz: 'bars', sens: 1.5, tv: false, smooth: 0.8, intensity: 1, fps: '60', glow: 8, density: 48, norm: false, latency: 'interactive', blur: 18, anim: true, reduce: false };
const ERR = { taken: 'Room code collision. Try again.', 'not-found': 'Room not found, or the host is unavailable.', locked: 'This room is locked.', full: 'This room is full.', blocked: 'You have been blocked from this room.' };
let S;
try { S = { ...DEF, ...JSON.parse(localStorage.getItem('echolink') || '{}') }; } catch { S = { ...DEF }; }
const save = () => localStorage.setItem('echolink', JSON.stringify(S));
const devId = localStorage.echolinkId || (localStorage.echolinkId = crypto.randomUUID());

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  $('toasts').append(t); setTimeout(() => t.remove(), 4000);
}
const show = (id) => document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; });
function applyLook() {
  document.body.dataset.layout = S.layout; document.body.dataset.theme = S.theme;
  document.body.classList.toggle('tv', !!S.tv);
  document.body.classList.toggle('lite', S.layout === 'minimal');
  document.body.classList.toggle('noanim', !S.anim || S.reduce);
  document.body.style.setProperty('--blur', S.blur + 'px');
}
function openWs(code, role, onmsg, onclose) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${code}?role=${role}`);
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onmsg(m); };
  ws.onclose = onclose;
  return ws;
}
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

/* ---------------- HOST ---------------- */
const H = { peers: new Map(), locked: false, muted: false };

const acquireMic = () => navigator.mediaDevices.getUserMedia({ audio: {
  deviceId: S.mic ? { exact: S.mic } : undefined,
  echoCancellation: S.echo, noiseSuppression: S.noise, autoGainControl: S.agc, channelCount: 1 } });
const micError = (e) => e.name === 'NotAllowedError' ? 'Microphone permission denied.' : e.name === 'NotFoundError' ? 'No microphone found.' : 'Microphone unavailable.';

async function startHost() {
  if (!window.RTCPeerConnection || !navigator.mediaDevices) return toast('This browser lacks WebRTC/microphone support (HTTPS is required).', 'err');
  try { H.stream = await acquireMic(); } catch (e) { return toast(micError(e), 'err'); }
  // Mic -> gain (software) -> compressor (normalization) -> analyser (visualizer) + destination (sent to peers)
  H.ctx = new AudioContext({ latencyHint: S.latency });
  await H.ctx.resume().catch(() => {}); // a suspended context would send silence
  H.gain = H.ctx.createGain(); H.gain.gain.value = S.gain;
  H.comp = H.ctx.createDynamicsCompressor(); setNorm();
  H.an = H.ctx.createAnalyser(); H.an.fftSize = 2048;
  H.dest = H.ctx.createMediaStreamDestination();
  H.wave = new Uint8Array(H.an.fftSize); H.freq = new Uint8Array(H.an.frequencyBinCount);
  H.parts = []; H.lvl = 0; H.clipUntil = 0;
  H.gain.connect(H.comp); H.comp.connect(H.an); H.comp.connect(H.dest);
  H.src = H.ctx.createMediaStreamSource(H.stream); H.src.connect(H.gain);
  let code;
  try { code = (await (await fetch('/api/code')).json()).code; } catch { /* handled below */ }
  if (!code) { stopHost(); return toast('Could not create a room. Check your connection.', 'err'); }
  H.muted = false; H.locked = false;
  $('mute').textContent = 'Mute mic'; $('lock').textContent = 'Lock room';
  openHostWs(code);
  show('host'); renderPeers(); H.raf = requestAnimationFrame(draw); H.stat = setInterval(pollStats, 2000);
  fillMics(); audioInfo(); keepAwake();
}
function openHostWs(code) {
  H.code = code;
  const ws = H.ws = openWs(code, 'host', onHostMsg, () => { if (H.ws === ws) { toast('Signaling disconnected. Session ended.', 'err'); stopHost(); } });
  ws.onopen = sendConfig;
  $('roomCode').textContent = code.replace(/(\d{3})(\d{3})/, '$1 $2'); $('roomStatus').textContent = 'OPEN';
}
async function regen() {
  let code;
  try { code = (await (await fetch('/api/code')).json()).code; } catch { /* handled below */ }
  if (!code) return toast('Could not regenerate the code.', 'err');
  const old = H.ws; H.ws = null;
  if (old) { send(old, { type: 'kick-all' }); old.close(); }
  H.peers.forEach((p) => { clearTimeout(p.timer); if (p.pc) p.pc.close(); }); H.peers.clear();
  H.locked = false; $('lock').textContent = 'Lock room';
  openHostWs(code); renderPeers(); toast('New room code. Receivers must rejoin.', 'ok');
}
function setNorm() { H.comp.threshold.value = -24; H.comp.ratio.value = S.norm ? 12 : 1; }
function audioInfo() {
  const t = H.stream.getAudioTracks()[0], s = t.getSettings(), c = t.getCapabilities ? t.getCapabilities() : {};
  const stereo = c.channelCount && c.channelCount.max >= 2 ? 'stereo-capable' : 'stereo not reported';
  $('audioInfo').textContent = `${t.label || 'Microphone'} • context ${H.ctx.sampleRate} Hz • track ${s.sampleRate || '?'} Hz • ${s.channelCount || '?'} ch (${stereo}) • output latency ${Math.round((H.ctx.baseLatency || 0) * 1000)} ms`;
}
async function keepAwake() { try { H.wl = await navigator.wakeLock.request('screen'); } catch { /* unsupported or denied */ } }
function stopHost() {
  const ws = H.ws; H.code = null; H.ws = null; if (ws) ws.close();
  clearInterval(H.stat); cancelAnimationFrame(H.raf);
  H.peers.forEach((p) => { clearTimeout(p.timer); if (p.pc) p.pc.close(); }); H.peers.clear();
  if (H.stream) H.stream.getTracks().forEach((t) => t.stop());
  if (H.ctx) H.ctx.close();
  if (H.wl) H.wl.release().catch(() => {});
  H.stream = H.ctx = H.wl = null; show('home');
}
const sendConfig = () => send(H.ws, { type: 'config', approval: S.approval, locked: H.locked, max: Math.max(1, S.max | 0) });

function onHostMsg(m) {
  if (m.type === 'error') { toast(ERR[m.code] || 'Room error', 'err'); stopHost(); }
  else if (m.type === 'request') { H.peers.set(m.id, { info: m.info, state: 'pending' }); toast(`${m.info.name} wants to join`, 'info'); renderPeers(); }
  else if (m.type === 'approved') connectPeer(m.id, m.info);
  else if (m.type === 'left') { const p = H.peers.get(m.id); if (p) { if (p.pc) p.pc.close(); H.peers.delete(m.id); renderPeers(); } }
  else if (m.type === 'signal') onPeerSignal(m.from, m.data);
}
// One RTCPeerConnection per approved receiver; the host always makes the offer.
async function connectPeer(id, info) {
  const p = H.peers.get(id) || {};
  if (p.pc) p.pc.close(); // never keep two connections for one receiver
  Object.assign(p, { info, state: 'connecting', muted: false, pending: [], tries: 0 }); H.peers.set(id, p);
  const pc = p.pc = new RTCPeerConnection({ iceServers: ICE });
  p.sender = pc.addTrack(H.dest.stream.getAudioTracks()[0], H.dest.stream);
  pc.onicecandidate = (e) => { if (e.candidate) send(H.ws, { type: 'signal', to: id, data: { candidate: e.candidate } }); };
  pc.onconnectionstatechange = () => {
    p.state = pc.connectionState; // new | connecting | connected | disconnected | failed | closed
    if (p.state === 'connected') { p.tries = 0; toast(`${info.name} connected`, 'ok'); }
    renderPeers();
  };
  pc.oniceconnectionstatechange = () => { // new | checking | connected | completed | disconnected | failed | closed
    const s = pc.iceConnectionState;
    clearTimeout(p.timer);
    if (s === 'failed') restartIce(id);
    else if (s === 'disconnected') p.timer = setTimeout(() => { if (pc.iceConnectionState === 'disconnected') restartIce(id); }, 4000);
    renderPeers();
  };
  await negotiate(id, false);
}
// Host-driven (re)negotiation. iceRestart:true re-gathers candidates on the same connection.
async function negotiate(id, restart) {
  const p = H.peers.get(id);
  if (!p || !p.pc || p.pc.signalingState === 'closed') return;
  try {
    await p.pc.setLocalDescription(await p.pc.createOffer({ iceRestart: restart }));
    send(H.ws, { type: 'signal', to: id, data: { sdp: p.pc.localDescription } });
    if (!restart) applyBitrate(p);
  } catch { toast('Could not negotiate with a device.', 'err'); }
  renderPeers();
}
function restartIce(id) {
  const p = H.peers.get(id);
  if (!p) return;
  if (++p.tries > 3) { p.state = 'failed'; toast(`${p.info.name}: could not recover. Ask them to rejoin.`, 'err'); renderPeers(); return; }
  p.state = 'reconnecting'; negotiate(id, true); renderPeers();
}
async function applyBitrate(p) {
  try {
    const x = p.sender.getParameters();
    if (!x.encodings || !x.encodings.length) x.encodings = [{}];
    x.encodings[0].maxBitrate = S.bitrate;
    await p.sender.setParameters(x);
  } catch { /* browser refused; the measured bitrate shown in the device card stays the truth */ }
}
async function onPeerSignal(id, d) {
  const p = H.peers.get(id);
  if (!p || !p.pc || !d) return;
  try {
    if (d.restart) restartIce(id); // receiver reported ICE failure
    else if (d.sdp) { // answer: flush candidates that arrived before it
      await p.pc.setRemoteDescription(d.sdp);
      for (const c of p.pending) await p.pc.addIceCandidate(c);
      p.pending = [];
    } else if (d.candidate) {
      if (p.pc.remoteDescription) await p.pc.addIceCandidate(d.candidate); else p.pending.push(d.candidate);
    }
  } catch { /* stale answer or candidate */ }
}
function peerAction(act, id) {
  const p = H.peers.get(id);
  if (!p) return;
  if (act === 'allow') send(H.ws, { type: 'approve', id });
  else if (act === 'mute') {
    p.muted = !p.muted;
    if (p.sender) p.sender.replaceTrack(p.muted ? null : H.dest.stream.getAudioTracks()[0]);
  } else { // deny | kick | block
    send(H.ws, { type: act, id });
    if (p.pc) p.pc.close();
    H.peers.delete(id);
  }
  renderPeers();
}
function renderPeers() {
  const list = $('peers'); list.textContent = '';
  let connected = 0, pending = 0;
  H.peers.forEach((p, id) => {
    if (p.state === 'pending') pending++; else if (p.state === 'connected') connected++;
    const li = document.createElement('li'); li.className = 'peer ' + p.state;
    const name = document.createElement('b'); name.textContent = p.info.name;
    const meta = document.createElement('small');
    meta.textContent = `${p.info.os} • ${p.info.browser} • ${p.state === 'pending' ? 'requesting access' : p.state}` +
      (p.rtt != null ? ` • ${p.rtt} ms • ${quality(p)}` : '') + (p.kbps ? ` • ${p.kbps} kbps` : '') +
      (p.jit != null ? ` • jitter ${p.jit} ms • lost ${p.lost}` : '') + (p.pc ? ` • ice:${p.pc.iceConnectionState}` : '');
    li.append(name, meta);
    const acts = p.state === 'pending' ? [['allow', 'Allow'], ['deny', 'Deny'], ['block', 'Block']]
      : [['mute', p.muted ? 'Unmute' : 'Mute'], ['kick', 'Disconnect'], ['block', 'Block']];
    acts.forEach(([a, l]) => { const b = document.createElement('button'); b.textContent = l; b.dataset.act = a; b.dataset.id = id; li.append(b); });
    list.append(li);
  });
  $('statDevices').textContent = connected; $('statPending').textContent = pending;
}
$('peers').onclick = (e) => { const b = e.target.closest('button'); if (b) peerAction(b.dataset.act, b.dataset.id); };

const quality = (p) => (p.rtt < 120 && !(p.lost > 50) ? 'Good' : p.rtt < 300 ? 'Fair' : 'Poor');
async function pollStats() {
  for (const p of H.peers.values()) {
    if (!p.pc || p.pc.connectionState !== 'connected') continue;
    try {
      const r = await p.pc.getStats(); let bytes = 0;
      r.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null) p.rtt = Math.round(s.currentRoundTripTime * 1000);
        if (s.type === 'outbound-rtp' && s.kind === 'audio') bytes = s.bytesSent;
        if (s.type === 'remote-inbound-rtp') { p.lost = s.packetsLost; p.jit = s.jitter != null ? Math.round(s.jitter * 1000) : null; }
      });
      if (p.bytes != null) p.kbps = Math.round(((bytes - p.bytes) * 8) / 2000);
      p.bytes = bytes;
    } catch { /* peer closed mid-poll */ }
  }
  renderPeers();
}
// Every visualizer reads the live analyser data (H.wave / H.freq / H.lvl); silence flattens them all.
const TAU = Math.PI * 2;
const VIZ = {
  wave(g, w, h) { g.beginPath(); H.wave.forEach((v, i) => { const x = (i / H.wave.length) * w, y = h / 2 + ((v - 128) / 128) * (h / 2) * S.sens * S.intensity; if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); },
  neon(g, w, h) { for (let k = 3; k > 0; k--) { g.lineWidth = k * 2; g.globalAlpha = 0.25 * (4 - k); VIZ.wave(g, w, h); } g.globalAlpha = 1; },
  scope(g, w, h) { g.globalAlpha = 0.2; g.beginPath(); for (let i = 1; i < 8; i++) { g.moveTo((i * w) / 8, 0); g.lineTo((i * w) / 8, h); } for (let j = 1; j < 4; j++) { g.moveTo(0, (j * h) / 4); g.lineTo(w, (j * h) / 4); } g.stroke(); g.globalAlpha = 1; VIZ.wave(g, w, h); },
  bars(g, w, h) { const n = S.density, st = (H.freq.length / 2 / n) | 0; for (let i = 0; i < n; i++) { const b = Math.min(h, (H.freq[i * st] / 255) * h * S.sens * S.intensity); g.fillRect((i * w) / n + 1, h - b, w / n - 2, b); } },
  mirror(g, w, h) { const n = S.density, st = (H.freq.length / 2 / n) | 0; for (let i = 0; i < n; i++) { const b = Math.min(h / 2, (H.freq[i * st] / 255) * (h / 2) * S.sens * S.intensity); g.fillRect((i * w) / n + 1, h / 2 - b, w / n - 2, b * 2 || 1); } },
  circle(g, w, h) { const n = S.density, st = (H.freq.length / 2 / n) | 0, r = h * 0.25; g.beginPath(); for (let i = 0; i < n; i++) { const a = (i / n) * TAU, b = (H.freq[i * st] / 255) * h * 0.22 * S.sens * S.intensity; g.moveTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r); g.lineTo(w / 2 + Math.cos(a) * (r + b), h / 2 + Math.sin(a) * (r + b)); } g.lineWidth = 3; g.stroke(); },
  radial(g, w, h) { g.beginPath(); H.wave.forEach((v, i) => { if (i % 4) return; const a = (i / H.wave.length) * TAU, r = h * 0.28 + ((v - 128) / 128) * h * 0.3 * S.sens * S.intensity, x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r; if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.closePath(); g.stroke(); },
  rings(g, w, h) { for (let k = 1; k <= 5; k++) { g.globalAlpha = 1 - k * 0.15; g.beginPath(); g.arc(w / 2, h / 2, k * h * 0.08 * (1 + H.lvl * S.intensity), 0, TAU); g.stroke(); } g.globalAlpha = 1; },
  pulse(g, w, h) { g.globalAlpha = 0.8; g.beginPath(); g.arc(w / 2, h / 2, h * 0.1 + H.lvl * h * 0.35 * S.intensity, 0, TAU); g.fill(); g.globalAlpha = 1; },
  tunnel(g, w, h) { const n = 12, st = (H.freq.length / 2 / n) | 0; for (let i = n - 1; i >= 0; i--) { const s = ((i + 1) / n) * (1 + (H.freq[i * st] / 255) * S.sens * S.intensity * 0.5); g.globalAlpha = 0.9 - (i / n) * 0.7; g.strokeRect(w / 2 - (w * s) / 2, h / 2 - (h * s) / 2, w * s, h * s); } g.globalAlpha = 1; },
  particles(g, w, h) {
    const P = H.parts;
    for (let i = 0; i < Math.round(H.lvl * 8 * S.intensity) && P.length < S.density * 4; i++) { const a = Math.random() * TAU, v = 1 + Math.random() * 3 * H.lvl; P.push({ x: w / 2, y: h / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, l: 1 }); }
    for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; p.x += p.vx; p.y += p.vy; p.l -= 0.02; if (p.l <= 0) { P.splice(i, 1); continue; } g.globalAlpha = p.l; g.fillRect(p.x, p.y, 3, 3); }
    g.globalAlpha = 1;
  },
};
let lastDraw = 0;
function draw(t) {
  H.raf = requestAnimationFrame(draw);
  if (!H.an) return;
  const fps = S.fps === 'auto' ? (document.body.classList.contains('lite') ? 30 : 60) : Number(S.fps);
  if (t - lastDraw < 1000 / fps - 2) return;
  lastDraw = t;
  H.an.smoothingTimeConstant = S.smooth;
  H.an.getByteTimeDomainData(H.wave); H.an.getByteFrequencyData(H.freq);
  let peak = 0, sum = 0;
  for (const v of H.wave) { const x = (v - 128) / 128; peak = Math.max(peak, Math.abs(x)); sum += x * x; }
  const rms = Math.sqrt(sum / H.wave.length), db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(0) : '-∞');
  H.lvl = Math.min(1, rms * 4 * S.sens);
  $('level').style.width = H.lvl * 100 + '%';
  $('rms').textContent = `RMS ${db(rms)} dB`; $('peak').textContent = `Peak ${db(peak)} dB`;
  if (peak >= 0.99) H.clipUntil = t + 1500;
  $('clip').hidden = t > H.clipUntil;
  $('micState').textContent = H.stream.getAudioTracks()[0].readyState === 'live' && !H.muted ? 'MIC ACTIVE' : 'MIC MUTED';
  const cv = $('vizCanvas'), g = cv.getContext('2d'), w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h);
  const c = `hsl(${190 + H.lvl * 120},100%,65%)`;
  g.strokeStyle = g.fillStyle = g.shadowColor = c; g.shadowBlur = S.glow; g.lineWidth = 2;
  (VIZ[S.viz] || VIZ.bars)(g, w, h);
}
async function restartMic() {
  try {
    const s = await acquireMic();
    H.src.disconnect(); H.stream.getTracks().forEach((t) => t.stop());
    H.stream = s; H.src = H.ctx.createMediaStreamSource(s); H.src.connect(H.gain);
    toast('Microphone restarted', 'ok');
  } catch (e) { toast(micError(e), 'err'); }
}
async function fillMics() {
  try {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const sel = $('mic'); sel.textContent = '';
    list.forEach((d, i) => sel.append(new Option(d.label || 'Microphone ' + (i + 1), d.deviceId)));
    sel.value = S.mic || H.stream.getAudioTracks()[0].getSettings().deviceId || '';
  } catch { /* labels unavailable */ }
}
$('btnHost').onclick = startHost;
$('mute').onclick = () => { H.muted = !H.muted; H.dest.stream.getAudioTracks()[0].enabled = !H.muted; $('mute').textContent = H.muted ? 'Unmute mic' : 'Mute mic'; };
$('lock').onclick = () => { H.locked = !H.locked; $('lock').textContent = H.locked ? 'Unlock room' : 'Lock room'; $('roomStatus').textContent = H.locked ? 'LOCKED' : 'OPEN'; sendConfig(); };
$('kickAll').onclick = () => { send(H.ws, { type: 'kick-all' }); H.peers.forEach((p) => p.pc && p.pc.close()); H.peers.clear(); renderPeers(); };
$('end').onclick = stopHost;
$('regen').onclick = regen;
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(H.code); toast('Room code copied', 'ok'); } catch { toast('Copy failed. Select the code manually.', 'err'); } };
$('share').onclick = async () => {
  if (!navigator.share) return $('copy').click();
  try { await navigator.share({ text: `Join my EchoLink Live Microphone\n\nRoom Code: ${H.code}` }); } catch { /* cancelled */ }
};

/* ---------------- RECEIVER ---------------- */
const R = {};
function deviceInfo() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return { name: $('devName').value.trim() || `${os} ${browser}`, os, browser, deviceId: devId };
}
const rstat = (t) => { R.msg = t; $('rstatus').textContent = t; };
function joinRoom() {
  const code = $('joinCode').value.replace(/\D/g, '');
  if (code.length !== 6) return toast('Enter the 6-digit room code.', 'err');
  if (!window.RTCPeerConnection) return toast('This browser does not support WebRTC.', 'err');
  Object.assign(R, { code, tries: 0, final: false, msg: '' });
  show('recv'); $('tap').hidden = true; connectRecv();
  R.stat = setInterval(recvStats, 2000);
}
function connectRecv() { // also used for automatic reconnects (trusted devices skip re-approval)
  rstat(R.tries ? 'Connection interrupted. Reconnecting…' : 'Connecting to room…');
  closePc();
  const ws = R.ws = openWs(R.code, 'recv', onRecvMsg, () => {
    if (R.ws !== ws) return;
    R.ws = null; closePc();
    if (!R.final && R.tries < 5) { const wait = 1000 * 2 ** R.tries++; rstat(`Connection interrupted. Reconnecting in ${wait / 1000}s…`); R.timer = setTimeout(connectRecv, wait); }
    else rstat(R.msg || 'Disconnected from the host.');
  });
  ws.onopen = () => send(ws, { type: 'join', info: deviceInfo() });
}
function closePc() { if (R.pc) { R.pc.close(); R.pc = null; } R.pending = []; $('audio').srcObject = null; }
const FINAL = { denied: 'Access denied. The host rejected your request.', blocked: ERR.blocked, kicked: 'The host disconnected you.', 'host-left': 'The host ended the session.' };
function onRecvMsg(m) {
  if (FINAL[m.type]) { R.final = true; rstat(FINAL[m.type]); }
  else if (m.type === 'error') { R.final = true; rstat(ERR[m.code] || 'Room error.'); }
  else if (m.type === 'waiting') rstat('Room found. Waiting for host approval…');
  else if (m.type === 'approved') rstat('Approved. Connecting…');
  else if (m.type === 'signal') onHostSignal(m.data);
}
function newRecvPc() {
  const pc = R.pc = new RTCPeerConnection({ iceServers: ICE });
  pc.onicecandidate = (e) => { if (e.candidate) send(R.ws, { type: 'signal', data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => { $('audio').srcObject = e.streams[0] || new MediaStream([e.track]); playAudio(); };
  pc.oniceconnectionstatechange = () => { // new | checking | connected | completed | disconnected | failed | closed
    R.ice = pc.iceConnectionState;
    if (R.ice === 'failed') { rstat('Connection failed. Asking the host to retry…'); send(R.ws, { type: 'signal', data: { restart: true } }); }
    else if (R.ice === 'disconnected') rstat('Connection interrupted…');
    else if (R.ice === 'checking') rstat('Connecting…');
  };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'connected') { R.tries = 0; playAudio(); } };
  return pc;
}
async function onHostSignal(d) {
  try {
    if (d.sdp) { // offer; an ICE-restart offer reuses the existing connection (no duplicates)
      const pc = R.pc && R.pc.signalingState !== 'closed' ? R.pc : newRecvPc();
      await pc.setRemoteDescription(d.sdp);
      for (const c of R.pending) await pc.addIceCandidate(c);
      R.pending = [];
      await pc.setLocalDescription(await pc.createAnswer());
      send(R.ws, { type: 'signal', data: { sdp: pc.localDescription } });
    } else if (d.candidate) {
      if (R.pc && R.pc.remoteDescription) await R.pc.addIceCandidate(d.candidate); else R.pending.push(d.candidate);
    }
  } catch { rstat('Connection failed.'); }
}
async function playAudio() {
  try { await $('audio').play(); $('tap').hidden = true; rstat('LIVE AUDIO — CONNECTED'); }
  catch { $('tap').hidden = false; rstat('Tap to start audio'); }
}
async function recvStats() {
  if (!R.pc || R.pc.connectionState !== 'connected') return;
  try {
    const r = await R.pc.getStats(); let bytes = 0, rtt = null, lost = 0, jit = 0;
    r.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') { bytes = s.bytesReceived; lost = s.packetsLost; jit = Math.round((s.jitter || 0) * 1000); }
      if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null) rtt = Math.round(s.currentRoundTripTime * 1000);
    });
    const kbps = R.bytes != null ? Math.round(((bytes - R.bytes) * 8) / 2000) : 0; R.bytes = bytes;
    $('rdiag').textContent = `ICE ${R.ice} • ${kbps} kbps • RTT ${rtt ?? '?'} ms • jitter ${jit} ms • lost ${lost}`;
  } catch { /* closed mid-poll */ }
}
function leave() {
  R.final = true; clearTimeout(R.timer); clearInterval(R.stat);
  const ws = R.ws; R.ws = null; if (ws) ws.close();
  closePc(); show('home');
}
$('btnJoin').onclick = () => show('join');
$('backJoin').onclick = () => show('home');
$('doJoin').onclick = joinRoom;
$('tap').onclick = playAudio;
$('vol').oninput = () => { $('audio').volume = $('vol').value; };
$('rmute').onclick = () => { const a = $('audio'); a.muted = !a.muted; $('rmute').textContent = a.muted ? 'Unmute' : 'Mute'; };
$('full').onclick = () => { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); };
$('leave').onclick = leave;

/* ---------------- SETTINGS ---------------- */
document.querySelectorAll('[data-k]').forEach((el) => {
  const k = el.dataset.k, cb = el.type === 'checkbox';
  if (k !== 'mic') { if (cb) el.checked = S[k]; else el.value = S[k]; }
  el.addEventListener('input', () => {
    S[k] = cb ? el.checked : typeof DEF[k] === 'number' ? Number(el.value) : el.value;
    save(); applyLook();
    if (k === 'norm' && H.comp) setNorm();
    if (k === 'gain' && H.gain) H.gain.gain.value = S.gain;
    if (k === 'bitrate') H.peers.forEach((p) => p.sender && applyBitrate(p));
    if ((k === 'approval' || k === 'max') && H.ws) sendConfig();
    if (['mic', 'echo', 'noise', 'agc'].includes(k) && H.stream) restartMic();
  });
});
['openSettings', 'openSettings2'].forEach((id) => { $(id).onclick = () => $('settings').showModal(); });
$('closeSettings').onclick = () => $('settings').close();

applyLook();
const splash = $('splash');
setTimeout(() => splash.remove(), 2900);
splash.addEventListener('click', () => splash.remove());
window.addEventListener('pagehide', () => { if (H.code) stopHost(); if (R.ws) leave(); });

// Remote-friendly navigation: arrow keys move focus (sliders/inputs keep their own arrow behavior).
document.addEventListener('keydown', (e) => {
  const k = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (!k || e.target.matches('input[type=range],select,input[type=number],input[type=text]')) return;
  const root = $('settings').open ? $('settings') : document;
  const f = [...root.querySelectorAll('button,input,select')].filter((x) => x.offsetParent && !x.disabled);
  if (!f.length) return;
  f[(f.indexOf(document.activeElement) + k + f.length) % f.length].focus(); e.preventDefault();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}); // offline shell only
