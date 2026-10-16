import io.github.shesk.ezsign.Ezs;
import io.github.shesk.ezsign.SignProtocol;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * JVM tests for the app's pure-Java core (no Android needed):
 *   java Tests <repo>/tests/fixtures
 * Covers .ezs parsing/validation against reference payloads, and the NFC conversation against
 * a simulated EZ Sign, a simulated bank card, and failure cases.
 */
public class Tests {
    static int checks = 0, failures = 0;
    static void check(boolean ok, String what) { checks++; if (!ok) { failures++; System.err.println("FAIL: " + what); } }

    public static void main(String[] args) throws Exception {
        Path fx = Path.of(args[0]);

        // 1. Reference payloads (made by nfc-eink, known to work on hardware) parse and decode to the expected pixels.
        for (String name : new String[] {"ref_flat", "ref_dither"}) {
            Ezs e = Ezs.parse(Files.readAllBytes(fx.resolve(name + ".ezs")));
            byte[] want = Files.readAllBytes(fx.resolve(name + ".idx"));
            check(e.width == 400 && e.height == 300 && e.bpp == 2, name + " header");
            check(Arrays.equals(e.pixels, want), name + " decoded pixels match reference");
            check(e.maxApduLength() <= 257, name + " APDUs fit 257 bytes");
        }

        // 2. Malformed files are rejected with a message, never a crash.
        byte[] good = Files.readAllBytes(fx.resolve("ref_flat.ezs"));
        List<byte[]> bad = new ArrayList<>();
        bad.add(new byte[0]);
        bad.add("hello world, not a payload".getBytes());
        bad.add(Arrays.copyOf(good, good.length - 1));                 // truncated
        bad.add(Arrays.copyOf(good, good.length + 1));                 // trailing byte
        byte[] badMagic = good.clone(); badMagic[0] = 'X'; bad.add(badMagic);
        byte[] badIns = good.clone(); badIns[12 + 2 + 1] = (byte) 0x20; bad.add(badIns); // first APDU INS -> 20 (VERIFY)
        byte[] badLzo = good.clone(); for (int i = 12 + 2 + 7; i < 12 + 2 + 20; i++) badLzo[i] = (byte) 0xFF; bad.add(badLzo);
        byte[] badCount = good.clone(); badCount[10] = (byte) 0xFF; bad.add(badCount);
        java.util.Random rnd = new java.util.Random(42);
        for (int i = 0; i < 300; i++) { byte[] f = good.clone(); f[12 + rnd.nextInt(f.length - 12)] = (byte) rnd.nextInt(256); bad.add(f); }
        int rejected = 0, crashed = 0;
        for (byte[] f : bad) {
            try { Ezs.parse(f); } catch (Ezs.FormatException e) { rejected++; } catch (RuntimeException e) { crashed++; System.err.println("crash: " + e); }
        }
        check(crashed == 0, "no crashes on malformed input (" + crashed + ")");
        check(rejected >= 8, "obviously bad files rejected (" + rejected + "/" + bad.size() + ")");
        try { Ezs.readLimited(new java.io.ByteArrayInputStream(new byte[60_000])); check(false, "oversize stream rejected"); }
        catch (Ezs.FormatException e) { check(true, ""); }

        Ezs payload = Ezs.parse(good);

        // 3. Happy path against a simulated sign: full image arrives in order, refresh polled to completion.
        FakeSign sign = new FakeSign();
        Rec rec = new Rec();
        new SignProtocol(sign, rec, sign.clock).write(payload);
        check(sign.select && sign.infoBeforeAuth && sign.authed, "select, info, then auth");
        check(sign.received.size() == payload.apdus.size(), "all image APDUs delivered");
        for (int i = 0; i < payload.apdus.size(); i++) check(Arrays.equals(sign.received.get(i), payload.apdus.get(i)), "APDU " + i + " intact");
        check(sign.refreshed && sign.polls >= 3, "refresh started and polled until done (" + sign.polls + " polls)");
        check(rec.sent == payload.apdus.size() && rec.identified, "progress reported");

        // 4. Bank card: rejects the EZ Sign app ID. Must never receive VERIFY (00 20) or anything after SELECT.
        BankCard card = new BankCard();
        try { new SignProtocol(card, new Rec(), new FakeClock()).write(payload); check(false, "bank card must be rejected"); }
        catch (SignProtocol.SignException e) { check(!e.retryable, "bank card rejection not retryable"); }
        check(card.log.size() == 1 && (card.log.get(0)[1] & 0xff) == 0xA4, "bank card only saw SELECT");
        for (byte[] a : card.log) check((a[1] & 0xff) != 0x20, "VERIFY never sent to bank card");

        // 5. A card that accepts the app ID but isn't a sign (e.g. an NDEF tag): stop before VERIFY.
        FakeSign ndef = new FakeSign(); ndef.infoSw = 0x6D00;
        try { new SignProtocol(ndef, new Rec(), ndef.clock).write(payload); check(false, "non-sign rejected"); }
        catch (SignProtocol.SignException e) { check(!ndef.authed && ndef.received.isEmpty(), "nothing written to non-sign"); }

        // 6. Panel mismatch (2-color sign, 4-color image): refuse before unlocking.
        FakeSign bw = new FakeSign(); bw.mode = 0x47;
        try { new SignProtocol(bw, new Rec(), bw.clock).write(payload); check(false, "mismatch rejected"); }
        catch (SignProtocol.SignException e) { check(!bw.authed && e.getMessage().contains("2 colors"), "mismatch message, no unlock"); }

        // 7. Tag lost mid-transfer surfaces as an IOException (app keeps listening and retries).
        FakeSign lost = new FakeSign(); lost.dropAfterImageApdus = 5;
        try { new SignProtocol(lost, new Rec(), lost.clock).write(payload); check(false, "tag loss surfaces"); }
        catch (SignProtocol.SignException e) { check(false, "tag loss should be a plain IOException"); }
        catch (IOException e) { check(lost.received.size() == 5, "stopped at the drop"); }

        // 8. Refresh never completes: times out after a minute with a retryable error.
        FakeSign slow = new FakeSign(); slow.pollsUntilDone = Integer.MAX_VALUE;
        try { new SignProtocol(slow, new Rec(), slow.clock).write(payload); check(false, "timeout"); }
        catch (SignProtocol.SignException e) { check(e.retryable && slow.clock.t >= 60_000, "refresh timeout after 60 s"); }

        System.out.println((checks - failures) + "/" + checks + " checks passed");
        System.exit(failures == 0 ? 0 : 1);
    }

