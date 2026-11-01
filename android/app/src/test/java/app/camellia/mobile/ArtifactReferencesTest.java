package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class ArtifactReferencesTest {
    @Test public void fileSelectionsPreservePathsInsteadOfMergingSameNameBuilds() {
        String text = "[New](<dist/new build/phone (release).apk>) [Old](dist/old/phone.apk) `docs/design.md:12`";
        assertEquals(java.util.List.of("dist/new build/phone (release).apk", "dist/old/phone.apk"), ArtifactReferences.paths(text));
        assertEquals(java.util.List.of("phone (release).apk", "phone.apk"), ArtifactReferences.names(text));
        assertEquals(java.util.List.of("old/phone.apk", "new/phone.apk"), ArtifactReferences.paths("`old/phone.apk` `new/phone.apk` `old/phone.apk`"));
        assertEquals("报告+新版.pdf", ArtifactReferences.name("out/%E6%8A%A5%E5%91%8A%2B%E6%96%B0%E7%89%88.pdf"));
    }
    @Test public void recognizesApkAndDocumentReferencesWithoutOfferingRemoteUrls() {
        assertEquals(java.util.List.of("Camellia-Android-0.3.37-debug.apk", "报告.pdf"), ArtifactReferences.names(
            "安装包：`dist/Camellia-Android-0.3.37-debug.apk` [报告](reports/报告.pdf) `https://example.com/secret.pdf`"));
    }
    @Test public void ignoresCodeFencesLineReferencesAndDuplicates() {
        assertEquals(java.util.List.of("report.pdf"), ArtifactReferences.names(
            "```\n`fake.apk`\n``` `report.pdf:12` `report.pdf` `report.pdf` `main.java`"));
        assertEquals(4, ArtifactReferences.names("`a.pdf` `b.pdf` `c.pdf` `d.pdf`").size());
        assertEquals(100, ArtifactReferences.names(java.util.stream.IntStream.range(0, 120)
            .mapToObj(index -> "`file" + index + ".pdf`").collect(java.util.stream.Collectors.joining(" "))).size());
    }
}
