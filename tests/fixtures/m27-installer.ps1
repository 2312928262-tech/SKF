param([string]$Root, [string]$Output)
$ErrorActionPreference = 'Stop'
. (Join-Path $Root 'scripts\install.ps1') -LibraryOnly
$script:Checks = @()
function Check([string]$Name, [scriptblock]$Body) { & $Body; $script:Checks += $Name }
function Equal($Actual, $Expected) { if ($Actual -cne $Expected) { throw 'ASSERTION_FAILED' } }
function Reject([string]$Code, [scriptblock]$Body) { $caught = $false; try { & $Body } catch { if ($_.Exception.Message -cne $Code) { throw }; $caught = $true }; if (-not $caught) { throw 'EXPECTED_REJECTION' } }
function Wait-FileGone([string]$Path) { for ($i = 0; $i -lt 80; $i++) { if (-not (Test-Path -LiteralPath $Path)) { return }; Start-Sleep -Milliseconds 25 }; throw 'FIXTURE_DELETE_NOT_OBSERVED' }
$temp = Join-Path (Split-Path $Output) ('installer-fixture-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temp)
$result = @{ exitCode = 1; checks = @(); paidCalls = 0; networkRequests = 0; registryWrites = 0; productionInstallVerified = $false }
try {
    Check 'unconfigured release fails before disk/network/PATH changes' { Reject 'RELEASE_NOT_CONFIGURED' { Invoke-SkfInstall } }
    $p = $script:Policy.Clone(); $p.Enabled = $true; $p.BaseUrl = 'https://release.invalid/skf'; $p.SignerThumbprint = 'A' * 40
    Check 'fixed HTTPS release prefix rejects redirects/credentials/query/alternate host/path tricks' {
        Assert-ReleaseUrl 'https://release.invalid/skf/v0.4.4/release.cat' $p
        foreach ($u in @('http://release.invalid/skf/v0.4.4/release.cat', 'https://other.invalid/skf/v0.4.4/release.cat', 'https://release.invalid/skf/v0.4.4/release.cat?x=1', 'https://release.invalid/skf/v0.4.4/../release.cat', 'https://release.invalid/skf/v0.4.4/%2e%2e', 'https://name@release.invalid/skf/v0.4.4/release.cat')) { Reject 'RELEASE_URL_REJECTED' { Assert-ReleaseUrl $u $p } }
    }
    Check 'signature requires Valid AND pinned signer; fake verifier fixtures are not public trust' {
        Assert-SignatureResult ([pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Thumbprint = 'A' * 40 } }) ('A' * 40)
        Reject 'SIGNATURE_REJECTED' { Assert-SignatureResult ([pscustomobject]@{ Status = 'NotSigned'; SignerCertificate = $null }) ('A' * 40) }
        Reject 'SIGNATURE_REJECTED' { Assert-SignatureResult ([pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Thumbprint = 'B' * 40 } }) ('A' * 40) }
    }
    $sample = Join-Path $temp 'sample.txt'; [IO.File]::WriteAllText($sample, 'fixture')
    Check 'SHA256 tampering rejected' { Assert-Hash $sample (Get-FileHash -LiteralPath $sample).Hash; Reject 'HASH_REJECTED' { Assert-Hash $sample ('0' * 64) } }
    Check 'ZIP traversal, ADS, reserved names and credential/data payloads rejected' {
        foreach ($name in @('../outside', '/absolute', 'C:/drive', 'a\..\outside', 'a//b', 'a/NUL.txt', 'a/CON', 'a/file.', 'a/file:stream')) { Reject 'ARCHIVE_PATH_REJECTED' { Assert-RelativeFile $name } }
        foreach ($name in @('app/.env', 'app/config.env', 'data/runtime.sqlite', 'app/private.key')) { Reject 'ARCHIVE_USER_DATA_REJECTED' { Assert-RelativeFile $name } }
    }
    $m = @{ Schema = 1; Version = '0.4.4'; Architecture = 'x64'; NodeVersion = '24.20.0'; NodeSignerThumbprint = 'B' * 40; Archive = 'skf-0.4.4-win-x64.zip'; ArchiveSha256 = '0' * 64; CatalogSha256 = '0' * 64; Files = @(@{Path='runtime/node.exe';Sha256='0'*64},@{Path='app/dist/cli.js';Sha256='0'*64}) }
    Check 'manifest compatibility, missing runtime, duplicate paths and unsupported Node rejected' {
        Assert-Manifest $m $p 'x64'
        $bad=$m.Clone(); $bad.NodeVersion='24.19.0'; Reject 'NODE_MANIFEST_REJECTED' { Assert-Manifest $bad $p 'x64' }
        $bad=$m.Clone(); $bad.Architecture='arm64'; Reject 'MANIFEST_COMPATIBILITY_REJECTED' { Assert-Manifest $bad $p 'x64' }
        $bad=$m.Clone(); $bad.Files=@($m.Files[0],$m.Files[0]); Reject 'MANIFEST_INVALID' { Assert-Manifest $bad $p 'x64' }
    }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    function MakeZip([string]$Name, [hashtable]$Entries) {
        $zipPath = Join-Path $temp $Name; $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
        try { foreach ($key in $Entries.Keys) { $e=$zip.CreateEntry($key); $s=[IO.StreamWriter]::new($e.Open()); try { $s.Write($Entries[$key]) } finally { $s.Dispose() } } } finally { $zip.Dispose() }; return $zipPath
    }
    $zipPath=MakeZip 'valid.zip' @{'runtime/node.exe'='not-executable-fixture';'app/dist/cli.js'='fixture-js'}
    $hash = { param($s) $sha=[Security.Cryptography.SHA256]::Create(); try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s))).Replace('-','') } finally { $sha.Dispose() } }
    $m.Files=@(@{Path='runtime/node.exe';Sha256=(& $hash 'not-executable-fixture')},@{Path='app/dist/cli.js';Sha256=(& $hash 'fixture-js')})
    Check 'actual local ZIP extraction checks listed files/hash and private Windows ACL' {
        $dest=Join-Path $temp 'valid'; Expand-VerifiedArchive $zipPath $dest $m $p
        Equal (Get-Acl -LiteralPath $dest).AreAccessRulesProtected $true
        Equal ([IO.File]::ReadAllText((Join-Path $dest 'app/dist/cli.js'))) 'fixture-js'
        Reject 'STAGING_ALREADY_EXISTS' { Expand-VerifiedArchive $zipPath $dest $m $p }
        $badzip=MakeZip 'traversal.zip' @{'../escape.txt'='x'}; Reject 'ARCHIVE_PATH_REJECTED' { Expand-VerifiedArchive $badzip (Join-Path $temp 'badzip') $m $p }
        $badzip=MakeZip 'extra.zip' @{'extra.txt'='x'}; Reject 'ARCHIVE_UNLISTED_FILE' { Expand-VerifiedArchive $badzip (Join-Path $temp 'extra') $m $p }
        $badzip=MakeZip 'hash.zip' @{'runtime/node.exe'='changed'}; Reject 'HASH_REJECTED' { Expand-VerifiedArchive $badzip (Join-Path $temp 'hash') $m $p }
    }
    Check 'PATH merge preserves existing entries, no registry writes in tests' {
        Equal (Merge-UserPath 'C:\one;C:\two' 'D:\SKF\bin') 'C:\one;C:\two;D:\SKF\bin'
        Equal (Merge-UserPath 'C:\one;D:\SKF\bin;C:\two' 'D:\SKF\bin' $true) 'C:\one;C:\two'
        Equal (Merge-UserPath 'C:\one;D:\SKF\bin' 'D:\SKF\bin') 'C:\one;D:\SKF\bin'
    }
    Check 'atomic shim publication restores prior shim when PATH action fails; old version retained' {
        $install=Join-Path $temp 'install'; Set-PrivateDirectory $install
        Publish-Shim $install '0.4.3' { param($bin) }
        $shim=Join-Path $install 'bin\skf.cmd'; $before=[IO.File]::ReadAllText($shim)
        Reject 'SIMULATED_PATH_FAILURE' { Publish-Shim $install '0.4.4' { param($bin) throw 'SIMULATED_PATH_FAILURE' } }
        Equal ([IO.File]::ReadAllText($shim)) $before
        Publish-Shim $install '0.4.4' { param($bin) }; if (-not [IO.File]::ReadAllText($shim).Contains('0.4.4')) { throw 'SHIM_VERSION_FAILED' }
    }
    Check 'manifest-only uninstall refuses user additions, then removes only verified program files' {
        $dest=Join-Path $temp 'uninstall'; Expand-VerifiedArchive $zipPath $dest $m $p
        $user=Join-Path $dest 'my-data.txt'; [IO.File]::WriteAllText($user,'preserve')
        Reject 'UNMANAGED_FILES_PRESERVED' { Remove-ManifestFiles $dest $m }
        Equal ([IO.File]::ReadAllText($user)) 'preserve'
        Equal (Test-Path -LiteralPath (Join-Path $dest 'app/dist/cli.js')) $true
        [IO.File]::Delete($user); Wait-FileGone $user
        Remove-ManifestFiles $dest $m; Equal (Test-Path -LiteralPath $dest) $false
    }
    $result.exitCode=0
} catch { $result.failure=$_.Exception.Message; $result.line=$_.InvocationInfo.ScriptLineNumber }
finally { $result.checks=$script:Checks; $result.command=@('powershell','-NoProfile','-NonInteractive','-File',$PSCommandPath,'-Root',$Root,'-Output',$Output); [IO.File]::WriteAllText($Output, ($result|ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false)); if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -Recurse } }
if ($result.exitCode -ne 0) { exit 1 }
