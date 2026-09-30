import roomModule from './room.js';

const { Room, sha256Hex } = roomModule;

// One Durable Object instance holds the whole room, so every request is
// serialized through it and claim checks cannot race.
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
  }

  async fetch(request) {
    if (!this.room) {
      this.room = new Room(this.state.storage, this.env.ADMIN_TOKEN ? await sha256Hex(this.env.ADMIN_TOKEN) : null);
    }
    const url = new URL(request.url);
    const auth = request.headers.get('authorization') || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    let body = null;
    if (request.method === 'POST') {
      try { body = await request.json(); } catch { return json(400, { error: 'invalid JSON' }); }
    }
    const [status, payload] = await this.room.handle(request.method, url.pathname, bearer, body);
    return json(status, payload);
  }
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return json(200, { service: 'aircontrol-relay' });
    if (Number(request.headers.get('content-length') || 0) > 512 * 1024) return json(413, { error: 'too large' });
    return env.ROOM.get(env.ROOM.idFromName('room')).fetch(request);
  },
};
