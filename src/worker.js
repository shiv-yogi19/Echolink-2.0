// EchoLink signaling: Worker routes requests, one Durable Object per room.
// Only JSON signaling passes through here. Audio never touches the server.
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/code') {
      for (let i = 0; i < 10; i++) {
        const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
        const res = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch('https://room/status');
        if (!(await res.json()).active) return Response.json({ code });
      }
      return Response.json({ error: 'busy' }, { status: 503 });
    }
    const m = url.pathname.match(/^\/ws\/(\d{6})$/);
    if (m && req.headers.get('Upgrade') === 'websocket') {
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

export class Room {
  constructor() {
    this.host = null;
    this.peers = new Map(); // id -> {ws, info, deviceId, status: 'pending'|'approved'}
    this.blocked = new Set(); // blocked deviceIds, lives as long as the host session
    this.cfg = { approval: true, locked: false, max: 10 };
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/status') return Response.json({ active: !!this.host });
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    if (url.searchParams.get('role') === 'host') {
      if (this.host) { this.out(ws, { type: 'error', code: 'taken' }); ws.close(1000); }
      else this.attachHost(ws);
    } else if (!this.host) {
      this.out(ws, { type: 'error', code: 'not-found' });
      ws.close(1000);
    } else this.attachPeer(ws);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  out(ws, o) { try { ws && ws.send(JSON.stringify(o)); } catch { /* socket gone */ } }

  attachHost(ws) {
    this.host = ws;
    this.cfg = { approval: true, locked: false, max: 10 };
    ws.addEventListener('message', (e) => this.onHost(parse(e.data)));
    ws.addEventListener('close', () => {
      if (this.host !== ws) return;
      this.host = null; // room is now inactive; state is cleaned up
      this.peers.forEach((p) => { this.out(p.ws, { type: 'host-left' }); p.ws.close(1000); });
      this.peers.clear();
      this.blocked.clear();
    });
  }

  onHost(m) {
    if (!m) return;
    const p = this.peers.get(m.id);
    switch (m.type) {
      case 'config':
        this.cfg = { approval: m.approval !== false, locked: !!m.locked, max: Math.min(50, Math.max(1, (m.max | 0) || 10)) };
        break;
      case 'approve': if (p && p.status === 'pending') this.approve(m.id); break;
      case 'deny': case 'kick': case 'block':
        if (!p) break;
        if (m.type === 'block') this.blocked.add(p.deviceId);
        this.out(p.ws, { type: m.type === 'deny' ? 'denied' : m.type === 'block' ? 'blocked' : 'kicked' });
        p.ws.close(1000);
        this.peers.delete(m.id);
        break;
      case 'kick-all':
        this.peers.forEach((q) => { this.out(q.ws, { type: 'kicked' }); q.ws.close(1000); });
        this.peers.clear();
        break;
      case 'signal': if (p && p.status === 'approved') this.out(p.ws, { type: 'signal', data: m.data }); break;
    }
  }

  approve(id) {
    const p = this.peers.get(id);
    p.status = 'approved';
    this.out(p.ws, { type: 'approved' });
    this.out(this.host, { type: 'approved', id, info: p.info });
  }

  attachPeer(ws) {
    const id = crypto.randomUUID().slice(0, 8);
    let peer = null;
    const fail = (code) => { this.out(ws, { type: 'error', code }); ws.close(1000); };
    ws.addEventListener('message', (e) => {
      const m = parse(e.data);
      if (!m) return;
      if (m.type === 'join' && !peer) {
        const i = m.info || {};
        const deviceId = String(i.deviceId || '').slice(0, 64);
        const info = { name: String(i.name || 'Device').slice(0, 40), os: String(i.os || '').slice(0, 20), browser: String(i.browser || '').slice(0, 20) };
        if (this.blocked.has(deviceId)) return fail('blocked');
        if (this.cfg.locked) return fail('locked');
        if (this.peers.size >= this.cfg.max) return fail('full');
        peer = { ws, info, deviceId, status: 'pending' };
        this.peers.set(id, peer);
        if (this.cfg.approval) { this.out(ws, { type: 'waiting' }); this.out(this.host, { type: 'request', id, info }); }
        else this.approve(id);
      } else if (m.type === 'signal' && peer && peer.status === 'approved') {
        this.out(this.host, { type: 'signal', from: id, data: m.data });
      }
    });
    ws.addEventListener('close', () => {
      if (peer && this.peers.get(id) === peer) { this.peers.delete(id); this.out(this.host, { type: 'left', id }); }
    });
  }
}
