package app.camellia.mobile;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** TLS for a LAN desktop, pinned to the certificate fingerprint learned from its authenticated record. */
final class LanTls {
    private static final Map<String, SSLSocketFactory> FACTORIES = new ConcurrentHashMap<>();

    private LanTls() {}

    static boolean validFingerprint(String fingerprint) {
        return fingerprint != null && fingerprint.matches("[a-fA-F0-9]{64}");
    }

    static String normalize(String fingerprint) {
        if (!validFingerprint(fingerprint)) throw new IllegalArgumentException("Invalid LAN certificate fingerprint");
        return fingerprint.toLowerCase(Locale.ROOT);
    }

    static SSLSocketFactory socketFactory(String fingerprint) {
        String normalized = normalize(fingerprint);
        return FACTORIES.computeIfAbsent(normalized, value -> {
            try {
                X509TrustManager pin = new X509TrustManager() {
                    @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                        throw new CertificateException("Client certificates are not accepted");
                    }
                    @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                        if (chain == null || chain.length == 0) throw new CertificateException("Missing LAN certificate");
                        byte[] digest;
                        try { digest = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()); }
                        catch (Exception error) {
                            CertificateException failure = new CertificateException("Cannot hash LAN certificate");
                            failure.initCause(error);
                            throw failure;
                        }
                        StringBuilder actual = new StringBuilder(64);
                        for (byte item : digest) actual.append(String.format(Locale.ROOT, "%02x", item));
                        if (!MessageDigest.isEqual(value.getBytes(java.nio.charset.StandardCharsets.US_ASCII),
                                actual.toString().getBytes(java.nio.charset.StandardCharsets.US_ASCII))) {
                            throw new CertificateException("LAN certificate changed; pair this computer again");
                        }
                    }
                    @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                };
                SSLContext context = SSLContext.getInstance("TLS");
                context.init(null, new TrustManager[]{pin}, new SecureRandom());
                return context.getSocketFactory();
            } catch (Exception error) {
                throw new IllegalStateException("Cannot prepare pinned LAN TLS", error);
            }
        });
    }
}
