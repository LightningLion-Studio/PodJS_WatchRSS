import com.android.apksig.ApkVerifier;
import com.android.apksig.SigningCertificateLineage;
import java.io.File;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.HexFormat;
import java.util.List;

/** Read only public certificates in an APK; never opens signing keys/properties. */
class ApkPublicInfo {
    static String digest(X509Certificate cert) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()));
    }
    static String certificates(List<X509Certificate> certificates) throws Exception {
        StringBuilder out = new StringBuilder("[");
        for (X509Certificate cert : certificates) {
            if (out.length() > 1) out.append(',');
            out.append('"').append(digest(cert)).append('"');
        }
        return out.append(']').toString();
    }
    public static void main(String[] args) throws Exception {
        File apk = new File(args[0]);
        // Verify the full manifest SDK range AND the actual watch SDK signer.
        ApkVerifier.Result full = new ApkVerifier.Builder(apk).build().verify();
        int sdk = Integer.parseInt(args[1]);
        ApkVerifier.Result watch = new ApkVerifier.Builder(apk)
            .setMinCheckedPlatformVersion(sdk).setMaxCheckedPlatformVersion(sdk).build().verify();
        SigningCertificateLineage lineage = full.getSigningCertificateLineage();
        StringBuilder entries = new StringBuilder("[");
        if (lineage != null) for (X509Certificate cert : lineage.getCertificatesInLineage()) {
            if (entries.length() > 1) entries.append(',');
            entries.append("{\"sha256\":\"").append(digest(cert))
                .append("\",\"installedData\":").append(lineage.getSignerCapabilities(cert).hasInstalledData())
                .append('}');
        }
        System.out.println("{\"verified\":" + (full.isVerified() && watch.isVerified())
            + ",\"v3\":" + (full.isVerifiedUsingV3Scheme() || full.isVerifiedUsingV31Scheme())
            + ",\"certificatesSha256\":" + certificates(full.getSignerCertificates())
            + ",\"watchCertificatesSha256\":" + certificates(watch.getSignerCertificates())
            + ",\"lineage\":" + entries.append(']') + "}");
    }
}
