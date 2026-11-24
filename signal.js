// ToyOut signal generation (SPECIFICATION.md §4, §10), without any DOM code,
// so the page and Node test scripts share it. The defaults are the settings
// verified on hardware in stages 3 and 5: overlay, 17 kHz low-pass on the
// speech, header/symbol 80/50 ms, the command repeated every 1000 ms, signal
// −6 dBFS, speech peak −3 dBFS.
(function (root) {
  'use strict';

  const SYMBOL_HZ = [18500, 18750, 19000, 19250, 19500];
  const CH_SEQ = { 1: [0, 1, 2, 1], 2: [0, 1, 4, 3], 3: [0, 3, 2, 3], 4: [0, 3, 4, 1] };
  const PILOT_STEP_S = 0.050;
  const RAMP_S = 0.010;
  const WAV_SAMPLE_RATE = 48000;
  const LPF_CUTOFF_HZ = 16875; // passband to ~16.5 kHz, ≥70 dB down from ~17.2 kHz
  const LPF_TAPS = 301;
  const LPF_BETA = 6.8;

  const DEFAULTS = {
    headerMs: 80, symbolMs: 50, repeatMs: 1000,
    levelDb: -6, speechPeakDb: -3, lpf: true, trim: true, compress: true,
  };

  // Speech dynamics (compress): a voice's peaks sit ~18 dB above its average,
  // so peak normalisation alone leaves it quiet. A slow compressor evens out
  // loud and soft syllables, then a look-ahead limiter shaves the short peaks.
  const COMP_WIN_S = 0.020;      // level detector: RMS over 20 ms, centred
  const COMP_BELOW_DB = 18;      // threshold: this far below the loud (95th percentile) level
  const COMP_RATIO = 5;
  const COMP_ATTACK_S = 0.005;
  const COMP_RELEASE_S = 0.080;
  const LIMIT_CREST_DB = 7;     // limiter ceiling above the loud level
  const LIMIT_WIN_S = 0.0015;
  // Gate (downward expander): compression lifts room noise between and before
  // words more than the voice, so levels near the noise floor are pushed down.
  const GATE_ABOVE_NOISE_DB = 12; // threshold: this far above the noise floor (10th percentile) ...
  const GATE_MIN_BELOW_DB = 30;  // ... but at least this far below the loud level
  const GATE_MAX_BELOW_DB = 50;  // ... and at most this far
  const GATE_SLOPE = 3;          // dB of cut per dB below the threshold (1:4)
  const GATE_RANGE_DB = 20;
  const GATE_OPEN_S = 0.002;
  const GATE_CLOSE_S = 0.100;

  // Phase-continuous tones with fades only at the start and end.
  function synthSteps(steps, rate, amp) {
    const total = steps.reduce((n, s) => n + Math.round(s.dur * rate), 0);
    const out = new Float32Array(total);
    const ramp = Math.round(RAMP_S * rate);
    let phase = 0, i = 0;
    for (const s of steps) {
      const n = Math.round(s.dur * rate);
      const dphi = 2 * Math.PI * s.freq / rate;
      for (let k = 0; k < n; k++, i++) {
        out[i] = amp * Math.sin(phase);
        phase += dphi;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    for (let k = 0; k < ramp && k < total; k++) {
      const g = 0.5 - 0.5 * Math.cos(Math.PI * k / ramp);
      out[k] *= g;
      out[total - 1 - k] *= g;
    }
    return out;
  }

  // Command, then the pilot, with the command re-inserted every repeatMs from
  // the start while a whole command still fits (§4.1). Lasts `total` seconds.
  function messageSteps(ch, total, o) {
    const hdr = o.headerMs / 1000, sym = o.symbolMs / 1000, repeat = o.repeatMs / 1000;
    const cmdLen = hdr + 3 * sym;
    const cmd = CH_SEQ[ch].map((k, i) => ({ freq: SYMBOL_HZ[k], dur: i === 0 ? hdr : sym }));
    const steps = [];
    let t = 0;
    for (let r = 1; ; r++) {
      steps.push(...cmd);
      t += cmdLen;
      const next = repeat > 0 ? r * repeat : Infinity;
      const again = next >= t - 1e-9 && next + cmdLen <= total + 1e-9;
      const until = again ? next : total;
      for (let k = 0; t < until - 1e-9; t += PILOT_STEP_S, k++) {
        steps.push({ freq: SYMBOL_HZ[k % 2 ? 4 : 2], dur: Math.min(PILOT_STEP_S, until - t) });
      }
      t = until;
      if (!again) break;
    }
    return steps;
  }

  function besselI0(x) {
    let sum = 1, term = 1;
    for (let k = 1; k < 50; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < 1e-12 * sum) break; }
    return sum;
  }

  function lowpassTaps(rate) {
    const h = new Float32Array(LPF_TAPS), m = (LPF_TAPS - 1) / 2, fc = LPF_CUTOFF_HZ / rate;
    let sum = 0;
    for (let n = 0; n < LPF_TAPS; n++) {
      const x = n - m;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      h[n] = sinc * besselI0(LPF_BETA * Math.sqrt(1 - (x / m) ** 2)) / besselI0(LPF_BETA);
      sum += h[n];
    }
    for (let n = 0; n < LPF_TAPS; n++) h[n] /= sum;
    return h;
  }

  // Linear-phase FIR with the delay removed.
  function firFilter(x, h) {
    const m = (h.length - 1) / 2, out = new Float32Array(x.length);
    for (let n = 0; n < x.length; n++) {
      let acc = 0;
      const k0 = Math.max(0, n + m - (x.length - 1)), k1 = Math.min(h.length - 1, n + m);
      for (let k = k0; k <= k1; k++) acc += h[k] * x[n + m - k];
      out[n] = acc;
    }
    return out;
  }

  // Drops leading and trailing silence, keeping 50 ms. Silence is 40 dB below
  // the loudest 10 ms, or, in a noisy recording, up to 10 dB above the noise
  // floor (10th percentile), but never closer than 30 dB to the loudest.
  function trimSilence(x, rate) {
    const win = Math.round(0.010 * rate), pad = Math.round(0.050 * rate);
    const rms = [];
    for (let i = 0; i + win <= x.length; i += win) {
      let e = 0;
      for (let k = 0; k < win; k++) e += x[i + k] * x[i + k];
      rms.push(10 * Math.log10(e / win + 1e-20));
    }
    if (!rms.length) return x;
    const top = Math.max(...rms);
    const noise = [...rms].sort((a, b) => a - b)[Math.floor(rms.length * 0.10)];
    const th = Math.max(top - 40, Math.min(noise + 10, top - 30));
    const first = rms.findIndex(v => v > th);
    if (first < 0) return x;
    let last = rms.length - 1;
    while (last > 0 && rms[last] <= th) last--;
    return x.slice(Math.max(0, first * win - pad), Math.min(x.length, (last + 1) * win + pad));
  }

  // Running maximum/minimum or mean over a centred window of 2h+1 samples.
  function slide(x, h, kind) {
    const n = x.length, out = new Float32Array(n);
    if (kind === 'mean') {
      const c = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) c[i + 1] = c[i] + x[i];
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - h), b = Math.min(n, i + h + 1);
        out[i] = (c[b] - c[a]) / (b - a);
      }
      return out;
    }
    // Running minimum (van Herk / Gil-Werman, blocks of 2h+1). Near the ends it
    // may include a few samples outside the window, which only lowers the gain.
    const w = 2 * h + 1, pre = new Float32Array(n), suf = new Float32Array(n);
    for (let i = 0; i < n; i++) pre[i] = i % w === 0 ? x[i] : Math.min(pre[i - 1], x[i]);
    for (let i = n - 1; i >= 0; i--) suf[i] = (i % w === w - 1 || i === n - 1) ? x[i] : Math.min(suf[i + 1], x[i]);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - h), b = Math.min(n - 1, i + h);
      out[i] = Math.min(suf[a], pre[b]);
    }
    return out;
  }

  function compressSpeech(x, rate) {
    const n = x.length;
    if (n === 0) return x;
    const sq = new Float32Array(n);
    for (let i = 0; i < n; i++) sq[i] = x[i] * x[i];
    const ms = slide(sq, Math.round(COMP_WIN_S * rate / 2), 'mean');
    const lv = new Float32Array(n);
    for (let i = 0; i < n; i++) lv[i] = 10 * Math.log10(ms[i] + 1e-12);
    // The loud level: 95th percentile of the detector, sampled every 5 ms.
    const pts = [];
    for (let i = 0; i < n; i += Math.round(0.005 * rate)) pts.push(lv[i]);
    pts.sort((a, b) => a - b);
    const loud = pts[Math.floor(pts.length * 0.95)];
    const th = loud - COMP_BELOW_DB;
    // Gain in dB with attack/release smoothing, run forwards then backwards so
    // it starts falling before a loud syllable (look-ahead, offline).
    const target = new Float32Array(n);
    for (let i = 0; i < n; i++) target[i] = lv[i] > th ? (th - lv[i]) * (1 - 1 / COMP_RATIO) : 0;
    const a = Math.exp(-1 / (COMP_ATTACK_S * rate)), r = Math.exp(-1 / (COMP_RELEASE_S * rate));
    const g = new Float32Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) { const c = target[i] < s ? a : r; s = c * s + (1 - c) * target[i]; g[i] = s; }
    s = 0;
    for (let i = n - 1; i >= 0; i--) { const c = g[i] < s ? a : r; s = c * s + (1 - c) * g[i]; g[i] = Math.min(g[i], s); }
    // Gate: opens fast and closes slowly, forwards and backwards (the more open
    // of the two), so it opens just before a word and closes after it.
    const noise = pts[Math.floor(pts.length * 0.10)];
    const gth = Math.min(loud - GATE_MIN_BELOW_DB, Math.max(noise + GATE_ABOVE_NOISE_DB, loud - GATE_MAX_BELOW_DB));
    const go = Math.exp(-1 / (GATE_OPEN_S * rate)), gc = Math.exp(-1 / (GATE_CLOSE_S * rate));
    const gt = new Float32Array(n);
    for (let i = 0; i < n; i++) gt[i] = lv[i] < gth ? Math.max(-GATE_RANGE_DB, (lv[i] - gth) * GATE_SLOPE) : 0;
    const gf = new Float32Array(n);
    s = gt[0];
    for (let i = 0; i < n; i++) { const c = gt[i] > s ? go : gc; s = c * s + (1 - c) * gt[i]; gf[i] = s; }
    s = gt[n - 1];
    for (let i = n - 1; i >= 0; i--) { const c = gt[i] > s ? go : gc; s = c * s + (1 - c) * gt[i]; g[i] += Math.max(gf[i], s); }
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = x[i] * Math.pow(10, g[i] / 20);
    // Limiter: ceiling LIMIT_CREST_DB above the compressed loud level. The
    // needed gain is min-filtered, then averaged over the same width, so it
    // reaches its floor across each peak without clicks.
    const loudAfter = loud - (loud - th) * (1 - 1 / COMP_RATIO);
    const ceil = Math.pow(10, (loudAfter + LIMIT_CREST_DB) / 20);
    const need = new Float32Array(n);
    for (let i = 0; i < n; i++) need[i] = Math.min(1, ceil / (Math.abs(y[i]) + 1e-12));
    const h = Math.max(1, Math.round(LIMIT_WIN_S * rate));
    const lim = slide(slide(need, h, 'min'), h, 'mean');
    for (let i = 0; i < n; i++) y[i] *= lim[i];
    return y;
  }

  // Mono speech at `rate` → trimmed, compressed, low-passed and peak-normalised
  // copy. The low-pass comes after the compressor and limiter, so whatever they
  // add above 17 kHz is removed before the signal goes in.
  function prepareSpeech(x, rate, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    if (o.trim) x = trimSilence(x, rate);
    if (o.compress) x = compressSpeech(x, rate);
    if (o.lpf) x = firFilter(x, lowpassTaps(rate));
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    const out = new Float32Array(x.length);
    const g = peak > 0 ? Math.pow(10, o.speechPeakDb / 20) / peak : 1;
    for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
    return out;
  }

  // Speech with the channel's signal mixed in from the start to the end of the
  // speech (overlay, §9 stage 3). Scales everything down if it would clip
  // (about −1 to −2 dB with the defaults; stages 3 and 5 were measured so).
  function mix(speech, rate, ch, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const cmdLen = (o.headerMs + 3 * o.symbolMs) / 1000;
    const total = Math.max(speech.length / rate, cmdLen + 0.1);
    const out = new Float32Array(Math.round(total * rate));
    out.set(speech.subarray(0, out.length));
    const sig = synthSteps(messageSteps(ch, total, o), rate, Math.pow(10, o.levelDb / 20));
    for (let i = 0; i < Math.min(sig.length, out.length); i++) out[i] += sig[i];
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    let scaleDb = 0;
    if (peak > 0.98) {
      const g = 0.98 / peak;
      for (let i = 0; i < out.length; i++) out[i] *= g;
      scaleDb = 20 * Math.log10(g);
    }
    return { data: out, seconds: total, scaleDb };
  }

  // 16-bit PCM mono WAV.
  function encodeWav(samples, rate) {
    const bytes = 44 + samples.length * 2;
    const v = new DataView(new ArrayBuffer(bytes));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, Math.round(x * 32767), true);
    }
    return v.buffer;
  }

  const api = {
    SYMBOL_HZ, CH_SEQ, WAV_SAMPLE_RATE, DEFAULTS,
    synthSteps, messageSteps, lowpassTaps, firFilter, trimSilence, prepareSpeech, mix, encodeWav,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ToyoutSignal = api;
})(typeof self !== 'undefined' ? self : this);
