package io.github.shesk.ezsign;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Parser and validator for .ezs payload files (pure Java, no Android APIs, so it is unit-tested on a JVM).
 *
 * Format, little-endian:
 *   "EZS1", u16 width, u16 height, u8 bpp, u8 0, u16 apdu_count,
 *   then apdu_count x { u16 length, raw APDU bytes }.
 * Every APDU must be an image-data command: F0 D3 00 P2 Lc blockNo fragNo data...
 *
 * Validation is stricter than the Flipper loader: besides the framing checks it LZO-decompresses every
 * block and requires the result to be exactly the panel's framebuffer size. That also produces the pixels
 * for the on-screen preview, so what you see in the app is what gets written.
 */
public final class Ezs {
    public static final int MAX_FILE = 48 * 1024;
    static final int BLOCK = 2000;

    public final int width, height, bpp;
    public final List<byte[]> apdus;
    /** Palette index (0 black, 1 white, 2 yellow, 3 red) per pixel, row-major. */
    public final byte[] pixels;
    public final int sizeBytes;

    private Ezs(int width, int height, int bpp, List<byte[]> apdus, byte[] pixels, int sizeBytes) {
        this.width = width; this.height = height; this.bpp = bpp;
        this.apdus = apdus; this.pixels = pixels; this.sizeBytes = sizeBytes;
    }

    public int maxApduLength() {
        int m = 0;
        for (byte[] a : apdus) m = Math.max(m, a.length);
        return m;
    }

