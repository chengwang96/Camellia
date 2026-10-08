# Data package import

Camellia migration packages contain API configuration, settings and
conversations, including each discussion participant's native engine context.
The import dialog derives category counts and sizes from archive entries. A
manifest's claimed category totals do not determine what is restored.

## Selected extraction

Import first checks the manifest, part availability, directory records, paths,
duplicate entries and declared totals across every part. Each part's directory
is opened once per operation, and its manifest reuses that directory. The
selection preview and a subsequent import perform separate checks so a file
changed while the dialog was open is not trusted from an old preview.

Only selected active files have their compressed payload read or a staging file
created. Older packages can include `app/migration-backups`; those entries still
count toward the legacy manifest totals, but are excluded from category offers
and extraction. Unselected payloads are not decompressed or CRC checked. Their
directory metadata and paths are still checked.

Extraction is sequential with backpressure. A transform checks every output
chunk before forwarding it to the manifest collector or staging writer:

- Actual bytes may not exceed the entry's declared size or its applicable limit.
- Selected file output may not exceed the selected aggregate byte total.
- Final actual size and CRC must match the directory record.

The compressed source, inflater, byte guard and destination share a single
`pipeline`. A limit violation, corrupt stream, write error or progress callback
failure tears down the whole pipeline, including its file handles.

Progress totals refer to selected active bytes. An excluded history file does
not contribute to extraction progress or temporary disk use.

## Resource limits

| Resource | Import bound |
| --- | --- |
| Manifest | 4 MiB of actual uncompressed output, checked before buffering |
| ZIP directory | 64 MiB per archive, checked before directory allocation |
| ZIP directory records | 65,534 per archive, including directory entries |
| Profile data files | 30,000 per part, matching the exporter |
| Declared profile data | At most 3 GiB per part, matching the exporter |
| Single profile file | Less than 3 GiB, matching the exporter |
| Cross-part path and selection index | 64 MiB of accounted metadata |
| Stream buffers | 64 KiB per stream stage |
| Ordinary JSON path rewriting | 8 MiB per file |
| Discussion rewriting | Existing 32 MiB logical record limit, including referenced text |

The index budget charges fixed entry overhead and UTF-16 path copies before
retaining an entry. Selected entries keep only the fields needed for extraction;
directory buffers and stream closures do not accumulate across parts. Extraction
releases the selected entry descriptors before metadata rewriting.

These are allocation and input bounds, not a promise that the Electron process
uses a fixed amount of RAM. Strings, parsed JSON, directory objects and V8
garbage collection affect RSS. Native history and other ordinary payload files
are streamed, so their full size is never a required memory allocation. Ordinary
JSON above 8 MiB retains the existing behavior of being copied without path
rewriting; an oversized desktop configuration is rejected. Discussions retain
their existing bounded reader and complete native ownership data.

The reader accepts stored and deflated entries, including data descriptors.
ZIP64 directory headers remain supported within the same allocation limits.
Encrypted entries and unsupported compression methods cannot be imported.

## Activation and disk use

All selected files finish extraction, CRC/size validation and applicable JSON
validation/path rewriting in staging before the first profile file is replaced.
The existing transaction journal, backups and startup recovery continue to
protect an interrupted activation. Failed or completed imports remove their
owned staging directory.

After commit or successful rollback, the transaction writes a durable
`retention.json` completion/ownership manifest before removing its recovery
journal. If that write or journal removal fails, startup recovery can finish it
without rolling back an already committed import. Unresolved recovery journals
remain protected from retention cleanup.

Completed overwrite backups retain the newest three points for up to 30 days,
with a 2 GiB target total and an unconditional newest-point safeguard. The
startup/idle maintenance pass expires older eligible points. Legacy backups
without completion evidence require manual space-cleanup confirmation. See
[Storage maintenance](storage-maintenance.md#other-retention) for reference
protection, diagnostic-log limits and the settings preview. Exported ZIP files
are user managed.

Staging still needs room for the selected content. Activation also needs space
for overwritten-file backups and a target-local temporary copy of the current
file. This preserves recovery across different volumes; selected extraction
eliminates the temporary copies of categories the user did not choose.

## Verification

`tests/data-import-limits.test.js` covers skipped corrupt payloads, selected
progress totals, forged manifest/file sizes, source cleanup, late multipart
corruption, directory allocation limits, cross-part index limits and oversized
discussion records. Existing migration and discussion tests cover category
combinations, path rewriting, native context ownership and transaction recovery.

The isolated `data-import-memory-fixture.cjs` imports a package with 256 MiB of
history. On the 2026-10-07 Windows run, settings-only staging peaked at 26 bytes;
full staging held 256 MiB plus those settings, and full-import RSS increased by
about 69 MiB. The regression allows an RSS increase below 128 MiB for this
fixture. This measurement describes the fixture rather than every profile or
the overall desktop process.
