/* server-client.js — talks to the self-hosted game server (same origin).
   Used by index / play / display / emcee when window.BACKEND === 'server'.
   - post()/rpc(): JSON calls over HTTPS
   - subscribe(): live documents over one WebSocket, with automatic reconnect + resubscribe
   - onStatus(): 'online' | 'degraded' | 'offline' so every screen can show a sync indicator
   - auth: personal login links (no Google), 30-day session cookie */
(function () {
  'use strict';
  var wsState = 'connecting', httpOk = true, statusCbs = [];
  function status() { return wsState === 'online' ? (httpOk ? 'online' : 'degraded') : 'offline'; }
  function emit() { var s = status(); statusCbs.slice().forEach(function (cb) { try { cb(s); } catch (e) { console.error(e); } }); }
  function onStatus(cb) { statusCbs.push(cb); try { cb(status()); } catch (e) { console.error(e); } }

  var authCb = null, meUser = null, authError = '', mailOn = false;

  async function post(path, body) {
    var r;
    try {
      r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    } catch (e) {
      if (httpOk) { httpOk = false; emit(); }
      var ne = new Error('Network problem'); ne.code = 'network'; throw ne;
    }
    var up = r.status < 502;
    if (up !== httpOk) { httpOk = up; emit(); }
    var j = null; try { j = await r.json(); } catch (e) { /* not JSON (proxy error page) */ }
    if (!r.ok) {
      var err = new Error((j && j.error) || ('HTTP ' + r.status));
      err.status = r.status; err.code = (j && j.code) || ('http_' + r.status);
      if (r.status === 401 && authCb && meUser && path === '/api/rpc') { meUser = null; authError = 'Your session ended. Please sign in again.'; authCb(null); }
      throw err;
    }
    return j || {};
  }
  function rpc(m) {
    var a = Array.prototype.slice.call(arguments, 1);
    return post('/api/rpc', { m: m, a: a }).then(function (j) { return j.r; });
  }

  /* ---------- realtime ---------- */
  var helloMsg = null, ws = null, subs = {}, meta = {}, last = {}, tries = 0, reconnectT = null, hbT = null, pongT = null, closed = false;
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function stopHb() { clearInterval(hbT); clearTimeout(pongT); }
  function startHb() {
    stopHb();
    hbT = setInterval(function () {
      send({ t: 'ping' });
      clearTimeout(pongT);
      pongT = setTimeout(function () { try { ws.close(); } catch (e) { /* already closed */ } }, 10000); // half-open connection
    }, 20000);
  }
  function schedule() {
    if (closed) return;
    clearTimeout(reconnectT);
    var d = Math.min(10000, 500 * Math.pow(2, tries++)) * (0.5 + Math.random()); // jitter: 400 phones must not reconnect in the same instant
    reconnectT = setTimeout(connect, d);
  }
  function connect() {
    if (closed) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    var mine;
    try { mine = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch (e) { schedule(); return; }
    mine.onopen = function () {
      tries = 0; wsState = 'online'; emit(); startHb();
      Object.keys(subs).forEach(function (ch) { send({ t: 'sub', ch: ch, screen: !!meta[ch] }); });
      if (helloMsg) send(helloMsg);
    };
    mine.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'doc') {
        last[m.ch] = { v: m.data };
        (subs[m.ch] || []).slice().forEach(function (cb) { try { cb(m.data); } catch (e) { console.error(e); } });
      } else if (m.t === 'pong') clearTimeout(pongT);
    };
    mine.onclose = function () { if (ws === mine) { wsState = 'offline'; stopHb(); emit(); schedule(); } };
    mine.onerror = function () { try { mine.close(); } catch (e) { /* ignore */ } };
  }
  /** tell the server who this screen is (projector / emcee / tech) so the tech can see who is connected */
  function hello(code, role) { helloMsg = { t: 'hello', code: code, role: role }; connect(); send(helloMsg); }
  function subscribe(ch, cb, opts) {
    if (opts && opts.screen) meta[ch] = true;
    (subs[ch] = subs[ch] || []).push(cb);
    if (last[ch]) { var v = last[ch].v; setTimeout(function () { cb(v); }, 0); }
    connect();
    if (subs[ch].length === 1) send({ t: 'sub', ch: ch, screen: !!meta[ch] });
    return function unsubscribe() {
      subs[ch] = (subs[ch] || []).filter(function (x) { return x !== cb; });
      if (!subs[ch].length) { delete subs[ch]; delete last[ch]; delete meta[ch]; send({ t: 'unsub', ch: ch }); }
    };
  }
  /** Stop reconnecting and close the socket (used by tests and when a page is torn down). */
  function close() {
    closed = true; clearTimeout(reconnectT); stopHb();
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && wsState !== 'online') { tries = 0; connect(); } });
  window.addEventListener('online', function () { tries = 0; connect(); });

  /* ---------- auth: personal login links ---------- */
  function parseLogin(v) {
    v = String(v || '').trim();
    var m = v.match(/[?&]login=([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{20,}$/.test(v) ? v : '';
  }
  function asUser(u) { return u ? { email: u.id, name: u.name || u.id, uid: u.id, role: u.role } : null; }
  async function me() {
    try { var j = await post('/api/auth/me'); meUser = j.user || null; mailOn = !!j.mailEnabled; } catch (e) { meUser = null; }
    return meUser;
  }
  async function redeem(v) {
    var t = parseLogin(v);
    if (!t) throw new Error('That does not look like a login link.');
    meUser = (await post('/api/auth/redeem', { token: t })).user;
    authError = '';
    return meUser;
  }
  /** Call once at startup. Redeems ?login=... from the URL if present, then reports the signed-in user (or null). */
  async function authInit(cb) {
    authCb = cb; authError = '';
    var p = new URLSearchParams(location.search), t = p.get('login');
    if (t) {
      try { await redeem(t); } catch (e) { authError = e.message; }
      try { p.delete('login'); var q = p.toString(); history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash); } catch (e) { /* ignore */ }
      if (!meUser) await me();   // sign-in failed: still learn whether email sign-in is available
    } else await me();
    cb(asUser(meUser));
  }
  async function signIn(v) {
    try { await redeem(v); } catch (e) { authError = e.message; throw e; }
    if (authCb) authCb(asUser(meUser));
  }
  /** Ask the server to email a sign-in link. Always succeeds from the caller's view (no account enumeration). */
  async function requestLink(email) { await post('/api/auth/request-link', { email: email }); }
  async function signOut() {
    try { await post('/api/auth/logout'); } catch (e) { /* ignore */ }
    meUser = null;
    if (authCb) authCb(null);
  }

  window.SrvClient = {
    post: post, rpc: rpc, subscribe: subscribe, hello: hello, connect: connect, close: close, onStatus: onStatus, status: status,
    authInit: authInit, signIn: signIn, requestLink: requestLink, mailEnabled: function () { return mailOn; }, signOut: signOut, parseLogin: parseLogin,
    me: function () { return meUser; }, authError: function () { return authError; }
  };
})();