    /** Reads at most MAX_FILE + 1 bytes, so an oversized or endless stream is rejected without buffering it. */
    public static byte[] readLimited(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > MAX_FILE) throw new FormatException("File is larger than 48 KB, so it isn't an EZ Sign payload.");
        }
        return out.toByteArray();
    }

    public static Ezs parse(byte[] f) throws FormatException {
        if (f.length < 12) throw new FormatException("File is too small to be an EZ Sign payload.");
        if (f.length > MAX_FILE) throw new FormatException("File is larger than 48 KB, so it isn't an EZ Sign payload.");
        if (f[0] != 'E' || f[1] != 'Z' || f[2] != 'S' || f[3] != '1')
            throw new FormatException("This isn't an EZ Sign payload. Share it from EZ Sign Studio.");
        int w = u16(f, 4), h = u16(f, 6), bpp = f[8] & 0xff, count = u16(f, 10);
        if (bpp != 1 && bpp != 2) throw new FormatException("Unsupported color depth (" + bpp + " bits per pixel).");
        if (w == 0 || h == 0 || w > 1024 || h > 1024 || (w * bpp) % 8 != 0)
            throw new FormatException("Unsupported panel size " + w + "×" + h + ".");
        if (count == 0) throw new FormatException("Payload contains no image data.");

        List<byte[]> apdus = new ArrayList<>(count);
        Map<Integer, ByteArrayOutputStream> blocks = new TreeMap<>();
        Map<Integer, Integer> nextFrag = new TreeMap<>();
        Map<Integer, Boolean> closed = new TreeMap<>();
        int off = 12;
        for (int i = 0; i < count; i++) {
            if (off + 2 > f.length) throw new FormatException("Payload is truncated.");
            int len = u16(f, off);
            if (len < 7 || len > 261 || off + 2 + len > f.length) throw new FormatException("Payload record " + i + " has a bad length.");
            byte[] a = new byte[len];
            System.arraycopy(f, off + 2, a, 0, len);
            off += 2 + len;
            if ((a[0] & 0xff) != 0xF0 || (a[1] & 0xff) != 0xD3 || a[2] != 0)
                throw new FormatException("Payload record " + i + " isn't an image-data command.");
            if ((a[4] & 0xff) != len - 5) throw new FormatException("Payload record " + i + " has a bad length byte.");
            int p2 = a[3] & 0xff, blk = a[5] & 0xff, frag = a[6] & 0xff;
            if (p2 > 1) throw new FormatException("Payload record " + i + " has a bad flag.");
            if (Boolean.TRUE.equals(closed.get(blk))) throw new FormatException("Block " + blk + " continues after its last fragment.");
            int expect = nextFrag.getOrDefault(blk, 0);
            if (frag != expect) throw new FormatException("Block " + blk + " fragments are out of order.");
            nextFrag.put(blk, expect + 1);
            if (p2 == 1) closed.put(blk, true);
            blocks.computeIfAbsent(blk, k -> new ByteArrayOutputStream()).write(a, 7, len - 7);
            apdus.add(a);
        }
        if (off != f.length) throw new FormatException("Payload has extra data at the end.");

        int total = w * h * bpp / 8;
        ByteArrayOutputStream packed = new ByteArrayOutputStream(total);
        int expectBlock = 0;
        for (Map.Entry<Integer, ByteArrayOutputStream> e : blocks.entrySet()) {
            int blk = e.getKey();
            if (blk != expectBlock++) throw new FormatException("Image block " + (expectBlock - 1) + " is missing.");
            if (!Boolean.TRUE.equals(closed.get(blk))) throw new FormatException("Block " + blk + " has no final fragment.");
            int want = Math.min(BLOCK, total - packed.size());
            if (want <= 0) throw new FormatException("Payload has more image data than the panel holds.");
            byte[] raw = Lzo1x.decompress(e.getValue().toByteArray(), want);
            if (raw.length != want) throw new FormatException("Image block " + blk + " has the wrong size.");
            packed.write(raw, 0, raw.length);
        }
        if (packed.size() != total) throw new FormatException("Image data doesn't fill the panel.");
        return new Ezs(w, h, bpp, apdus, unpack(packed.toByteArray(), w, h, bpp), f.length);
    }

    /** Rows are packed right to left: byte k holds the pixels starting at x = (bytesPerRow - 1 - k) * ppb. */
    static byte[] unpack(byte[] packed, int w, int h, int bpp) {
        int ppb = 8 / bpp, bpr = w / ppb, mask = (1 << bpp) - 1;
        byte[] px = new byte[w * h];
        for (int y = 0; y < h; y++)
            for (int k = 0; k < bpr; k++) {
                int b = packed[y * bpr + k] & 0xff, base = (bpr - 1 - k) * ppb;
                for (int i = 0; i < ppb; i++) px[y * w + base + i] = (byte) ((b >> (bpp * i)) & mask);
            }
        return px;
    }

    static int u16(byte[] b, int o) { return (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8); }

    public static final class FormatException extends IOException {
        private static final long serialVersionUID = 1L;
        public FormatException(String m) { super(m); }
    }

    /** LZO1X decompressor (format per lzo1x_d.ch); bounds-checked, output capped at maxOut. */
    static final class Lzo1x {
        static byte[] decompress(byte[] src, int maxOut) throws FormatException {
            byte[] out = new byte[maxOut];
            int[] st = {0, 0}; // ip, op
            try {
                int t;
                String state;
                if ((src[0] & 0xff) > 17) {
                    t = (src[st[0]++] & 0xff) - 17;
                    lits(src, st, out, t);
                    if (t < 4) { t = src[st[0]++] & 0xff; state = "match"; } else state = "first";
                } else { t = 0; state = "loop"; }
                for (;;) {
                    if (state.equals("loop")) {
                        t = src[st[0]++] & 0xff;
                        if (t >= 16) { state = "match"; continue; }
                        if (t == 0) t = ext(src, st, 15);
                        lits(src, st, out, t + 3);
                        state = "first";
                        continue;
                    }
                    if (state.equals("first")) {
                        t = src[st[0]++] & 0xff;
                        if (t >= 16) { state = "match"; continue; }
                        copy(out, st, 1 + 0x0800 + (t >> 2) + ((src[st[0]++] & 0xff) << 2), 3);
                    } else if (t >= 64) {
                        copy(out, st, 1 + ((t >> 2) & 7) + ((src[st[0]++] & 0xff) << 3), (t >> 5) + 1);
                    } else if (t >= 32) {
                        int len = t & 31;
                        if (len == 0) len = ext(src, st, 31);
                        int d = 1 + ((src[st[0]] & 0xff) >> 2) + ((src[st[0] + 1] & 0xff) << 6);
                        st[0] += 2;
                        copy(out, st, d, len + 2);
                    } else if (t >= 16) {
                        int d = (t & 8) << 11, len = t & 7;
                        if (len == 0) len = ext(src, st, 7);
                        d += ((src[st[0]] & 0xff) >> 2) + ((src[st[0] + 1] & 0xff) << 6);
                        st[0] += 2;
                        if (d == 0) { // end of stream
                            byte[] r = new byte[st[1]];
                            System.arraycopy(out, 0, r, 0, st[1]);
                            return r;
                        }
                        copy(out, st, d + 0x4000, len + 2);
                    } else {
                        copy(out, st, 1 + (t >> 2) + ((src[st[0]++] & 0xff) << 2), 2);
                    }
                    t = src[st[0] - 2] & 3;
                    if (t == 0) { state = "loop"; continue; }
                    lits(src, st, out, t);
                    t = src[st[0]++] & 0xff;
                    state = "match";
                }
            } catch (ArrayIndexOutOfBoundsException e) {
                throw new FormatException("Image data is corrupt.");
            }
        }

        private static int ext(byte[] src, int[] st, int base) {
            int t = 0;
            while (src[st[0]] == 0) { t += 255; st[0]++; if (t > 1 << 20) throw new ArrayIndexOutOfBoundsException(); }
            return t + base + (src[st[0]++] & 0xff);
        }

        private static void lits(byte[] src, int[] st, byte[] out, int n) {
            System.arraycopy(src, st[0], out, st[1], n); // throws AIOOBE when out of bounds
            st[0] += n; st[1] += n;
        }

        private static void copy(byte[] out, int[] st, int dist, int len) {
            int p = st[1] - dist;
            if (p < 0 || st[1] + len > out.length) throw new ArrayIndexOutOfBoundsException();
            for (int i = 0; i < len; i++) out[st[1]++] = out[p++];
        }
    }
}
