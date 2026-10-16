#!/usr/bin/env node
// EZ Sign Studio encoder tests. No dependencies: `node tests/run.js`
// Exits non-zero on any failure. Run after every change to ezs-core.js.
"use strict";
const fs = require("fs");
const path = require("path");
const C = require("../ezs-core.js");
const { lzo1xDecompress } = require("./lzo1x-decompress.js");

const FIX = path.join(__dirname, "fixtures");
let failures = 0, checks = 0;
function check(cond, msg) { checks++; if (!cond) { failures++; console.error("FAIL:", msg); } }
function eq(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

// Parse an .ezs file exactly as the Flipper app does (ez_sign.c load_payload), then decode it to palette indices.
function decodeEzs(buf, label) {
  check(buf.length >= 12 && buf.length <= 48 * 1024, `${label}: file size ${buf.length} within 12..48K`);
  check(String.fromCharCode(...buf.subarray(0, 4)) === "EZS1", `${label}: magic`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const w = dv.getUint16(4, true), h = dv.getUint16(6, true), bpp = buf[8], count = dv.getUint16(10, true);
  check(w === 400 && h === 300 && bpp === 2, `${label}: header 400x300 2bpp (got ${w}x${h} ${bpp})`);
  const blocks = new Map();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const len = dv.getUint16(off, true);
    check(len >= 5 && len <= 261 && off + 2 + len <= buf.length, `${label}: APDU ${i} length ${len}`);
    const a = buf.subarray(off + 2, off + 2 + len);
    off += 2 + len;
    check(a[0] === 0xF0 && a[1] === 0xD3 && a[2] === 0x00, `${label}: APDU ${i} is F0 D3 00`);
    check(a[4] === len - 5, `${label}: APDU ${i} Lc matches`);
    check(a[3] === 0 || a[3] === 1, `${label}: APDU ${i} P2 is 0/1`);
    check(len - 7 <= 250, `${label}: fragment ${i} <= 250 bytes`);
    const blk = a[5], frag = a[6];
    if (!blocks.has(blk)) blocks.set(blk, []);
    blocks.get(blk).push({ frag, last: a[3] === 1, data: a.subarray(7) });
  }
  check(off === buf.length, `${label}: no trailing bytes`);

  const packed = [];
  for (const b of [...blocks.keys()].sort((x, y) => x - y)) {
    const frags = blocks.get(b).sort((x, y) => x.frag - y.frag);
    check(frags.every((f, i) => f.frag === i), `${label}: block ${b} fragments contiguous`);
    check(frags[frags.length - 1].last && frags.slice(0, -1).every(f => !f.last), `${label}: block ${b} final flag only on last fragment`);
    const z = Uint8Array.from(frags.flatMap(f => [...f.data]));
    const raw = lzo1xDecompress(z);
    check(raw.length === 2000, `${label}: block ${b} decompresses to 2000 bytes (got ${raw.length})`);
    packed.push(...raw);
  }
  check(packed.length === 30000, `${label}: 30000 packed bytes`);

  // Unpack: each row is 100 bytes, packed right-to-left, 4 pixels per byte, pixel i in bits 2i..2i+1.
  const idx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let k = 0; k < 100; k++) {
    const byte = packed[y * 100 + k], base = (99 - k) * 4;
    for (let i = 0; i < 4; i++) idx[y * w + base + i] = (byte >> (2 * i)) & 3;
  }
  return idx;
}

// 1. The test decoder agrees with the reference implementation (payloads made by nfc-eink, verified on hardware).
for (const name of ["ref_flat", "ref_dither"]) {
  const idx = decodeEzs(new Uint8Array(fs.readFileSync(path.join(FIX, name + ".ezs"))), name);
  const want = new Uint8Array(fs.readFileSync(path.join(FIX, name + ".idx")));
  check(eq(idx, want), `${name}: decoded pixels match reference`);
}

