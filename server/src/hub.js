/** Channel pub/sub for WebSocket clients. Each message is serialised once and sent to every subscriber. */
export class Hub {
  constructor({ maxBuffered = 2_000_000 } = {}) {
    this.subs = new Map(); // channel -> Set<ws>
    this.maxBuffered = maxBuffered;
  }

  subscribe(ws, ch) {
    let set = this.subs.get(ch);
    if (!set) this.subs.set(ch, (set = new Set()));
    set.add(ws);
    (ws.chs || (ws.chs = new Set())).add(ch);
  }

  unsubscribe(ws, ch) {
    const set = this.subs.get(ch);
    if (set) {
      set.delete(ws);
      if (!set.size) this.subs.delete(ch);
    }
    if (ws.chs) ws.chs.delete(ch);
  }

  dropAll(ws) {
    for (const ch of [...(ws.chs || [])]) this.unsubscribe(ws, ch);
  }

  count(ch) {
    const set = this.subs.get(ch);
    return set ? set.size : 0;
  }

  /** @returns number of clients the message was sent to */
  publish(ch, data) {
    const set = this.subs.get(ch);
    if (!set || !set.size) return 0;
    const msg = JSON.stringify({ t: 'doc', ch, data });
    let n = 0;
    for (const ws of [...set]) if (this.sendTo(ws, msg)) n++;
    return n;
  }

  sendTo(ws, msg) {
    try {
      // A phone on bad wifi must not slow everyone else down: drop it, it will reconnect and resync.
      if (ws.bufferedAmount > this.maxBuffered) {
        ws.terminate();
        return false;
      }
      ws.send(msg);
      return true;
    } catch {
      return false;
    }
  }
}
