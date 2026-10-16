package io.github.shesk.ezsign;

import android.app.Activity;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.TagLostException;
import android.nfc.tech.IsoDep;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.database.Cursor;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * One screen: shows the received sign image, then writes it when you tap Write and hold the phone on the sign.
 * NFC reader mode is only enabled between tapping Write and finishing (or cancelling), and only while this
 * screen is in the foreground, so the app never reacts to tags at any other time.
 */
public class MainActivity extends Activity implements NfcAdapter.ReaderCallback {
    private static final int REQ_OPEN = 1;
    // How each ink looks on the panel (matches EZ Sign Studio's preview).
    private static final int[] SHOW = {
            Color.rgb(29, 27, 27), Color.rgb(233, 231, 226), Color.rgb(229, 179, 12), Color.rgb(181, 40, 28)};
    private static final int RED = Color.rgb(179, 38, 30);

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private NfcAdapter nfc;
    private volatile Ezs payload;
    // Raw file bytes and name of the loaded payload, saved across activity re-creation (<= 48 KB).
    private byte[] payloadBytes;
    private String payloadName;
    private static final String KEY_BYTES = "ezs.bytes", KEY_NAME = "ezs.name";
    private volatile SignProtocol current;
    private volatile boolean listening;

    private TextView meta, status;
    private ImageView preview;
    private ProgressBar bar;
    private Button writeBtn, openBtn, settingsBtn;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        nfc = NfcAdapter.getDefaultAdapter(this);
        buildUi();
        byte[] kept = saved == null ? null : saved.getByteArray(KEY_BYTES);
        if (kept != null) {
            // Re-created (e.g. dark mode switch or the system reclaimed memory): restore the loaded image
            // instead of re-reading the shared file, whose one-time access may have expired.
            try { showPayload(Ezs.parse(kept), kept, saved.getString(KEY_NAME, "Sign")); }
            catch (Ezs.FormatException e) { showEmpty(null); }
        } else {
            handleIntent(getIntent());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        stopListening();
        handleIntent(intent);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (payloadBytes != null) {
            out.putByteArray(KEY_BYTES, payloadBytes);
            out.putString(KEY_NAME, payloadName);
        }
    }

    // Rotation and window resizes are handled here (see configChanges in the manifest) instead of
    // re-creating the activity, so an in-progress write isn't interrupted when the phone turns.
    @Override
    public void onConfigurationChanged(android.content.res.Configuration c) {
        super.onConfigurationChanged(c);
        fitPreview();
    }

    /** Keep the preview from pushing the controls off screen in landscape. */
    private void fitPreview() {
        preview.setMaxHeight((int) (getResources().getDisplayMetrics().heightPixels * 0.5f));
    }