// 2. Re-encoding the reference pixels with ezs-core produces a file that decodes to the same pixels.
for (const name of ["ref_flat", "ref_dither"]) {
  const want = new Uint8Array(fs.readFileSync(path.join(FIX, name + ".idx")));
  const ezs = C.buildEzs(want);
  check(eq(decodeEzs(ezs, name + " re-encoded"), want), `${name}: ezs-core round trip`);
}

// 3. LZO compressor fuzz: every stream must decode back exactly.
let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
const gens = [
  n => Uint8Array.from({ length: n }, () => rnd() * 256 | 0),
  n => Uint8Array.from({ length: n }, () => [0, 0x55, 0xaa, 0xff][rnd() * 4 | 0]),
  n => { const r = 1 + (rnd() * 60 | 0); return Uint8Array.from({ length: n }, (_, i) => ((i / r | 0) % 4) * 0x55); },
  n => Uint8Array.from({ length: n }, () => (rnd() < 0.95 ? 0x55 : rnd() * 256 | 0)),
  n => new Uint8Array(n).fill(rnd() * 256 | 0),
];
for (let i = 0; i < 500; i++) {
  const n = [1, 2, 3, 4, 5, 18, 19, 238, 239, 2000][i % 10] + (i % 10 === 9 ? 0 : (rnd() * 3 | 0));
  const src = gens[i % gens.length](n);
  let ok = false;
  try { ok = eq(lzo1xDecompress(C.lzo1xCompress(src)), src); } catch (e) { /* ok stays false */ }
  check(ok, `lzo fuzz case ${i} (len ${n}, gen ${i % gens.length})`);
}

// 4. Full pipeline on synthetic images with every dither mode; payload stays under the Flipper's 48 KB cap.
const W = 400, H = 300, rgba = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  rgba[i] = x * 255 / W; rgba[i + 1] = y * 255 / H; rgba[i + 2] = ((x * y) >> 6) & 255; rgba[i + 3] = 255;
}
for (const dither of ["none", "floyd-steinberg", "atkinson", "jarvis"]) for (const palette of ["pure", "tuned"]) {
  const idx = C.quantize(rgba, W, H, { dither, palette });
  check(idx.every(v => v <= 3), `quantize ${dither}/${palette}: indices 0..3`);
  const ezs = C.buildEzs(idx);
  check(eq(decodeEzs(ezs, `${dither}/${palette}`), idx), `pipeline ${dither}/${palette}: round trip`);
}

// 5. Known colors map to the right panel inks.
const solid = (r, g, b) => { const a = new Uint8ClampedArray(4 * 4); for (let i = 0; i < 4; i++) a.set([r, g, b, 255], i * 4); return C.quantize(a, 2, 2, { dither: "none" })[0]; };
check(solid(0, 0, 0) === 0, "black -> 0");
check(solid(255, 255, 255) === 1, "white -> 1");
check(solid(255, 255, 0) === 2, "yellow -> 2");
check(solid(255, 0, 0) === 3, "red -> 3");

// 6. Wi-Fi QR join strings: escaping and fields, per the WIFI: URI convention.
const { EzsTemplates } = require("../templates.js");
const BS = "\\";
const wifi = [
  [{ ssid: "Guest-WiFi", pass: "welcome-2026", sec: "WPA" }, "WIFI:T:WPA;S:Guest-WiFi;P:welcome-2026;;"],
  [{ ssid: "Cafe;Guest", pass: 'p@ss:wo,rd"' + BS + "1", sec: "WPA", hidden: "yes" },
    "WIFI:T:WPA;S:Cafe" + BS + ";Guest;P:p@ss" + BS + ":wo" + BS + ",rd" + BS + '"' + BS + BS + "1;H:true;;"],
  [{ ssid: "Lobby", pass: "ignored", sec: "nopass" }, "WIFI:T:nopass;S:Lobby;;"],
  [{ ssid: "Old", pass: "abc", sec: "WEP" }, "WIFI:T:WEP;S:Old;P:abc;;"],
];
for (const [v, want] of wifi) check(EzsTemplates.wifiQrString(v) === want, `wifi string for ${JSON.stringify(v.ssid)}: got ${EzsTemplates.wifiQrString(v)}`);

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