    static final class Rec implements SignProtocol.Listener {
        boolean identified; int sent;
        public void onIdentified(SignProtocol.DeviceInfo d) { identified = true; }
        public void onSending(int done, int total) { sent = done; }
        public void onRefreshing(long ms) {}
    }

    static final class FakeClock implements SignProtocol.Clock {
        long t = 0;
        public long now() { return t; }
        public void sleep(long ms) { t += ms; }
    }

    static byte[] resp(int sw, byte... data) {
        byte[] r = Arrays.copyOf(data, data.length + 2);
        r[data.length] = (byte) (sw >> 8); r[data.length + 1] = (byte) sw;
        return r;
    }

    /** Simulated Santek EZ Sign 4.2" 4-color. */
    static final class FakeSign implements SignProtocol.Link {
        final FakeClock clock = new FakeClock();
        boolean select, authed, infoBeforeAuth, refreshed;
        int infoSw = 0x9000, mode = 0x07, polls = 0, pollsUntilDone = 3, dropAfterImageApdus = -1;
        final List<byte[]> received = new ArrayList<>();
        public byte[] transceive(byte[] a) throws IOException {
            int cla = a[0] & 0xff, ins = a[1] & 0xff;
            if (cla == 0x00 && ins == 0xA4) {
                byte[] aid = Arrays.copyOfRange(a, 5, 5 + (a[4] & 0xff));
                select = Arrays.equals(aid, new byte[] {(byte) 0xD2, 0x76, 0, 0, (byte) 0x85, 1, 1});
                return resp(select ? 0x9000 : 0x6A82);
            }
            if (!select) return resp(0x6985);
            if (cla == 0x00 && ins == 0xD1) {
                if (infoSw != 0x9000) return resp(infoSw);
                if (!authed) infoBeforeAuth = true;
                int bpp = mode == 0x07 ? 2 : 1;
                int hr = 300 * bpp;
                byte[] info = {(byte) 0xA0, 7, 0, (byte) mode, 20, (byte) (hr >> 8), (byte) hr, 0x01, (byte) 0x90,
                        (byte) 0xC0, 10, 'S', 'E', 'A', 'A', '0', '0', '0', '2', '8', '2'};
                return resp(0x9000, info);
            }
            if (cla == 0x00 && ins == 0x20) { authed = Arrays.equals(a, new byte[] {0, 0x20, 0, 1, 4, 0x20, 9, 0x12, 0x10}); return resp(authed ? 0x9000 : 0x63C0); }
            if (!authed) return resp(0x6982);
            if (cla == 0xF0 && ins == 0xD3) {
                if (dropAfterImageApdus >= 0 && received.size() == dropAfterImageApdus) throw new IOException("Tag was lost.");
                received.add(a.clone()); return resp(0x9000);
            }
            if (cla == 0xF0 && ins == 0xD4) { refreshed = true; return resp(0x9000); }
            if (cla == 0xF0 && ins == 0xDE) { polls++; return resp(0x9000, (byte) (polls >= pollsUntilDone ? 0 : 1)); }
            return resp(0x6D00);
        }
    }

    /** Simulated EMV payment card: only knows payment AIDs. Logs everything it receives. */
    static final class BankCard implements SignProtocol.Link {
        final List<byte[]> log = new ArrayList<>();
        public byte[] transceive(byte[] a) {
            log.add(a.clone());
            if ((a[1] & 0xff) == 0xA4) return resp(0x6A82); // file/application not found
            return resp(0x6D00);
        }
    }
}
