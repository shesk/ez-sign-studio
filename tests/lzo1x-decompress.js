// Reference-format LZO1X decompressor, test use only.
// Mirrors the state machine in lzo1x_d.ch (literal runs, M1/M2/M3/M4 matches, EOF marker).
// Validated against streams produced by the real lzo1x_1_compress (see tests/fixtures/ref_*.ezs).
"use strict";

function lzo1xDecompress(src) {
  const out = [];
  let ip = 0;
  const need = n => { if (ip + n > src.length) throw new Error("input overrun"); };
  const lits = n => { need(n); for (let i = 0; i < n; i++) out.push(src[ip++]); };
  const copy = (dist, len) => {
    let p = out.length - dist;
    if (p < 0) throw new Error("lookbehind overrun");
    for (let i = 0; i < len; i++) out.push(out[p++]);
  };
  const ext = base => { let t = 0; while (src[ip] === 0) { t += 255; ip++; need(1); } return t + base + src[ip++]; };

  let t;
  let state; // "loop" | "first" | "match"
  need(1);
  if (src[0] > 17) {
    t = src[ip++] - 17;
    lits(t);
    if (t < 4) { need(1); t = src[ip++]; state = "match"; } else state = "first";
  } else state = "loop";

  for (;;) {
    if (state === "loop") {
      need(1); t = src[ip++];
      if (t >= 16) { state = "match"; continue; }
      if (t === 0) t = ext(15);
      lits(t + 3);
      state = "first";
      continue;
    }
    if (state === "first") {
      need(1); t = src[ip++];
      if (t >= 16) { state = "match"; continue; }
      // M1 directly after a literal run: 3-byte match, distance 2049..3072
      need(1);
      copy(1 + 0x0800 + (t >> 2) + (src[ip++] << 2), 3);
    } else { // "match": t holds the opcode
      if (t >= 64) {
        need(1);
        copy(1 + ((t >> 2) & 7) + (src[ip++] << 3), (t >> 5) + 1);
      } else if (t >= 32) {
        let len = t & 31;
        if (len === 0) len = ext(31);
        need(2);
        const dist = 1 + (src[ip] >> 2) + (src[ip + 1] << 6); ip += 2;
        copy(dist, len + 2);
      } else if (t >= 16) {
        let dist = (t & 8) << 11;
        let len = t & 7;
        if (len === 0) len = ext(7);
        need(2);
        dist += (src[ip] >> 2) + (src[ip + 1] << 6); ip += 2;
        if (dist === 0) return Uint8Array.from(out); // end of stream
        copy(dist + 0x4000, len + 2);
      } else {
        // M1 after a match: 2-byte match, distance 1..1024
        need(1);
        copy(1 + (t >> 2) + (src[ip++] << 2), 2);
      }
    }
    // match_done: low 2 bits of the byte two back say how many literals follow (0..3)
    t = src[ip - 2] & 3;
    if (t === 0) { state = "loop"; continue; }
    lits(t);
    need(1); t = src[ip++];
    state = "match";
  }
}

module.exports = { lzo1xDecompress };
