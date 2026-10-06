$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not $env:USERPROFILE) { throw 'This local signing setup requires Windows.' }
if (-not $env:JAVA_HOME) { throw 'Set JAVA_HOME to a JDK 17 installation first.' }

$directory = Join-Path $env:USERPROFILE '.camellia/android-signing'
$keystore = Join-Path $directory 'camellia-release.p12'
$credential = Join-Path $directory 'password.dpapi'
if ((Test-Path -LiteralPath $keystore) -or (Test-Path -LiteralPath $credential)) {
    throw 'A local release key or credential already exists. Keep the same key for every update.'
}
New-Item -ItemType Directory -Force $directory | Out-Null

$bytes = New-Object byte[] 36
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $random.GetBytes($bytes) } finally { $random.Dispose() }
$password = [Convert]::ToBase64String($bytes)
try {
    $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
    $securePassword | ConvertFrom-SecureString | Set-Content -LiteralPath $credential -Encoding ascii -NoNewline
    $env:CAMELLIA_ANDROID_KEYSTORE_PASSWORD = $password
    $keytool = Join-Path $env:JAVA_HOME 'bin/keytool.exe'
    & $keytool -genkeypair -noprompt -keystore $keystore -storetype PKCS12 -alias camellia `
        -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=Camellia Android Release' `
        -storepass:env CAMELLIA_ANDROID_KEYSTORE_PASSWORD -keypass:env CAMELLIA_ANDROID_KEYSTORE_PASSWORD
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Android release signing key.' }
} finally {
    Remove-Item Env:CAMELLIA_ANDROID_KEYSTORE_PASSWORD -ErrorAction SilentlyContinue
    $password = $null
}
Write-Output "Release keystore: $keystore"
Write-Output "Windows user-encrypted signing credential: $credential"
Write-Output 'Back up the keystore and password securely. The encrypted credential works only for this Windows user.'
