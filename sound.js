/* sound.js — the show's sounds.
   Every sound is made in the browser (original, no files, works offline). Any of them can be replaced by your own
   audio file: put e.g. sounds/buzzer.mp3 on the server (see sounds/README.txt) and it is used instead.
   Used by the projector page, which is the laptop connected to the hall speakers. */
(function () {
  'use strict';
  var NAMES = ['intro', 'ding', 'buzzer', 'fanfare', 'applause', 'drumroll', 'tick', 'timeup', 'sting', 'steal', 'fastmoney', 'thinking', 'faceoff', 'buzzin'];
  var ctx = null, bus = null, files = {}, thinkTimer = null, loopSrc = null, listeners = [];
  var packFiles = {}, avail = {}, want = 'builtin', loadedIndex = false;
  var state = { vol: 0.85, mute: false, unlocked: false, files: [], pack: 'builtin' };

  function notify() { listeners.slice().forEach(function (f) { try { f(api.state()); } catch (e) { /* ignore */ } }); }

  /* ---------- plumbing: a bus with a limiter, so loud layers never clip ---------- */
  function makeBus(c, o) {
    o = o || {};
    var inp = c.createGain(), comp = c.createDynamicsCompressor(), master = c.createGain();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.2;
    master.gain.value = o.vol != null ? o.vol : (state.mute ? 0 : state.vol);
    inp.connect(comp); comp.connect(master); master.connect(c.destination);
    return { 'in': inp, master: master };
  }
  function ensure() {
    if (ctx) return ctx;
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    bus = makeBus(ctx);
    return ctx;
  }

  /* ---------- building blocks ---------- */
  var SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function hz(n) { var m = /^([A-G])(#|b)?(\d)$/.exec(n); var midi = 12 * (Number(m[3]) + 1) + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0); return 440 * Math.pow(2, (midi - 69) / 12); }
  function tone(c, out, t, freq, dur, type, gain, o) {
    o = o || {};
    var osc = c.createOscillator(), g = c.createGain(), a = o.attack || 0.006, node = g;
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + a);
    if (o.hold) g.gain.setValueAtTime(gain, t + Math.max(a, dur - (o.release || 0.06)));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    if (o.lp) { var f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; g.connect(f); node = f; }
    node.connect(out);
    osc.start(t); osc.stop(t + dur + 0.03);
  }
  function noise(c, out, t, dur, gain, o) {
    o = o || {};
    if (!c._nb) { var n = c.sampleRate * 2, b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0); for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; c._nb = b; }
    var s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = c._nb; s.loop = true;
    f.type = o.type || 'bandpass'; f.frequency.value = o.freq || 2000; f.Q.value = o.q || 0.8;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t, Math.random()); s.stop(t + dur + 0.03);
  }

  /* ---------- the sounds (all original) ---------- */
  var S = {
    /* a correct answer: bright bell */
    ding: function (c, o, t) {
      tone(c, o, t, 880, 1.4, 'sine', 0.5);
      tone(c, o, t, 1320, 1.1, 'sine', 0.28);
      tone(c, o, t, 2640, 0.7, 'sine', 0.12);
      tone(c, o, t, 1760, 0.9, 'triangle', 0.12);
    },
    /* a strike: low, harsh buzzer */
    buzzer: function (c, o, t) {
      tone(c, o, t, 110, 0.95, 'sawtooth', 0.45, { lp: 1300, hold: 1, release: 0.1 });
      tone(c, o, t, 117, 0.95, 'square', 0.22, { lp: 900, hold: 1, release: 0.1 });
      tone(c, o, t, 55, 0.95, 'sine', 0.4, { hold: 1, release: 0.1 });
    },
    /* time is up: two short blasts */
    timeup: function (c, o, t) {
      [0, 0.5].forEach(function (d) {
        tone(c, o, t + d, 130, 0.38, 'sawtooth', 0.4, { lp: 1500, hold: 1, release: 0.06 });
        tone(c, o, t + d, 65, 0.38, 'sine', 0.35, { hold: 1, release: 0.06 });
      });
    },
    /* countdown tick */
    tick: function (c, o, t) { tone(c, o, t, 1700, 0.05, 'square', 0.22, { lp: 3000 }); },
    /* round won: rising brass */
    fanfare: function (c, o, t) {
      ['C5', 'E5', 'G5', 'C6'].forEach(function (n, i) {
        var last = i === 3, d = last ? 1.5 : 0.2;
        tone(c, o, t + i * 0.15, hz(n), d, 'sawtooth', 0.22, { lp: 2400, hold: last ? 1 : 0, release: 0.2 });
        tone(c, o, t + i * 0.15, hz(n) * 2, d, 'triangle', 0.1);
      });
      tone(c, o, t + 0.45, hz('C4'), 1.4, 'triangle', 0.2);
    },
    /* a crowd clapping: lots of tiny noise bursts */
    applause: function (c, o, t) {
      var N = 220, len = 3.6;
      for (var i = 0; i < N; i++) {
        var at = Math.pow(Math.random(), 1.3) * len, env = Math.max(0.15, 1 - at / (len * 1.1)) * Math.min(1, at / 0.25 + 0.2);
        noise(c, o, t + at, 0.03 + Math.random() * 0.05, 0.1 * env, { freq: 1200 + Math.random() * 3200, q: 0.6 + Math.random() });
      }
    },
    /* drum roll into a crash */
    drumroll: function (c, o, t) {
      var len = 2.4;
      for (var x = 0; x < len; x += 0.05) noise(c, o, t + x, 0.06, 0.1 + 0.28 * (x / len), { freq: 1900, q: 0.4 });
      noise(c, o, t + len, 1.6, 0.35, { type: 'highpass', freq: 3500, q: 0.3 });
      S.ding(c, o, t + len);
    },
    /* new round / question starts */
    sting: function (c, o, t) {
      tone(c, o, t, hz('G4'), 0.2, 'sawtooth', 0.22, { lp: 2200 });
      tone(c, o, t + 0.18, hz('C5'), 0.7, 'sawtooth', 0.26, { lp: 2400, hold: 1, release: 0.25 });
      tone(c, o, t + 0.18, hz('C4'), 0.7, 'triangle', 0.22);
    },
    /* a steal is on: three falling notes */
    steal: function (c, o, t) {
      ['E5', 'C5', 'A4'].forEach(function (n, i) { tone(c, o, t + i * 0.22, hz(n), 0.3, 'square', 0.16, { lp: 1600 }); });
    },
    /* Fast Money: quick rising run */
    fastmoney: function (c, o, t) {
      var run = ['C5', 'E5', 'G5', 'B5', 'C6', 'B5', 'G5', 'E5', 'C5', 'E5', 'G5', 'C6'];
      run.forEach(function (n, i) { tone(c, o, t + i * 0.11, hz(n), 0.16, 'triangle', 0.22); });
      tone(c, o, t + 1.35, hz('C6'), 0.9, 'sawtooth', 0.2, { lp: 2400, hold: 1, release: 0.3 });
      tone(c, o, t, hz('C3'), 1.9, 'triangle', 0.2);
    },
    /* the game begins: an upbeat original jingle */
    intro: function (c, o, t) {
      var beat = 0.36;
      [[0, 'C5', 0.5], [0.5, 'E5', 0.5], [1, 'G5', 0.5], [1.5, 'E5', 0.5], [2, 'G5', 0.5], [2.5, 'C6', 1], [3.5, 'G5', 0.5],
        [4, 'A5', 0.5], [4.5, 'F5', 0.5], [5, 'A5', 0.5], [5.5, 'C6', 0.5], [6, 'G5', 2]].forEach(function (m) {
        tone(c, o, t + m[0] * beat, hz(m[1]), m[2] * beat * 1.05, 'sawtooth', 0.17, { lp: 2600, hold: m[2] > 1 ? 1 : 0, release: 0.12 });
        tone(c, o, t + m[0] * beat, hz(m[1]) / 2, m[2] * beat * 1.05, 'triangle', 0.1);
      });
      [[0, 'C3'], [2, 'C3'], [4, 'F3'], [6, 'C3']].forEach(function (b) { tone(c, o, t + b[0] * beat, hz(b[1]), 1.9 * beat, 'triangle', 0.3); });
      for (var k = 0; k < 8; k++) { noise(c, o, t + k * beat, 0.09, 0.12, { freq: 5000, q: 0.5 }); tone(c, o, t + k * beat, 90, 0.12, 'sine', 0.3, { to: 45 }); }
      noise(c, o, t + 8 * beat, 1.4, 0.2, { type: 'highpass', freq: 3500, q: 0.3 });
    },
    /* face-off: the buzzers are open — a quick two-note "ready!" */
    faceoff: function (c, o, t) {
      tone(c, o, t, hz('E5'), 0.14, 'square', 0.16, { lp: 2600 });
      tone(c, o, t + 0.16, hz('A5'), 0.34, 'square', 0.18, { lp: 2800, release: 0.15 });
      tone(c, o, t + 0.16, hz('A4'), 0.34, 'triangle', 0.16);
    },
    /* a team buzzed in: a sharp, loud buzz-in with a bell on top */
    buzzin: function (c, o, t) {
      tone(c, o, t, hz('A3'), 0.32, 'sawtooth', 0.3, { lp: 1800 });
      tone(c, o, t, hz('A3') * 1.5, 0.32, 'square', 0.14, { lp: 1800 });
      noise(c, o, t, 0.05, 0.25, { freq: 3000, q: 0.8 });
      tone(c, o, t + 0.2, hz('E6'), 0.7, 'sine', 0.22, { release: 0.4 });
      tone(c, o, t + 0.2, hz('E7'), 0.5, 'sine', 0.08, { release: 0.3 });
    },
    /* soft "thinking" music: one 4-second pattern (repeated while it plays) */
    thinking: function (c, o, t) {
      var b = 0.5, ar = ['C4', 'G4', 'E4', 'G4', 'A3', 'E4', 'C4', 'E4'];
      ar.forEach(function (n, i) { tone(c, o, t + i * b, hz(n), 0.55, 'triangle', 0.12); });
      for (var i = 0; i < 8; i += 2) tone(c, o, t + i * b, 70, 0.28, 'sine', 0.28, { to: 45 });
    }
  };

  /* ---------- public ---------- */
  var api = {
    NAMES: NAMES,
    /** call from a click/keypress: browsers keep the page silent until the person has interacted with it once */
    unlock: function () {
      var c = ensure();
      if (!c) return 'unsupported';
      var sync = function () { var on = c.state === 'running'; if (on !== state.unlocked) { state.unlocked = on; notify(); } };
      try {
        c.onstatechange = sync;
        if (c.state !== 'running') { var p = c.resume(); if (p && p.then) p.then(sync, sync); }
        var b = c.createBuffer(1, 1, 22050), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0);
      } catch (e) { /* ignore */ }
      sync();
      return c.state;
    },
    play: function (name) {
      var c = ensure();
      if (!c || !state.unlocked) return false;
      if (c.state !== 'running') { try { c.resume(); } catch (e) { /* ignore */ } }
      var t = c.currentTime + 0.03;
      if (name === 'thinking') { api.stop(); loop(); return true; }
      var buf = pick(name);
      if (buf) { playFile(c, buf, false); return true; }
      if (S[name]) { S[name](c, bus['in'], t); return true; }
      return false;
    },
    /** silence everything that is playing right now, including looped music */
    stop: function () {
      clearInterval(thinkTimer); thinkTimer = null;
      if (loopSrc) { try { loopSrc.stop(); } catch (e) { /* ignore */ } loopSrc = null; }
      if (!ctx) return;
      var old = bus; bus = makeBus(ctx);
      old.master.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
      setTimeout(function () { try { old.master.disconnect(); } catch (e) { /* ignore */ } }, 400);
    },
    setVolume: function (v) { state.vol = Math.min(1, Math.max(0, Number(v) || 0)); if (bus) bus.master.gain.value = state.mute ? 0 : state.vol; notify(); },
    setMuted: function (m) { state.mute = !!m; if (bus) bus.master.gain.value = state.mute ? 0 : state.vol; notify(); },
    state: function () { return { vol: state.vol, mute: state.mute, unlocked: state.unlocked, files: state.files.slice(), pack: state.pack, packFiles: Object.keys(packFiles[state.pack] || {}), packs: Object.keys(avail) }; },
    /** choose a sound set: 'builtin' (the default) or a folder under sounds/ such as 'classic'. Names missing from a set fall back to the built-in sound. */
    setPack: function (name) {
      want = name || 'builtin';
      if (want === 'builtin') { state.pack = 'builtin'; notify(); return Promise.resolve(); }
      if (!loadedIndex) return Promise.resolve();   // applied as soon as the file list is known (after the sound is switched on)
      return loadPack(want);
    },
    onState: function (f) { listeners.push(f); },
    /** use the server's own files (sounds/<name>.mp3 etc.) in place of the built-in version, when they exist */
    loadFiles: function (base) {
      base = base || 'sounds/';
      api._base = base;
      return fetch(base + 'index.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : { files: [] }; }).catch(function () { return { files: [] }; }).then(function (idx) {
        var c = ensure(); if (!c) return [];
        avail = idx.packs || {}; loadedIndex = true;
        var jobs = (idx.files || []).filter(function (f) { return NAMES.indexOf(f.replace(/\.[^.]+$/, '')) >= 0; }).map(function (f) {
          var name = f.replace(/\.[^.]+$/, '');
          return fetch(base + f).then(function (r) { return r.arrayBuffer(); }).then(function (ab) {
            return new Promise(function (res, rej) { c.decodeAudioData(ab, res, rej); });
          }).then(function (buf) { files[name] = buf; return name; }).catch(function () { return null; });
        });
        return Promise.all(jobs).then(function (done) { state.files = done.filter(Boolean); notify(); return want !== 'builtin' ? loadPack(want).then(function () { return state.files; }) : state.files; });
      });
    },
    /** for tests and for previewing: render a built-in sound offline and return its samples */
    _render: function (name, seconds, sampleRate) {
      var sr = sampleRate || 44100, oc = new OfflineAudioContext(1, Math.ceil(sr * seconds), sr), b = makeBus(oc, { vol: 1 });
      S[name](oc, b['in'], 0.02);
      return oc.startRendering().then(function (buf) { return Array.prototype.slice.call(buf.getChannelData(0)); });
    }
  };

  /** the file to use for a sound: the chosen set's file, else your own replacement file, else null (built-in) */
  function pick(name) { var p = state.pack !== 'builtin' && packFiles[state.pack]; return (p && p[name]) || files[name] || null; }
  function loadPack(name) {
    var c = ensure(); if (!c) return Promise.resolve();
    var list = (avail[name] || []).filter(function (f) { return NAMES.indexOf(f.replace(/\.[^.]+$/, '')) >= 0; }), got = {};
    return Promise.all(list.map(function (f) {
      return fetch((api._base || 'sounds/') + name + '/' + f).then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) { return new Promise(function (res, rej) { c.decodeAudioData(ab, res, rej); }); })
        .then(function (buf) { got[f.replace(/\.[^.]+$/, '')] = buf; }).catch(function () { /* skip a file that will not decode */ });
    })).then(function () { if (want === name) { packFiles[name] = got; state.pack = name; notify(); } });
  }
  function playFile(c, buf, loopIt) {
    var s = c.createBufferSource(); s.buffer = buf; s.loop = !!loopIt; s.connect(bus['in']); s.start();
    if (loopIt) loopSrc = s;
  }
  function loop() {
    var c = ctx;
    var tb = pick('thinking');
    if (tb) { playFile(c, tb, true); return; }
    var run = function () { S.thinking(c, bus['in'], c.currentTime + 0.05); };
    run(); thinkTimer = setInterval(run, 3950);
  }

  window.Sound = api;
})();
