package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public final class AuthenticatedInputStreamTest {
    private static final SecretKeySpec KEY = new SecretKeySpec(new byte[32], "AES");
    private static Cipher cipher(int mode) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(mode, KEY, new GCMParameterSpec(128, new byte[12]));
        cipher.updateAAD("camellia.attachments.v1".getBytes(java.nio.charset.StandardCharsets.UTF_8)); return cipher;
    }
    @Test public void existingGcmBytesRemainReadableAcrossFileAndCallerChunkBoundaries() throws Exception {
        Random random = new Random(43127);
        for (int size : new int[]{0, 1, 65519, 65520, 65536, 65537, 200001}) {
            byte[] bytes = new byte[size]; random.nextBytes(bytes); byte[] encrypted = cipher(Cipher.ENCRYPT_MODE).doFinal(bytes);
            AtomicInteger received = new AtomicInteger(); AtomicBoolean closed = new AtomicBoolean();
            InputStream source = new ByteArrayInputStream(encrypted) {
                @Override public synchronized int read(byte[] target, int offset, int length) { int count = super.read(target, offset, Math.min(length, 97)); if (count > 0) received.addAndGet(count); return count; }
                @Override public void close() { closed.set(true); }
            };
            try (InputStream input = new AuthenticatedInputStream(source, cipher(Cipher.DECRYPT_MODE), size)) {
                assertEquals(0, received.get()); ByteArrayOutputStream result = new ByteArrayOutputStream(); byte[] buffer = new byte[113]; int count;
                while ((count = input.read(buffer)) != -1) {
                    assertEquals(encrypted.length, received.get()); assertTrue(closed.get()); result.write(buffer, 0, count);
                }
                assertArrayEquals(bytes, result.toByteArray());
            }
        }
    }
    @Test public void invalidAuthenticationExposesNoPlaintextAndClosesSource() throws Exception {
        byte[] encrypted = cipher(Cipher.ENCRYPT_MODE).doFinal(new byte[131071]); encrypted[encrypted.length - 1] ^= 1;
        AtomicBoolean closed = new AtomicBoolean();
        InputStream source = new ByteArrayInputStream(encrypted) { @Override public void close() { closed.set(true); } };
        try (InputStream input = new AuthenticatedInputStream(source, cipher(Cipher.DECRYPT_MODE), 131071)) {
            try { input.read(); fail("Unauthenticated data was exposed"); } catch (IOException expected) { assertTrue(expected.getMessage().contains("authenticate")); }
            assertTrue(closed.get());
        }
    }
    @Test public void wrongExpectedLengthFailsAndCancelledReadsReleaseTheirSource() throws Exception {
        byte[] encrypted = cipher(Cipher.ENCRYPT_MODE).doFinal(new byte[100]);
        for (int expected : new int[]{99, 101}) try (InputStream input = new AuthenticatedInputStream(new ByteArrayInputStream(encrypted), cipher(Cipher.DECRYPT_MODE), expected)) {
            try { input.read(); fail("Changed length accepted"); } catch (IOException rejected) { }
        }
        CountDownLatch reading = new CountDownLatch(1), close = new CountDownLatch(1);
        InputStream source = new InputStream() {
            @Override public int read() throws IOException { throw new IOException(); }
            @Override public int read(byte[] target, int offset, int length) throws IOException {
                reading.countDown();
                try { if (!close.await(3, TimeUnit.SECONDS)) throw new IOException("still blocked"); } catch (InterruptedException error) { throw new IOException(error); }
                throw new IOException("closed");
            }
            @Override public void close() { close.countDown(); }
        };
        InputStream input = new AuthenticatedInputStream(source, cipher(Cipher.DECRYPT_MODE), 100); ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<?> done = worker.submit(() -> { try { input.read(); fail(); } catch (IOException expected) { assertEquals("closed", expected.getMessage()); } });
            assertTrue(reading.await(1, TimeUnit.SECONDS)); input.close(); done.get(1, TimeUnit.SECONDS);
        } finally { input.close(); worker.shutdownNow(); }
    }
}
