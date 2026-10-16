package io.github.shesk.ezsign;

import java.io.IOException;

/**
 * Talks to a Santek EZ Sign over ISO 7816 APDUs. Pure Java (no Android APIs) so it is unit-tested on a JVM
 * against simulated tags.
 *
 * Order matters for safety. The sign's unlock command (00 20 ...) uses the standard VERIFY PIN
 * instruction, so it must never reach a bank card or other smart card held near the phone. Before
 * unlocking, the tag has to:
 *   1. accept SELECT of application D2760000850101 (bank/transit cards reject it), and
 *   2. answer the read-only device-info command with a panel description that matches the payload.
 * Only then is the unlock sent, followed by the image, then a non-blocking refresh that is polled
 * until the panel reports it is finished.
 */
public final class SignProtocol {

    /** One request/response exchange with the tag (IsoDep.transceive on Android). */
    public interface Link {
        byte[] transceive(byte[] apdu) throws IOException;
    }

    public interface Listener {
        void onIdentified(DeviceInfo info);
        void onSending(int done, int total);
        void onRefreshing(long elapsedMs);
    }

    public interface Clock {
        long now();
        void sleep(long ms) throws InterruptedException;
    }

    public static final Clock SYSTEM_CLOCK = new Clock() {
        public long now() { return System.currentTimeMillis(); }
        public void sleep(long ms) throws InterruptedException { Thread.sleep(ms); }
    };

    static final byte[] SELECT = hex("00A4040007D276000085010100");
    static final byte[] INFO = hex("00D1000000");
    static final byte[] AUTH = hex("002000010420091210");
    static final byte[] REFRESH = hex("F0D4858000"); // P2=80: return immediately, then poll
    static final byte[] POLL = hex("F0DE000001");
    static final long REFRESH_TIMEOUT_MS = 60_000, POLL_INTERVAL_MS = 500;

    public static final class DeviceInfo {
        public final int width, height, bpp;
        public final String serial;
        DeviceInfo(int w, int h, int bpp, String serial) { width = w; height = h; this.bpp = bpp; this.serial = serial; }
        public int colors() { return 1 << bpp; }
    }

    /** Problem the user can act on; the message is shown as-is. */
    public static final class SignException extends IOException {
        private static final long serialVersionUID = 1L;
        public final boolean retryable;
        public SignException(String m, boolean retryable) { super(m); this.retryable = retryable; }
    }

    private final Link link;
    private final Listener listener;
    private final Clock clock;
    private volatile boolean cancelled;

    public SignProtocol(Link link, Listener listener, Clock clock) {
        this.link = link; this.listener = listener; this.clock = clock;
    }

    public void cancel() { cancelled = true; }

    /** Identifies the tag without changing anything on it. */
    public DeviceInfo identify() throws IOException {
        Resp sel = send(SELECT);
        if (sel.sw != 0x9000)
            throw new SignException("That isn't an EZ Sign (it didn't accept the EZ Sign app ID, status "
                    + swHex(sel.sw) + "). Nothing was sent to it.", false);
        Resp info = send(INFO);
        if (info.sw != 0x9000)
            throw new SignException("That isn't an EZ Sign (device info refused, status " + swHex(info.sw)
                    + "). Nothing was sent to it.", false);
        DeviceInfo d = parseInfo(info.data);
        if (d == null) throw new SignException("That isn't an EZ Sign (unrecognized device info). Nothing was sent to it.", false);
        return d;
    }

    /** Identify, check the payload fits this panel, unlock, send the image, refresh and wait. */
    public void write(Ezs payload) throws IOException, InterruptedException {
        DeviceInfo d = identify();
        listener.onIdentified(d);
        if (d.width != payload.width || d.height != payload.height || d.bpp != payload.bpp)
            throw new SignException("This sign is " + d.width + "×" + d.height + " with " + d.colors()
                    + " colors, but the image was made for " + payload.width + "×" + payload.height + " with "
                    + (1 << payload.bpp) + " colors. Nothing was written.", false);

        Resp auth = send(AUTH);
        if (auth.sw != 0x9000) throw new SignException("The sign refused the unlock command (status " + swHex(auth.sw) + ").", false);

        int total = payload.apdus.size();
        for (int i = 0; i < total; i++) {
            checkCancel();
            Resp r = send(payload.apdus.get(i));
            if (r.sw != 0x9000)
                throw new SignException("The sign rejected image part " + (i + 1) + " of " + total
                        + " (status " + swHex(r.sw) + "). Hold it again to retry.", true);
            listener.onSending(i + 1, total);
        }

        Resp ref = send(REFRESH);
        if (ref.sw != 0x9000) throw new SignException("The sign wouldn't start refreshing (status " + swHex(ref.sw) + ").", true);

        long start = clock.now();
        while (clock.now() - start < REFRESH_TIMEOUT_MS) {
            clock.sleep(POLL_INTERVAL_MS);
            listener.onRefreshing(clock.now() - start);
            Resp p;
            try {
                p = send(POLL);
            } catch (IOException e) {
                throw new SignException("Lost contact while the sign was refreshing. Hold the phone still on the sign "
                        + "and it will rewrite the image.", true);
            }
            if (p.data.length >= 1 && p.data[0] == 0x00) return; // refresh complete
        }
        throw new SignException("The sign didn't finish refreshing within a minute. Hold it again to retry.", true);
    }

    private void checkCancel() throws InterruptedException {
        if (cancelled || Thread.currentThread().isInterrupted()) throw new InterruptedException();
    }

    static DeviceInfo parseInfo(byte[] d) {
        int width = 0, heightRaw = 0, mode = -1;
        String serial = "";
        for (int off = 0; off + 2 <= d.length; ) {
            int tag = d[off] & 0xff, len = d[off + 1] & 0xff;
            off += 2;
            if (off + len > d.length) break;
            if (tag == 0xA0 && len >= 7) {
                mode = d[off + 1] & 0xff;
                heightRaw = ((d[off + 3] & 0xff) << 8) | (d[off + 4] & 0xff);
                width = ((d[off + 5] & 0xff) << 8) | (d[off + 6] & 0xff);
            } else if (tag == 0xC0) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < len; i++) {
                    int c = d[off + i] & 0xff;
                    sb.append(c >= 0x20 && c < 0x7f ? (char) c : '?');
                }
                serial = sb.toString();
            }
            off += len;
        }
        int bpp = mode == 0x07 ? 2 : (mode == 0x01 || mode == 0x47) ? 1 : 0;
        if (bpp == 0 || width == 0 || heightRaw == 0) return null;
        int height = heightRaw / bpp;
        if (width < height) { int t = width; width = height; height = t; }
        return new DeviceInfo(width, height, bpp, serial);
    }

    private static final class Resp {
        final byte[] data; final int sw;
        Resp(byte[] data, int sw) { this.data = data; this.sw = sw; }
    }

    private Resp send(byte[] apdu) throws IOException {
        byte[] r = link.transceive(apdu);
        if (r == null || r.length < 2) throw new IOException("short response");
        byte[] data = new byte[r.length - 2];
        System.arraycopy(r, 0, data, 0, data.length);
        return new Resp(data, ((r[r.length - 2] & 0xff) << 8) | (r[r.length - 1] & 0xff));
    }

    static String swHex(int sw) { return String.format("%04X", sw); }

    static byte[] hex(String s) {
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }
}
