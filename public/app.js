'use strict';
const $ = (id) => document.getElementById(id);
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }]; // add TURN servers here for restrictive networks
const DEF = { layout: 'glass', theme: 'dark', echo: true, noise: true, agc: true, gain: 1, bitrate: 64000, mic: '', approval: true, max: 10, viz: 'bars', sens: 1.5, tv: false };
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
  // Mic -> gain (software gain) -> analyser (visualizer) + destination (stream sent to peers)
  H.ctx = new AudioContext();
  H.gain = H.ctx.createGain(); H.gain.gain.value = S.gain;
  H.an = H.ctx.createAnalyser(); H.an.fftSize = 2048;
  H.dest = H.ctx.createMediaStreamDestination();
  H.wave = new Uint8Array(H.an.fftSize); H.freq = new Uint8Array(H.an.frequencyBinCount);
  H.gain.connect(H.an); H.gain.connect(H.dest);
  H.src = H.ctx.createMediaStreamSource(H.stream); H.src.connect(H.gain);
  let code;
  try { code = (await (await fetch('/api/code')).json()).code; } catch { /* handled below */ }
  if (!code) { stopHost(); return toast('Could not create a room. Check your connection.', 'err'); }
  H.code = code; H.muted = false; H.locked = false;
  $('mute').textContent = 'Mute mic'; $('lock').textContent = 'Lock room';
  H.ws = openWs(code, 'host', onHostMsg, () => { if (H.code) { toast('Signaling disconnected. Session ended.', 'err'); stopHost(); } });
  H.ws.onopen = sendConfig;
  $('roomCode').textContent = code.replace(/(\d{3})(\d{3})/, '$1 $2');
  show('host'); renderPeers(); draw(); H.stat = setInterval(pollStats, 2000); fillMics();
}
function stopHost() {
  const ws = H.ws; H.code = null; H.ws = null; if (ws) ws.close();
  clearInterval(H.stat); cancelAnimationFrame(H.raf);
  H.peers.forEach((p) => p.pc && p.pc.close()); H.peers.clear();
  if (H.stream) H.stream.getTracks().forEach((t) => t.stop());
  if (H.ctx) H.ctx.close();
  H.stream = H.ctx = null; show('home');
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
  Object.assign(p, { info, state: 'connecting', muted: false }); H.peers.set(id, p);
  const pc = p.pc = new RTCPeerConnection({ iceServers: ICE });
  const stream = H.dest.stream;
  p.sender = pc.addTrack(stream.getAudioTracks()[0], stream);
  pc.onicecandidate = (e) => { if (e.candidate) send(H.ws, { type: 'signal', to: id, data: { candidate: e.candidate } }); };
  pc.onconnectionstatechange = () => {
    p.state = pc.connectionState;
    if (p.state === 'connected') toast(`${info.name} connected`, 'ok');
    if (p.state === 'failed') toast(`${info.name}: connection failed`, 'err');
    renderPeers();
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    send(H.ws, { type: 'signal', to: id, data: { sdp: pc.localDescription } });
    applyBitrate(p);
  } catch { toast('Could not start a connection.', 'err'); }
  renderPeers();
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
    if (d.sdp) await p.pc.setRemoteDescription(d.sdp);
    else if (d.candidate) await p.pc.addIceCandidate(d.candidate);
  } catch { /* stale candidate */ }
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
      (p.rtt != null ? ` • ${p.rtt} ms` : '') + (p.kbps ? ` • ${p.kbps} kbps` : '');
    li.append(name, meta);
    const acts = p.state === 'pending' ? [['allow', 'Allow'], ['deny', 'Deny'], ['block', 'Block']]
      : [['mute', p.muted ? 'Unmute' : 'Mute'], ['kick', 'Disconnect'], ['block', 'Block']];
    acts.forEach(([a, l]) => { const b = document.createElement('button'); b.textContent = l; b.dataset.act = a; b.dataset.id = id; li.append(b); });
    list.append(li);
  });
  $('statDevices').textContent = connected; $('statPending').textContent = pending;
}
$('peers').onclick = (e) => { const b = e.target.closest('button'); if (b) peerAction(b.dataset.act, b.dataset.id); };