    @Override
    protected void onResume() {
        super.onResume();
        settingsBtn.setVisibility(nfc != null && !nfc.isEnabled() ? View.VISIBLE : View.GONE);
        if (payload == null) return;
        if (nfc == null) setStatus("This phone doesn't have NFC.");
        else if (!nfc.isEnabled()) setStatus("NFC is turned off. Turn it on to write to the sign.");
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (listening) {
            stopListening();
            setStatus("Stopped because the app left the screen. Tap Write to sign to try again.");
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        worker.shutdownNow();
    }

    /* ---------------- receiving a payload ---------------- */

    private void handleIntent(Intent intent) {
        Uri uri = null;
        String action = intent == null ? null : intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
            if (uri == null) { showEmpty("That share didn't include a file. Use Send to sign in EZ Sign Studio."); return; }
        } else if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        }
        if (uri == null) { if (payload == null) showEmpty(null); return; }
        load(uri);
    }

    private void load(Uri uri) {
        setStatus("Opening…");
        final String name = displayName(uri);
        worker.execute(() -> {
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) throw new IOException("Couldn't open the file.");
                byte[] raw = Ezs.readLimited(in);
                Ezs e = Ezs.parse(raw);
                runOnUiThread(() -> showPayload(e, raw, name));
            } catch (IOException | SecurityException ex) {
                runOnUiThread(() -> showEmpty(ex.getMessage()));
            }
        });
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null) return n.replaceAll("\\.txt$", "").replaceAll("\\.ezs$", "");
            }
        } catch (RuntimeException ignored) { }
        return "Sign";
    }

    private void showEmpty(String why) {
        payload = null;
        payloadBytes = null;
        payloadName = null;
        preview.setVisibility(View.GONE);
        meta.setText("No image loaded");
        setStatus(why != null ? why
                : "In EZ Sign Studio, tap Send to sign and choose EZ Sign Writer. Or open a saved .ezs file.");
        writeBtn.setEnabled(false);
        bar.setVisibility(View.GONE);
    }

    private void showPayload(Ezs e, byte[] raw, String name) {
        payload = e;
        payloadBytes = raw;
        payloadName = name;
        int[] colors = new int[e.pixels.length];
        for (int i = 0; i < colors.length; i++) colors[i] = SHOW[e.pixels[i] & 3];
        Bitmap bmp = Bitmap.createBitmap(colors, e.width, e.height, Bitmap.Config.ARGB_8888);
        BitmapDrawable d = new BitmapDrawable(getResources(), bmp);
        d.setFilterBitmap(false); // keep the panel's pixels crisp when scaled up
        preview.setImageDrawable(d);
        preview.setVisibility(View.VISIBLE);
        meta.setText(name + "  ·  " + e.width + "×" + e.height + "  ·  " + (1 << e.bpp) + " colors  ·  "
                + e.apdus.size() + " NFC frames  ·  " + String.format(java.util.Locale.US, "%.1f KB", e.sizeBytes / 1024f));
        writeBtn.setEnabled(true);
        writeBtn.setText("Write to sign");
        bar.setVisibility(View.GONE);
        setStatus("Ready. Tap Write to sign, then hold your phone on the sign.");
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req == REQ_OPEN && result == RESULT_OK && data != null && data.getData() != null) {
            stopListening();
            load(data.getData());
        }
    }

    /* ---------------- writing ---------------- */

    private void startListening() {
        if (payload == null) return;
        if (nfc == null) { setStatus("This phone doesn't have NFC."); return; }
        if (!nfc.isEnabled()) { setStatus("NFC is turned off. Turn it on to write to the sign."); settingsBtn.setVisibility(View.VISIBLE); return; }
        Bundle opts = new Bundle();
        opts.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 5000);
        nfc.enableReaderMode(this, this, NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK, opts);
        listening = true;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        writeBtn.setText("Cancel");
        openBtn.setEnabled(false);
        bar.setVisibility(View.GONE);
        setStatus("Hold the middle of your phone's back flat on the center of the sign. "
                + "If nothing happens after a few seconds, slide it slowly.");
    }

    private void stopListening() {
        SignProtocol p = current;
        if (p != null) p.cancel();
        if (listening && nfc != null) {
            try { nfc.disableReaderMode(this); } catch (RuntimeException ignored) { }
        }
        listening = false;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (writeBtn != null) { writeBtn.setText("Write to sign"); writeBtn.setEnabled(payload != null); }
        if (openBtn != null) openBtn.setEnabled(true);
    }

    @Override
    public void onTagDiscovered(Tag tag) { // NFC binder thread
        final Ezs p = payload;
        if (!listening || p == null || !busy.compareAndSet(false, true)) return;
        worker.execute(() -> {
            try { writeTo(tag, p); } finally { busy.set(false); }
        });
    }

    private void writeTo(Tag tag, Ezs p) {
        IsoDep iso = IsoDep.get(tag);
        if (iso == null) {
            ui(() -> { setStatus("That tag isn't an EZ Sign. Still listening — hold the phone on the sign."); haptic(false); });
            return;
        }
        try {
            iso.connect();
            iso.setTimeout(3000);
            if (iso.getMaxTransceiveLength() < p.maxApduLength())
                throw new SignProtocol.SignException("This phone's NFC can't send " + p.maxApduLength()
                        + "-byte commands (limit " + iso.getMaxTransceiveLength() + ").", false);
            ui(() -> setStatus("Found it. Hold still…"));
            SignProtocol proto = new SignProtocol(iso::transceive, new SignProtocol.Listener() {
                public void onIdentified(SignProtocol.DeviceInfo d) {
                    ui(() -> setStatus("Connected to " + (d.serial.isEmpty() ? "EZ Sign" : d.serial) + ". Sending…"));
                }
                public void onSending(int done, int total) {
                    ui(() -> {
                        bar.setVisibility(View.VISIBLE); bar.setIndeterminate(false);
                        bar.setMax(total); bar.setProgress(done);
                        setStatus("Sending image " + done + " / " + total + ". Hold still…");
                    });
                }
                public void onRefreshing(long ms) {
                    ui(() -> {
                        bar.setIndeterminate(true);
                        setStatus("Refreshing the display… " + (ms / 1000) + " s (takes about 30 s). Keep holding.");
                    });
                }
            }, SignProtocol.SYSTEM_CLOCK);
            current = proto;
            proto.write(p);
            ui(() -> {
                stopListening();
                bar.setVisibility(View.GONE);
                setStatus("Done. The sign has been updated — you can lift your phone.");
                haptic(true);
            });
        } catch (InterruptedException e) {
            ui(() -> setStatus("Cancelled."));
        } catch (SignProtocol.SignException e) {
            final String msg = e.getMessage();
            ui(() -> {
                bar.setVisibility(View.GONE);
                setStatus(msg + (listening ? "\n\nStill listening — hold the phone on the sign to try again." : ""));
                haptic(false);
            });
        } catch (TagLostException e) {
            ui(() -> {
                bar.setVisibility(View.GONE);
                setStatus("Lost contact with the sign. Hold the phone still on it and it will start over.");
                haptic(false);
            });
        } catch (IOException e) {
            ui(() -> {
                bar.setVisibility(View.GONE);
                setStatus("Couldn't talk to the sign (" + e.getMessage() + "). Hold it again to retry.");
                haptic(false);
            });
        } finally {
            current = null;
            try { iso.close(); } catch (IOException ignored) { }
        }
    }

    /* ---------------- UI ---------------- */

    private void ui(Runnable r) { runOnUiThread(r); }

    private void setStatus(String s) { status.setText(s); }

    private void haptic(boolean ok) {
        status.performHapticFeedback(ok ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.REJECT);
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setClipToPadding(false);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        scroll.addView(col);

        TextView title = new TextView(this);
        title.setText("EZ Sign Writer");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        title.setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD));
        col.addView(title);

        meta = new TextView(this);
        meta.setTypeface(Typeface.MONOSPACE);
        meta.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        meta.setAlpha(0.7f);
        col.addView(meta, lp(0, dp(4), 0, dp(14)));

        preview = new ImageView(this);
        preview.setAdjustViewBounds(true);
        preview.setMaxHeight((int) (getResources().getDisplayMetrics().heightPixels * 0.5f));
        preview.setScaleType(ImageView.ScaleType.FIT_CENTER);
        GradientDrawable bezel = new GradientDrawable();
        bezel.setColor(Color.rgb(18, 18, 20));
        bezel.setCornerRadius(dp(6));
        preview.setBackground(bezel);
        preview.setPadding(dp(10), dp(10), dp(10), dp(16));
        preview.setContentDescription("Preview of the image that will be written");
        col.addView(preview, lp(0, 0, 0, dp(16)));

        status = new TextView(this);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        status.setLineSpacing(0, 1.15f);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        col.addView(status, lp(0, 0, 0, dp(12)));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setVisibility(View.GONE);
        col.addView(bar, lp(0, 0, 0, dp(12)));

        writeBtn = new Button(this);
        writeBtn.setText("Write to sign");
        writeBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        writeBtn.setBackgroundTintList(ColorStateList.valueOf(RED));
        writeBtn.setTextColor(Color.WHITE);
        writeBtn.setMinHeight(dp(56));
        writeBtn.setOnClickListener(v -> { if (listening) { stopListening(); setStatus("Cancelled."); } else startListening(); });
        col.addView(writeBtn, lp(0, dp(4), 0, dp(8)));

        openBtn = new Button(this);
        openBtn.setText("Open a saved .ezs file…");
        openBtn.setOnClickListener(v -> {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            startActivityForResult(i, REQ_OPEN);
        });
        col.addView(openBtn, lp(0, 0, 0, dp(8)));

        settingsBtn = new Button(this);
        settingsBtn.setText("Open NFC settings");
        settingsBtn.setVisibility(View.GONE);
        settingsBtn.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_NFC_SETTINGS)));
        col.addView(settingsBtn, lp(0, 0, 0, dp(8)));

        TextView foot = new TextView(this);
        foot.setText("This app has no internet access. It only uses NFC, and only while you're writing.");
        foot.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        foot.setAlpha(0.65f);
        foot.setGravity(Gravity.START);
        col.addView(foot, lp(0, dp(16), 0, 0));

        // Edge-to-edge (enforced on Android 15+): pad content clear of the status/navigation bars and cutouts.
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            v.setPadding(pad + i.left, pad + i.top, pad + i.right, pad + i.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(scroll);
    }

    private LinearLayout.LayoutParams lp(int l, int t, int r, int b) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.setMargins(l, t, r, b);
        return p;
    }
}
