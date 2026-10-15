/* EZ Sign .ezs encoder core. Pure functions, no DOM. Used by the web app and the Node tests.
 *
 * Pipeline: RGB pixels -> palette indices (dither) -> pack 2bpp rows right-to-left
 *           -> 2000-byte blocks -> LZO1X compress -> 250-byte fragments -> F0 D3 APDUs -> .ezs file
 */
(function (root) {
  "use strict";

  const W = 400, H = 300, BPP = 2;
  const BLOCK = 2000, FRAG = 250;

  // Panel color indices: 0 black, 1 white, 2 yellow, 3 red.
  const PALETTE_PURE = [[0, 0, 0], [255, 255, 255], [255, 255, 0], [255, 0, 0]];
  const PALETTE_TUNED = [[0, 0, 0], [160, 160, 160], [200, 128, 0], [160, 0, 0]];

  /* ---------------- color science (CIELAB, D65) ---------------- */
  function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linToSrgb(c) { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, c * 255)); }
  const fLab = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fLabInv = t => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));
  const XN = 0.95047, ZN = 1.08883;

  function rgbToLab(r, g, b) {
    r = srgbToLin(r); g = srgbToLin(g); b = srgbToLin(b);
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
    const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / ZN;
    const fx = fLab(x), fy = fLab(y), fz = fLab(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function labToRgb(L, a, bb) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
    const x = fLabInv(fx) * XN, y = fLabInv(fy), z = fLabInv(fz) * ZN;
    return [
      linToSrgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
      linToSrgb(-0.9692660 * x + 1.8760108 * y + 0.0415560 * z),
      linToSrgb(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
    ];
  }

  /* ---------------- dithering ----------------
   * rgb: Uint8ClampedArray RGBA (canvas ImageData layout), w*h*4
   * returns Uint8Array of palette indices, w*h
   */
  const KERNELS = {
    "floyd-steinberg": { div: 16, k: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
    atkinson: { div: 8, k: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
    jarvis: { div: 48, k: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
      [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]] },
  };

  function quantize(rgba, w, h, opts) {
    const dither = opts.dither || "floyd-steinberg";
    const palRgb = opts.palette === "tuned" ? PALETTE_TUNED : PALETTE_PURE;
    const pal = palRgb.map(c => rgbToLab(c[0], c[1], c[2]));
    const toneMap = opts.toneMap === undefined ? opts.palette === "tuned" : opts.toneMap;
    const lScale = toneMap ? pal[1][0] / 100 : 1; // squeeze L* into the panel's real white

    const n = w * h;
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lab = rgbToLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
      // treat transparent pixels as white
      const a = rgba[i * 4 + 3] / 255;
      L[i] = (lab[0] * a + 100 * (1 - a)) * lScale; A[i] = lab[1] * a; B[i] = lab[2] * a;
    }

    const out = new Uint8Array(n);
    const kern = KERNELS[dither];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let best = 0, bd = Infinity;
        for (let p = 0; p < pal.length; p++) {
          const dl = L[i] - pal[p][0], da = A[i] - pal[p][1], db = B[i] - pal[p][2];
          const d = dl * dl + da * da + db * db;
          if (d < bd) { bd = d; best = p; }
        }
        out[i] = best;
        if (!kern) continue;
        const el = L[i] - pal[best][0], ea = A[i] - pal[best][1], eb = B[i] - pal[best][2];
        for (const [dx, dy, wt] of kern.k) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx, f = wt / kern.div;
          L[j] += el * f; A[j] += ea * f; B[j] += eb * f;
        }
      }
    }
    return out;
  }

  /* ---------------- packing ---------------- */
  // Each row packed right-to-left: byte k of the row holds pixels starting at (bpr-1-k)*4,
  // pixel i of that group in bits (2i, 2i+1).
  function pack(indices, w, h) {
    const bpr = w / 4, out = new Uint8Array(bpr * h);
    for (let y = 0; y < h; y++) {
      for (let k = 0; k < bpr; k++) {
        const base = y * w + (bpr - 1 - k) * 4;
        out[y * bpr + k] = indices[base] | (indices[base + 1] << 2) | (indices[base + 2] << 4) | (indices[base + 3] << 6);
      }
    }
    return out;
  }

  /* ---------------- LZO1X compressor ----------------
   * Emits a valid LZO1X stream using literal runs, M2 and M3 matches (block <= 16 KB,
   * so M4 is never needed). Greedy hash matching, min match length 4.
   * Format follows lzo1x_d.ch from the LZO reference decompressor.
   */
  function lzo1xCompress(src) {
    const n = src.length, out = [];
    const HBITS = 12, head = new Int32Array(1 << HBITS).fill(-1);
    const hash = i => Math.imul((src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)), 2654435761) >>> (32 - HBITS);

    function emitLiterals(from, to) {
      let t = to - from;
      if (t === 0) return;
      if (out.length === 0 && t <= 238) out.push(17 + t);
      else if (t <= 3) out[out.length - 2] |= t;
      else if (t <= 18) out.push(t - 3);
      else {
        let tt = t - 18;
        out.push(0);
        while (tt > 255) { tt -= 255; out.push(0); }
        out.push(tt);
      }
      for (let i = from; i < to; i++) out.push(src[i]);
    }

    function emitMatch(len, dist) {
      if (dist > 16384) throw new Error("distance too large for M3");
      if (len <= 8 && dist <= 2048) {
        const o = dist - 1;
        out.push(((len - 1) << 5) | ((o & 7) << 2), o >> 3);
        return;
      }
      const o = dist - 1;
      if (len <= 33) out.push(32 | (len - 2));
      else {
        let m = len - 33;
        out.push(32);
        while (m > 255) { m -= 255; out.push(0); }
        out.push(m);
      }
      out.push((o << 2) & 0xff, (o >> 6) & 0xff);
    }

    let ip = 0, lit = 0;
    while (ip + 4 <= n) {
      const hv = hash(ip) & ((1 << HBITS) - 1);
      const cand = head[hv];
      head[hv] = ip;
      if (cand >= 0 && ip - cand <= 16384 &&
          src[cand] === src[ip] && src[cand + 1] === src[ip + 1] &&
          src[cand + 2] === src[ip + 2] && src[cand + 3] === src[ip + 3]) {
        let len = 4;
        while (ip + len < n && src[cand + len] === src[ip + len]) len++;
        emitLiterals(lit, ip);
        emitMatch(len, ip - cand);
        // seed the hash table inside the match so later data can reference it
        const end = ip + len;
        for (let j = ip + 1; j < end && j + 4 <= n; j++) head[hash(j) & ((1 << HBITS) - 1)] = j;
        ip = end;
        lit = ip;
      } else {
        ip++;
      }
    }
    emitLiterals(lit, n);
    out.push(0x11, 0x00, 0x00); // end of stream (M4 with zero distance)
    return Uint8Array.from(out);
  }

  /* ---------------- .ezs container ---------------- */
  function buildEzs(indices) {
    const packed = pack(indices, W, H);
    const apdus = [];
    for (let b = 0; b * BLOCK < packed.length; b++) {
      const comp = lzo1xCompress(packed.subarray(b * BLOCK, Math.min((b + 1) * BLOCK, packed.length)));
      const nfrag = Math.ceil(comp.length / FRAG);
      for (let f = 0; f < nfrag; f++) {
        const part = comp.subarray(f * FRAG, Math.min((f + 1) * FRAG, comp.length));
        const a = new Uint8Array(7 + part.length);
        a.set([0xF0, 0xD3, 0x00, f === nfrag - 1 ? 0x01 : 0x00, part.length + 2, b, f]);
        a.set(part, 7);
        apdus.push(a);
      }
    }
    const size = 12 + apdus.reduce((s, a) => s + 2 + a.length, 0);
    const buf = new Uint8Array(size), dv = new DataView(buf.buffer);
    buf.set([0x45, 0x5A, 0x53, 0x31]); // "EZS1"
    dv.setUint16(4, W, true); dv.setUint16(6, H, true);
    buf[8] = BPP; buf[9] = 0; dv.setUint16(10, apdus.length, true);
    let off = 12;
    for (const a of apdus) { dv.setUint16(off, a.length, true); buf.set(a, off + 2); off += 2 + a.length; }
    return buf;
  }

  const api = { W, H, PALETTE_PURE, PALETTE_TUNED, quantize, pack, lzo1xCompress, buildEzs, labToRgb, rgbToLab };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EzsCore = api;
})(typeof self !== "undefined" ? self : this);
