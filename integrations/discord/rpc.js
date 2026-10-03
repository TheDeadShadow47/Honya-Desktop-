// Minimal Discord Rich Presence IPC client (no dependency). Speaks Discord's local RPC framing:
// [int32 opcode][int32 length][utf8 JSON], over a named pipe (Windows) or unix socket (macOS/Linux).
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

export function ipcPaths(platform = process.platform, env = process.env) {
  const paths = [];
  for (let i = 0; i < 10; i++) {
    if (platform === 'win32') {
      paths.push(`\\\\?\\pipe\\discord-ipc-${i}`);
      continue;
    }
    const base = (env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp').replace(/\/$/, '');
    paths.push(`${base}/discord-ipc-${i}`);
    if (platform === 'linux') {
      paths.push(`${base}/app/com.discordapp.Discord/discord-ipc-${i}`, `${base}/snap.discord/discord-ipc-${i}`);
    }
  }
  return paths;
}

const encode = (op, payload) => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

const tryConnect = (path) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });

export class DiscordRpc extends EventEmitter {
  constructor({ paths = ipcPaths(), timeoutMs = 5000 } = {}) {
    super();
    this.paths = paths;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.ready = false;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }

  get connected() {
    return this.ready && !!this.socket;
  }

  async connect(clientId) {
    if (this.connected) return;
    let socket = null;
    for (const p of this.paths) {
      try {
        socket = await tryConnect(p);
        break;
      } catch {}
    }
    if (!socket) throw new Error('Discord is not running');
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on('data', (d) => this.#onData(d));
    socket.on('error', () => {}); // surfaced through 'close'
    socket.on('close', () => this.#teardown());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Discord handshake timed out')), this.timeoutMs);
      this.once('ready', () => (clearTimeout(timer), resolve()));
      this.once('close', (why) => (clearTimeout(timer), reject(new Error(why || 'Discord closed the connection'))));
      socket.write(encode(OP.HANDSHAKE, { v: 1, client_id: clientId }));
    }).catch((e) => {
      this.close();
      throw e;
    });
  }

  /** activity = object to show, or null to clear. Resolves once Discord acknowledges. */
  setActivity(activity) {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (this.pending.delete(nonce), reject(new Error('Discord did not respond'))), this.timeoutMs);
      this.pending.set(nonce, { resolve, reject, timer });
      this.socket.write(
        encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: activity ?? undefined }, nonce }),
      );
    });
  }

  close() {
    const s = this.socket;
    if (s) {
      try {
        if (this.ready) s.write(encode(OP.CLOSE, {}));
        s.end();
        s.destroy();
      } catch {}
    }
    this.#teardown();
  }

  #teardown(why) {
    const wasOpen = !!this.socket;
    this.socket = null;
    this.ready = false;
    for (const [, p] of this.pending) (clearTimeout(p.timer), p.reject(new Error('Connection closed')));
    this.pending.clear();
    if (wasOpen) this.emit('close', why);
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (len < 0 || len > 1 << 20) return this.close(); // corrupt stream
      if (this.buffer.length < 8 + len) return;
      let msg = {};
      try {
        msg = JSON.parse(this.buffer.subarray(8, 8 + len).toString('utf8'));
      } catch {}
      this.buffer = this.buffer.subarray(8 + len);
      if (op === OP.PING) this.socket?.write(encode(OP.PONG, msg));
      else if (op === OP.CLOSE) return this.#teardown(msg?.message || `Discord closed the connection (${msg?.code ?? '?'})`);
      else if (op === OP.FRAME) this.#onFrame(msg);
    }
  }

  #onFrame(msg) {
    if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
      this.ready = true;
      this.emit('ready');
      return;
    }
    const p = msg.nonce ? this.pending.get(msg.nonce) : null;
    if (!p) return;
    this.pending.delete(msg.nonce);
    clearTimeout(p.timer);
    if (msg.evt === 'ERROR') p.reject(new Error(msg.data?.message || 'Discord rejected the activity'));
    else p.resolve(msg.data);
  }
}
