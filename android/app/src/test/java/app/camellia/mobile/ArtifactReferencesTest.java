package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class ArtifactReferencesTest {
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