async function pollStats() {
  for (const p of H.peers.values()) {
    if (!p.pc || p.pc.connectionState !== 'connected') continue;
    try {
      const r = await p.pc.getStats(); let bytes = 0;
      r.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null) p.rtt = Math.round(s.currentRoundTripTime * 1000);
        if (s.type === 'outbound-rtp') bytes = s.bytesSent;
      });
      if (p.bytes != null) p.kbps = Math.round(((bytes - p.bytes) * 8) / 2000);
      p.bytes = bytes;
    } catch { /* peer closed mid-poll */ }
  }
  renderPeers();
}
// Visualizer reads the real analyser data; silence produces a flat line / empty bars.
function draw() {
  H.raf = requestAnimationFrame(draw);
  const cv = $('vizCanvas'), g = cv.getContext('2d'), w = cv.width, h = cv.height;
  H.an.getByteTimeDomainData(H.wave); H.an.getByteFrequencyData(H.freq);
  let peak = 0; for (const v of H.wave) peak = Math.max(peak, Math.abs(v - 128));
  $('level').style.width = Math.min(100, (peak / 128) * 100 * S.sens) + '%';
  const live = H.stream.getAudioTracks()[0].readyState === 'live' && !H.muted;
  $('micState').textContent = live ? 'MIC ACTIVE' : 'MIC MUTED';
  g.clearRect(0, 0, w, h); g.fillStyle = g.strokeStyle = '#5ee1ff';
  if (S.viz === 'wave') {
    g.beginPath();
    H.wave.forEach((v, i) => { const x = (i / H.wave.length) * w, y = h / 2 + ((v - 128) / 128) * (h / 2) * S.sens; i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.lineWidth = 2; g.stroke();
  } else {
    const n = 48, step = Math.floor(H.freq.length / 2 / n);
    for (let i = 0; i < n; i++) { const bh = Math.min(h, (H.freq[i * step] / 255) * h * S.sens); g.fillRect(i * (w / n) + 1, h - bh, w / n - 2, bh); }
  }
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
$('lock').onclick = () => { H.locked = !H.locked; $('lock').textContent = H.locked ? 'Unlock room' : 'Lock room'; sendConfig(); };
$('kickAll').onclick = () => { send(H.ws, { type: 'kick-all' }); H.peers.forEach((p) => p.pc && p.pc.close()); H.peers.clear(); renderPeers(); };
$('end').onclick = stopHost;
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
  R.msg = ''; $('tap').hidden = true; rstat('Connecting to room…'); show('recv');
  R.ws = openWs(code, 'recv', onRecvMsg, () => { if (R.ws) { R.ws = null; if (R.pc) R.pc.close(); rstat(R.msg || 'Disconnected from the host.'); } });
  R.ws.onopen = () => send(R.ws, { type: 'join', info: deviceInfo() });
}
function onRecvMsg(m) {
  if (m.type === 'waiting') rstat('Room found. Waiting for host approval…');
  else if (m.type === 'approved') rstat('Approved. Connecting…');
  else if (m.type === 'denied') rstat('Access denied. The host rejected your request.');
  else if (m.type === 'blocked') rstat(ERR.blocked);
  else if (m.type === 'kicked') rstat('The host disconnected you.');
  else if (m.type === 'host-left') rstat('The host ended the session.');
  else if (m.type === 'error') rstat(ERR[m.code] || 'Room error.');
  else if (m.type === 'signal') onHostSignal(m.data);
}
async function onHostSignal(d) {
  try {
    if (d.sdp) {
      const pc = R.pc = new RTCPeerConnection({ iceServers: ICE });
      R.queue = []; // candidates that arrive before the remote description is set
      pc.onicecandidate = (e) => { if (e.candidate) send(R.ws, { type: 'signal', data: { candidate: e.candidate } }); };
      pc.ontrack = (e) => { $('audio').srcObject = e.streams[0]; playAudio(); };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') playAudio();
        else if (s === 'failed' || s === 'disconnected') rstat('Connection ' + s + '.');
      };
      await pc.setRemoteDescription(d.sdp);
      for (const c of R.queue) await pc.addIceCandidate(c);
      R.queue = null;
      await pc.setLocalDescription(await pc.createAnswer());
      send(R.ws, { type: 'signal', data: { sdp: pc.localDescription } });
    } else if (d.candidate) {
      if (R.queue) R.queue.push(d.candidate); else if (R.pc) await R.pc.addIceCandidate(d.candidate);
    }
  } catch { rstat('Connection failed.'); }
}
async function playAudio() {
  try { await $('audio').play(); $('tap').hidden = true; rstat('LIVE AUDIO — CONNECTED'); }
  catch { $('tap').hidden = false; rstat('Tap to start audio'); }
}
function leave() {
  const ws = R.ws; R.ws = null; if (ws) ws.close();
  if (R.pc) R.pc.close(); R.pc = null; $('audio').srcObject = null; show('home');
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
