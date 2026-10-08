param([Parameter(Mandatory)][string]$Path)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $Path).Path
$stream = [IO.File]::OpenRead($resolved)
$reader = [IO.BinaryReader]::new($stream)
try {
    # Android APKs use ordinary ZIP32 directories. Read the directory rather than
    # guessing overhead from file size; incremental ZIPs may contain dead payloads.
    $tailLength = [int][Math]::Min($stream.Length, 65557)
    $stream.Position = $stream.Length - $tailLength
    $tail = $reader.ReadBytes($tailLength)
    $end = -1
    for ($i = $tail.Length - 22; $i -ge 0; $i--) {
        if ([BitConverter]::ToUInt32($tail, $i) -eq 0x06054b50 -and $i + 22 + [BitConverter]::ToUInt16($tail, $i + 20) -eq $tail.Length) { $end = $i; break }
    }
    if ($end -lt 0) { throw 'APK ZIP directory not found.' }
    $count = [BitConverter]::ToUInt16($tail, $end + 10)
    $directoryBytes = [BitConverter]::ToUInt32($tail, $end + 12)
    $directoryOffset = [BitConverter]::ToUInt32($tail, $end + 16)
    $entries = @()
    $stream.Position = $directoryOffset
    for ($i = 0; $i -lt $count; $i++) {
        $header = $reader.ReadBytes(46)
        if ([BitConverter]::ToUInt32($header, 0) -ne 0x02014b50) { throw 'Invalid APK ZIP entry.' }
        $nameLength = [BitConverter]::ToUInt16($header, 28)
        $extraLength = [BitConverter]::ToUInt16($header, 30)
        $commentLength = [BitConverter]::ToUInt16($header, 32)
        $name = [Text.Encoding]::UTF8.GetString($reader.ReadBytes($nameLength))
        $stream.Position += $extraLength + $commentLength
        $category = if ($name -match '^lib/([^/]+)/') { "native/$($Matches[1])" }
            elseif ($name -match '^classes\d*\.dex$') { 'dex' }
            elseif ($name -match '^res/') { 'resources' }
            elseif ($name -match '^assets/') { 'assets' } else { 'other' }
        $entries += [pscustomobject]@{
            name = $name; category = $category
            compressedBytes = [long][BitConverter]::ToUInt32($header, 20)
            uncompressedBytes = [long][BitConverter]::ToUInt32($header, 24)
            compression = [BitConverter]::ToUInt16($header, 10)
            flags = [BitConverter]::ToUInt16($header, 8)
            offset = [long][BitConverter]::ToUInt32($header, 42)
        }
    }
    $localBytes = 0L; $payloadBytes = 0L; $descriptorBytes = 0L
    foreach ($entry in $entries) {
        $stream.Position = $entry.offset
        $header = $reader.ReadBytes(30)
        if ([BitConverter]::ToUInt32($header, 0) -ne 0x04034b50) { throw 'Invalid local APK ZIP header.' }
        $length = 30 + [BitConverter]::ToUInt16($header, 26) + [BitConverter]::ToUInt16($header, 28)
        $localBytes += $length; $payloadBytes += $entry.compressedBytes
        if ($entry.flags -band 8) {
            $stream.Position = $entry.offset + $length + $entry.compressedBytes
            $descriptorBytes += $(if ($reader.ReadUInt32() -eq 0x08074b50) { 16 } else { 12 })
        }
    }
    $signingBytes = 0L
    if ($directoryOffset -ge 24) {
        $stream.Position = $directoryOffset - 24
        $footer = $reader.ReadBytes(24)
        if ([Text.Encoding]::ASCII.GetString($footer, 8, 16) -eq 'APK Sig Block 42') {
            $signingBytes = [long][BitConverter]::ToUInt64($footer, 0) + 8
        }
    }
    $endBytes = $tail.Length - $end
    $overhead = $localBytes + $descriptorBytes + $signingBytes + $directoryBytes + $endBytes
    $unreferenced = $stream.Length - $payloadBytes - $overhead
    $groups = @($entries | Group-Object category | ForEach-Object {
        [pscustomobject]@{ category = $_.Name; compressedBytes = [long](($_.Group | Measure-Object compressedBytes -Sum).Sum); uncompressedBytes = [long](($_.Group | Measure-Object uncompressedBytes -Sum).Sum) }
    })
    [pscustomobject]@{
        path = $resolved; bytes = $stream.Length; sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
        entryCount = $count; payloadBytes = $payloadBytes; overheadBytes = $overhead; unreferencedBytes = $unreferenced
        nativeLibraries = @($entries | Where-Object name -match '^lib/.+\.so$' | Select-Object name, compression, uncompressedBytes)
        categories = $groups
    }
} finally { $reader.Dispose(); $stream.Dispose() }
