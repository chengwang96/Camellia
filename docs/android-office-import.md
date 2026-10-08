# Android local Office imports

Local DOCX, XLSX and PPTX imports use `ZipFile` to open only the entries needed by the existing text extractor. DOCX reads `word/document.xml`; XLSX reads `xl/sharedStrings.xml` and numbered worksheets; PPTX reads numbered slides. Worksheets and slides retain numeric order, regardless of ZIP entry order. Remote chat continues to send the original document to the paired computer.

SAX character callbacks append directly to a bounded text builder. XML entries are not retained as byte arrays, converted to complete strings or extracted onto disk. Spreadsheet shared strings are the only document-wide parsed lookup table. Rich text runs are joined as before. Final output is materialized once.

## Limits and XML handling

The existing limits remain: a 10 MiB compressed original, 4,096 ZIP entries, 32 MiB of declared expansion across the entire archive and 2,000,000 UTF-16 code units of extracted output. Actual selected-entry reads have an additional aggregate 32 MiB bound and verify each entry's declared size and CRC. Ignored entries count toward the archive metadata budgets but are never inflated or CRC-checked. Corrupt irrelevant media therefore does not prevent text extraction. Selected duplicate names, missing DOCX bodies, malformed selected XML and invalid shared-string indices fail the import.

The shared-string table also has a 2,000,000-code-unit cumulative text budget and a 100,000-item limit, including empty items. A document exceeding either budget must be split; it is never silently truncated. These table limits can reject a spreadsheet with a small selected output but a much larger shared-string table.

DTD declarations are rejected by the SAX lexical handler before their contents are used; external general and parameter entities are disabled, and the entity resolver refuses external sources. The handler receives declarations after XML encoding detection, covering UTF-8 and UTF-16 without a full-string scan. Android's [Expat reader source](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/refs/heads/androidx-constraintlayout-release/android-35/org/apache/harmony/xml/ExpatReader.java) documents these supported SAX features and the lexical-handler property. Literal `DOCTYPE` text in comments or CDATA is accepted.

## Temporary file ownership

Random entry access requires a compressed original in the app's private `cache/office-imports` directory. Each import stages at most 10 MiB with a 32 KiB copy buffer. No expanded XML or media is written there. The temporary compressed original is unencrypted while owned by the import; successful persistent attachments and extracted text continue to use the existing encrypted store. Original-file reading and encrypted attachment saving still require a bounded whole-file buffer, so this change does not claim constant memory for the complete import pipeline.

An import owns its unique temporary file through writing and parsing. Normal completion, source errors, parse errors and thread interruption delete it in a `finally`/resource close. The process-wide attachment maintenance worker removes inactive files on initialization and daily sweeps; active imports are protected before file creation. Cleanup only recognizes the dedicated UUID filename pattern in this directory and does not recursively delete other cache content. A failed deletion is reported and can be retried by maintenance. A killed process can leave a compressed original until the next process initialization or successful sweep.

## Verification

`OfficeDocumentTest` covers extraction order, rich strings, Unicode and namespaces, corrupt ignored media, selected CRC and size verification, whole-archive limits, duplicate paths, malformed/truncated files, UTF-8/UTF-16 DTD rejection, output/table limits, cancellation and temporary ownership. Device tests exercise the real Android SAX implementation, encrypted import results, startup cleanup and allocation/heap measurements against the previous eager DOCX extractor.
