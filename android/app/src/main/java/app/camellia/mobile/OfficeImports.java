package app.camellia.mobile;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/** Owns short-lived compressed originals in the app's private Office cache. */
final class OfficeImports {
    static final String DIRECTORY = "office-imports";
    private static final Set<File> active = ConcurrentHashMap.newKeySet();
    private static final Pattern NAME = Pattern.compile("import-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.zip");
    private OfficeImports() {}

    static Staged stage(File directory, InputStream input) throws IOException {
        OfficeDocument.checkInterrupted(); Files.createDirectories(directory.toPath());
        Staged staged = new Staged(new File(directory.getAbsoluteFile(), "import-" + UUID.randomUUID() + ".zip"));
        active.add(staged.file); boolean complete = false;
        try {
            try (OutputStream output = Files.newOutputStream(staged.file.toPath())) {
                byte[] buffer = new byte[32768]; int total = 0, count;
                while (true) {
                    OfficeDocument.checkInterrupted(); count = input.read(buffer); OfficeDocument.checkInterrupted(); if (count == -1) break;
                    if (count > OfficeDocument.MAX_FILE - total) throw new IOException("单个文档不能超过 10 MiB / Document exceeds 10 MiB");
                    output.write(buffer, 0, count); total += count;
                }
                if (total == 0) throw new IOException("文档为空 / Document is empty");
            }
            complete = true; return staged;
        } finally { if (!complete) staged.close(); }
    }

    static int cleanup(File directory) throws IOException {
        if (!directory.exists()) return 0;
        int removed = 0;
        try (DirectoryStream<Path> files = Files.newDirectoryStream(directory.toPath())) {
            for (Path path : files) {
                if (NAME.matcher(path.getFileName().toString()).matches() && !active.contains(path.toFile().getAbsoluteFile())
                    && Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) && Files.deleteIfExists(path)) removed++;
            }
        }
        return removed;
    }

    static final class Staged implements AutoCloseable {
        final File file;
        private Staged(File file) { this.file = file; }
        @Override public void close() throws IOException {
            try { Files.deleteIfExists(file.toPath()); } finally { active.remove(file); }
        }
    }
}
