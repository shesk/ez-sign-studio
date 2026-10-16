/* EZ Sign Studio stock templates.
 *
 * Each template draws onto a 400x300 canvas using only the panel's four inks
 * (pure palette, no dithering), so shapes and text come out solid on the display.
 * A template is { id, name, fields, draw(ctx, v) } where v maps field keys to values.
 * Field types: "text" (default) and "choice" (options: [{v, label}]).
 */
(function (root) {
  "use strict";

  const W = 400, H = 300;
  const K = "#000000", Wt = "#ffffff", Y = "#ffff00", R = "#ff0000"; // panel inks
  const SANS = '"Barlow Semi Condensed", "Arial Narrow", Arial, sans-serif';
  const SLAB = '"Roboto Slab", Georgia, serif';

  /* ---------------- drawing helpers ---------------- */
  function fill(ctx, color, x = 0, y = 0, w = W, h = H) { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); }

  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Largest font size (<= maxSize) that fits text in maxW x maxH; draws it centered on (cx, cy).
  function fitText(ctx, text, cx, cy, maxW, maxH, o = {}) {
    text = String(text || "");
    if (!text) return 0;
    const weight = o.weight || 800, family = o.family || SANS;
    let size = Math.min(o.maxSize || 200, maxH);
    for (; size > 8; size -= 1) {
      ctx.font = `${weight} ${size}px ${family}`;
      if (ctx.measureText(text).width <= maxW) break;
    }
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = o.color || K;
    ctx.textAlign = o.align || "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, cy + size * 0.04);
    return size;
  }

  // Like fitText, but if one line would come out small, split at the space nearest
  // the middle and use two lines when that gives a meaningfully bigger size.
  function fitWrap(ctx, text, cx, cy, maxW, maxH, o = {}) {
    text = String(text || "").trim();
    const size1 = measureFit(ctx, [text], maxW, maxH, o);
    const spaces = [...text.matchAll(/ /g)].map(m => m.index);
    if (!spaces.length || size1 >= maxH * 0.55) return fitText(ctx, text, cx, cy, maxW, maxH, o);
    const mid = text.length / 2;
    const at = spaces.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
    const lines = [text.slice(0, at), text.slice(at + 1)];
    if (measureFit(ctx, lines, maxW, maxH, o) <= size1 * 1.15) return fitText(ctx, text, cx, cy, maxW, maxH, o);
    fitLines(ctx, lines, cx, cy, maxW, maxH, o);
  }
  function measureFit(ctx, lines, maxW, maxH, o) {
    const weight = o.weight || 800, family = o.family || SANS, lh = o.lineHeight || 1.08;
    let size = Math.min(o.maxSize || 200, lines.length > 1 ? maxH / lines.length / lh : maxH);
    for (; size > 8; size -= 1) {
      ctx.font = `${weight} ${size}px ${family}`;
      if (Math.max(...lines.map(l => ctx.measureText(l).width)) <= maxW) break;
    }
    return size;
  }

  // Several lines stacked and centered in a box, all at the same (largest fitting) size.
  function fitLines(ctx, lines, cx, cy, maxW, maxH, o = {}) {
    lines = lines.filter(l => String(l || "").trim());
    if (!lines.length) return;
    const weight = o.weight || 800, family = o.family || SANS, lh = o.lineHeight || 1.08;
    let size = Math.min(o.maxSize || 200, maxH / lines.length / lh);
    for (; size > 8; size -= 1) {
      ctx.font = `${weight} ${size}px ${family}`;
      if (Math.max(...lines.map(l => ctx.measureText(l).width)) <= maxW) break;
    }
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = o.color || K; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const step = size * lh, y0 = cy - (step * (lines.length - 1)) / 2;
    lines.forEach((l, i) => ctx.fillText(l, cx, y0 + i * step + size * 0.04));
  }

  function hazardStripes(ctx, x, y, w, h, a = K, b = Y, band = 26) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    fill(ctx, b, x, y, w, h);
    ctx.fillStyle = a;
    for (let i = -h; i < w + h; i += band * 2) {
      ctx.beginPath();
      ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + band, y + h);
      ctx.lineTo(x + i + band + h, y); ctx.lineTo(x + i + h, y);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------- icons (drawn as solid shapes) ---------------- */
  function iconWarning(ctx, cx, cy, s, body = Y, ink = K) {
    const h = s * 0.87;
    ctx.beginPath();
    ctx.moveTo(cx, cy - h / 2); ctx.lineTo(cx + s / 2, cy + h / 2); ctx.lineTo(cx - s / 2, cy + h / 2); ctx.closePath();
    ctx.fillStyle = ink; ctx.fill();
    const t = s * 0.72, th = t * 0.87, oy = h * 0.08;
    ctx.beginPath();
    ctx.moveTo(cx, cy - th / 2 + oy); ctx.lineTo(cx + t / 2, cy + th / 2 + oy); ctx.lineTo(cx - t / 2, cy + th / 2 + oy); ctx.closePath();
    ctx.fillStyle = body; ctx.fill();
    ctx.fillStyle = ink;
    ctx.fillRect(cx - s * 0.045, cy - h * 0.12, s * 0.09, h * 0.36);
    ctx.beginPath(); ctx.arc(cx, cy + h * 0.33, s * 0.055, 0, Math.PI * 2); ctx.fill();
  }

  function iconNoEntry(ctx, cx, cy, r, ring = R, bar = Wt) {
    ctx.fillStyle = ring; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = bar; ctx.fillRect(cx - r * 0.66, cy - r * 0.17, r * 1.32, r * 0.34);
  }

  function iconClock(ctx, cx, cy, r, face = Wt, ink = K, hh = 2, mm = 30) {
    ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = face; ctx.beginPath(); ctx.arc(cx, cy, r * 0.84, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = ink; ctx.lineCap = "round";
    const hand = (ang, len, wdt) => {
      ctx.lineWidth = wdt; ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(ang) * len, cy - Math.cos(ang) * len); ctx.stroke();
    };
    hand(((hh % 12) + mm / 60) / 12 * Math.PI * 2, r * 0.45, r * 0.13);
    hand(mm / 60 * Math.PI * 2, r * 0.68, r * 0.09);
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2, r1 = r * 0.72, r2 = r * (i % 3 ? 0.76 : 0.8);
      ctx.lineWidth = r * (i % 3 ? 0.03 : 0.06); ctx.beginPath();
      ctx.moveTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1); ctx.lineTo(cx + Math.sin(a) * r2, cy - Math.cos(a) * r2); ctx.stroke();
    }
    ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(cx, cy, r * 0.08, 0, Math.PI * 2); ctx.fill();
  }

  function iconLock(ctx, cx, cy, s, ink = K, hole = Y) {
    const bw = s * 0.8, bh = s * 0.6, by = cy - s * 0.05;
    ctx.strokeStyle = ink; ctx.lineWidth = s * 0.14;
    ctx.beginPath(); ctx.arc(cx, by, s * 0.27, Math.PI, 0); ctx.lineTo(cx + s * 0.27, by + s * 0.1);
    ctx.moveTo(cx - s * 0.27, by); ctx.lineTo(cx - s * 0.27, by + s * 0.1); ctx.stroke();
    ctx.fillStyle = ink; rrect(ctx, cx - bw / 2, by, bw, bh, s * 0.08); ctx.fill();
    ctx.fillStyle = hole; ctx.beginPath(); ctx.arc(cx, by + bh * 0.4, s * 0.08, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(cx - s * 0.035, by + bh * 0.4, s * 0.07, bh * 0.35);
  }

  function iconWifi(ctx, cx, cy, s, ink = K) {
    ctx.strokeStyle = ink; ctx.lineCap = "round"; ctx.lineWidth = s * 0.11;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath(); ctx.arc(cx, cy + s * 0.3, s * 0.22 * i, Math.PI * 1.25, Math.PI * 1.75); ctx.stroke();
    }
    ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(cx, cy + s * 0.3, s * 0.08, 0, Math.PI * 2); ctx.fill();
  }

  function iconPower(ctx, cx, cy, r, ink = K) {
    ctx.strokeStyle = ink; ctx.lineWidth = r * 0.22; ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2 + 0.75, Math.PI * 1.5 - 0.75); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - r * 1.15); ctx.lineTo(cx, cy - r * 0.15); ctx.stroke();
  }

  function iconMic(ctx, cx, cy, s, ink = Wt) {
    ctx.fillStyle = ink; rrect(ctx, cx - s * 0.16, cy - s * 0.5, s * 0.32, s * 0.6, s * 0.16); ctx.fill();
    ctx.strokeStyle = ink; ctx.lineWidth = s * 0.08; ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(cx, cy - s * 0.05, s * 0.28, 0.15, Math.PI - 0.15); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy + s * 0.23); ctx.lineTo(cx, cy + s * 0.42); ctx.moveTo(cx - s * 0.18, cy + s * 0.42); ctx.lineTo(cx + s * 0.18, cy + s * 0.42); ctx.stroke();
  }

  function star(ctx, cx, cy, r, color) {
    ctx.fillStyle = color; ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
      ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
  }

  const INK = { black: K, white: Wt, yellow: Y, red: R };
  const ACCENTS = [{ v: "red", label: "Red" }, { v: "black", label: "Black" }, { v: "yellow", label: "Yellow" }];
  const onAccent = a => (a === "yellow" ? K : Wt); // readable text on an accent band

  /* ---------------- templates ---------------- */
  const TEMPLATES = [
    {
      id: "hello", name: "Hello, my name is",
      fields: [
        { key: "name", label: "Name", value: "Alex" },
        { key: "accent", label: "Color", type: "choice", options: ACCENTS, value: "red" },
      ],
      draw(ctx, v) {
        const a = INK[v.accent], t = onAccent(v.accent);
        fill(ctx, a);
        fitText(ctx, "HELLO", W / 2, 46, 360, 64, { color: t, maxSize: 66 });
        fitText(ctx, "my name is", W / 2, 92, 300, 30, { color: t, weight: 600, maxSize: 28 });
        ctx.fillStyle = Wt; rrect(ctx, 14, 116, W - 28, 150, 10); ctx.fill();
        fitWrap(ctx, v.name, W / 2, 191, 340, 120, { family: SLAB, weight: 700, color: K });
      },
    },
    {
      id: "conference", name: "Conference badge",
      fields: [
        { key: "event", label: "Event", value: "SECURECON 2026" },
        { key: "name", label: "Name", value: "Alex" },
        { key: "title", label: "Title", value: "Application Security" },
        { key: "role", label: "Role ribbon", value: "SPEAKER" },
        { key: "accent", label: "Ribbon color", type: "choice", options: ACCENTS, value: "red" },
      ],
      draw(ctx, v) {
        fill(ctx, Wt);
        fill(ctx, K, 0, 0, W, 48);
        fitText(ctx, v.event, W / 2, 25, 360, 32, { color: Wt, maxSize: 30 });
        fitWrap(ctx, v.name, W / 2, 128, 360, 110, { weight: 800 });
        fitText(ctx, v.title, W / 2, 202, 360, 30, { weight: 600, maxSize: 28 });
        fill(ctx, INK[v.accent], 0, 236, W, 64);
        fitText(ctx, v.role, W / 2, 269, 360, 48, { color: onAccent(v.accent), maxSize: 46 });
      },
    },
    {
      id: "nameplate", name: "Desk nameplate",
      fields: [
        { key: "name", label: "Name", value: "Alex" },
        { key: "title", label: "Title", value: "Director, Security" },
      ],
      draw(ctx, v) {
        fill(ctx, K);
        ctx.strokeStyle = Y; ctx.lineWidth = 3; ctx.strokeRect(14, 14, W - 28, H - 28);
        fitWrap(ctx, v.name, W / 2, 128, 330, 110, { family: SLAB, weight: 700, color: Wt });
        fill(ctx, Y, W / 2 - 40, 186, 80, 4);
        fitText(ctx, String(v.title || "").toUpperCase(), W / 2, 222, 330, 30, { weight: 600, color: Wt, maxSize: 28 });
      },
    },
    {
      id: "onair", name: "On air",
      fields: [
        { key: "line", label: "Main text", value: "ON AIR" },
        { key: "sub", label: "Subtext", value: "Recording in progress" },
      ],
      draw(ctx, v) {
        fill(ctx, K);
        ctx.fillStyle = R; rrect(ctx, 20, 24, W - 40, 190, 26); ctx.fill();
        ctx.strokeStyle = Wt; ctx.lineWidth = 6; rrect(ctx, 32, 36, W - 64, 166, 18); ctx.stroke();
        iconMic(ctx, 86, 124, 100, Wt);
        fitText(ctx, v.line, 248, 122, 206, 130, { color: Wt });
        fitText(ctx, v.sub, W / 2, 256, 360, 34, { weight: 600, color: Wt, maxSize: 32 });
      },
    },
    {
      id: "dnd", name: "Do not disturb",
      fields: [
        { key: "line1", label: "Line 1", value: "DO NOT" },
        { key: "line2", label: "Line 2", value: "DISTURB" },
        { key: "sub", label: "Subtext", value: "On a call until 3:00" },
      ],
      draw(ctx, v) {
        fill(ctx, Wt);
        iconNoEntry(ctx, 92, 130, 72);
        fitLines(ctx, [v.line1, v.line2], 274, 128, 200, 170, { maxSize: 80 });
        fill(ctx, R, 0, 238, W, 62);
        fitText(ctx, v.sub, W / 2, 269, 370, 36, { color: Wt, weight: 700, maxSize: 34 });
      },
    },
    {
      id: "backat", name: "Back at",
      fields: [
        { key: "head", label: "Heading", value: "BACK AT" },
        { key: "time", label: "Time", value: "2:30" },
        { key: "sub", label: "Subtext", value: "Grabbing lunch" },
      ],
      draw(ctx, v) {
        fill(ctx, Y);
        const m = /^(\d{1,2}):(\d{2})/.exec(String(v.time || ""));
        iconClock(ctx, 96, 140, 74, Wt, K, m ? +m[1] : 2, m ? +m[2] : 30);
        fitText(ctx, v.head, 280, 72, 200, 50, { maxSize: 48 });
        fitText(ctx, v.time, 280, 150, 200, 100, {});
        fitText(ctx, v.sub, W / 2, 262, 360, 34, { weight: 600, maxSize: 32 });
      },
    },
    {
      id: "room", name: "Room status",
      fields: [
        { key: "room", label: "Room name", value: "Conference Room B" },
        { key: "status", label: "Status", type: "choice", value: "busy",
          options: [{ v: "busy", label: "In use" }, { v: "free", label: "Available" }, { v: "reserved", label: "Reserved" }] },
        { key: "note", label: "Note", value: "Until 11:00" },
      ],
      draw(ctx, v) {
        const look = {
          busy: { bg: R, fg: Wt, text: "IN USE" },
          free: { bg: Wt, fg: K, text: "AVAILABLE" },
          reserved: { bg: Y, fg: K, text: "RESERVED" },
        }[v.status] || { bg: R, fg: Wt, text: "IN USE" };
        fill(ctx, look.bg);
        fill(ctx, K, 0, 0, W, 56);
        fitText(ctx, v.room, W / 2, 29, 370, 36, { color: Wt, maxSize: 34 });
        if (v.status === "free") { ctx.strokeStyle = K; ctx.lineWidth = 6; ctx.strokeRect(18, 74, W - 36, 150); }
        fitText(ctx, look.text, W / 2, 150, 340, 110, { color: look.fg });
        fitText(ctx, v.note, W / 2, 260, 360, 40, { color: look.fg, weight: 600, maxSize: 36 });
      },
    },
    {
      id: "open", name: "Open / closed",
      fields: [
        { key: "state", label: "Sign", type: "choice", value: "open",
          options: [{ v: "open", label: "Open" }, { v: "closed", label: "Closed" }] },
        { key: "sub", label: "Subtext", value: "Come on in" },
        { key: "hours", label: "Hours", value: "Mon–Fri 8–5" },
      ],
      draw(ctx, v) {
        const open = v.state !== "closed";
        fill(ctx, open ? Wt : K);
        const ink = open ? R : Wt;
        ctx.strokeStyle = ink; ctx.lineWidth = 8; rrect(ctx, 16, 16, W - 32, H - 32, 22); ctx.stroke();
        fitText(ctx, open ? "OPEN" : "CLOSED", W / 2, 120, 320, 130, { color: ink, family: SLAB, weight: 700 });
        fitText(ctx, v.sub, W / 2, 205, 320, 36, { color: open ? K : Wt, weight: 600, maxSize: 34 });
        fitText(ctx, v.hours, W / 2, 250, 300, 28, { color: open ? K : Y, weight: 600, maxSize: 26 });
      },
    },
    {
      id: "caution", name: "Caution",
      fields: [
        { key: "head", label: "Heading", value: "CAUTION" },
        { key: "line1", label: "Line 1", value: "Wet floor" },
        { key: "line2", label: "Line 2", value: "" },
      ],
      draw(ctx, v) {
        fill(ctx, Y);
        hazardStripes(ctx, 0, 0, W, 34);
        hazardStripes(ctx, 0, H - 34, W, 34);
        iconWarning(ctx, 92, 132, 128);
        fitText(ctx, v.head, 272, 108, 210, 74, {});
        fitLines(ctx, [v.line1, v.line2], W / 2, 220, 360, 64, { weight: 700, maxSize: 40 });
      },
    },
    {
      id: "authorized", name: "Authorized only",
      fields: [
        { key: "line1", label: "Line 1", value: "AUTHORIZED" },
        { key: "line2", label: "Line 2", value: "PERSONNEL ONLY" },
        { key: "sub", label: "Subtext", value: "Badge access required" },
      ],
      draw(ctx, v) {
        fill(ctx, Wt);
        fill(ctx, R, 0, 0, W, 62);
        fitText(ctx, "RESTRICTED AREA", W / 2, 32, 360, 40, { color: Wt, maxSize: 38 });
        iconLock(ctx, 62, 146, 84, K, Wt);
        fitLines(ctx, [v.line1, v.line2], 254, 150, 250, 120, { maxSize: 56 });
        fill(ctx, K, 0, 238, W, 62);
        fitText(ctx, v.sub, W / 2, 269, 370, 32, { color: Y, weight: 700, maxSize: 30 });
      },
    },
    {
      id: "unplug", name: "Do not unplug",
      fields: [
        { key: "head", label: "Heading", value: "DO NOT UNPLUG" },
        { key: "what", label: "What it is", value: "Home lab server" },
        { key: "who", label: "Contact", value: "Ask IT before unplugging" },
      ],
      draw(ctx, v) {
        fill(ctx, K);
        hazardStripes(ctx, 0, 0, 22, H, K, Y, 18);
        hazardStripes(ctx, W - 22, 0, 22, H, K, Y, 18);
        ctx.fillStyle = R; ctx.beginPath(); ctx.arc(W / 2, 92, 58, 0, Math.PI * 2); ctx.fill();
        iconPower(ctx, W / 2, 98, 30, Wt);
        fitText(ctx, v.head, W / 2, 186, 330, 52, { color: Y });
        fitText(ctx, v.what, W / 2, 232, 330, 32, { color: Wt, weight: 700, maxSize: 30 });
        fitText(ctx, v.who, W / 2, 268, 330, 26, { color: Wt, weight: 600, maxSize: 24 });
      },
    },
    {
      id: "reserved", name: "Reserved",
      fields: [
        { key: "for", label: "Reserved for", value: "Alex" },
        { key: "when", label: "When", value: "Today, all day" },
      ],
      draw(ctx, v) {
        fill(ctx, Wt);
        ctx.strokeStyle = K; ctx.lineWidth = 10; ctx.strokeRect(10, 10, W - 20, H - 20);
        ctx.lineWidth = 3; ctx.strokeRect(22, 22, W - 44, H - 44);
        star(ctx, 80, 70, 22, R); star(ctx, W - 80, 70, 22, R);
        fitText(ctx, "RESERVED", W / 2, 70, 200, 52, { family: SLAB, weight: 700 });
        fitText(ctx, "for", W / 2, 118, 100, 26, { weight: 600, maxSize: 24 });
        fitWrap(ctx, v.for, W / 2, 175, 320, 80, { color: R });
        fitText(ctx, v.when, W / 2, 245, 320, 30, { weight: 600, maxSize: 28 });
      },
    },
    {
      id: "wifi", name: "Wi‑Fi info",
      fields: [
        { key: "ssid", label: "Network", value: "Guest-WiFi" },
        { key: "pass", label: "Password", value: "welcome-2026" },
      ],
      draw(ctx, v) {
        fill(ctx, Wt);
        fill(ctx, K, 0, 0, W, 100);
        iconWifi(ctx, 66, 40, 82, Y);
        fitText(ctx, "FREE WI-FI", 236, 52, 250, 60, { color: Wt });
        fitText(ctx, "NETWORK", 30, 132, 200, 22, { align: "left", weight: 700, color: R, maxSize: 20 });
        fitText(ctx, v.ssid, W / 2, 170, 350, 48, { weight: 700 });
        fitText(ctx, "PASSWORD", 30, 214, 200, 22, { align: "left", weight: 700, color: R, maxSize: 20 });
        fitText(ctx, v.pass, W / 2, 254, 350, 48, { weight: 700 });
      },
    },
    {
      id: "price", name: "Shelf price tag",
      fields: [
        { key: "item", label: "Item", value: "Flipper Zero" },
        { key: "detail", label: "Detail", value: "Multi-tool for geeks" },
        { key: "price", label: "Price", value: "$169" },
        { key: "badge", label: "Corner badge", value: "SALE" },
      ],
      draw(ctx, v) {
        fill(ctx, Wt);
        fill(ctx, Y, 0, 160, W, 140);
        fitText(ctx, v.item, 24, 52, 260, 54, { align: "left", weight: 800, maxSize: 52 });
        fitText(ctx, v.detail, 24, 100, 280, 28, { align: "left", weight: 600, maxSize: 26 });
        fitText(ctx, v.price, W / 2, 232, 360, 120, {});
        if (String(v.badge || "").trim()) {
          ctx.save(); ctx.translate(W - 58, 58); ctx.rotate(Math.PI / 12);
          star(ctx, 0, 0, 56, R);
          fitText(ctx, v.badge, 0, 2, 58, 24, { color: Wt, maxSize: 22 });
          ctx.restore();
        }
        ctx.fillStyle = K; ctx.font = `500 13px ${SANS}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        ctx.fillText("SKU 00042-EZ", 24, 150);
      },
    },
  ];

  root.EzsTemplates = { TEMPLATES, W, H };
})(typeof self !== "undefined" ? self : this);
