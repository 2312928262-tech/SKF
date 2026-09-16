# SKF user-only release installer. This source build has NO public release authority.
# Release owners must review, pin the policy, and Authenticode-sign this script.
[CmdletBinding()]
param([switch]$LibraryOnly, [switch]$Uninstall)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Policy = @{
    Enabled = $false
    Version = '0.4.4'
    BaseUrl = $null
    SignerThumbprint = $null
    NodeMin = '24.20.0'
    Architectures = @('x64')
    MaxArchiveBytes = 209715200
    MaxExpandedBytes = 629145600
    MaxFiles = 20000
}
$script:InstallerPath = $PSCommandPath
function Fail([string]$Code) { throw [InvalidOperationException]::new($Code) }
function Assert-Policy($P) {
    if (-not $P.Enabled -or -not $P.BaseUrl -or -not $P.SignerThumbprint) { Fail 'RELEASE_NOT_CONFIGURED' }
    if ($P.Version -notmatch '^\d+\.\d+\.\d+$' -or $P.SignerThumbprint -notmatch '^[A-Fa-f0-9]{40}$') { Fail 'RELEASE_POLICY_INVALID' }
    $u = [Uri]$P.BaseUrl
    if (-not $u.IsAbsoluteUri -or $u.Scheme -ne 'https' -or $u.UserInfo -or $u.Query -or $u.Fragment -or $u.Port -ne 443 -or $u.IsLoopback) { Fail 'RELEASE_POLICY_INVALID' }
}
function Assert-ReleaseUrl([string]$Url, $P) {
    Assert-Policy $P
    $base = $P.BaseUrl.TrimEnd('/') + '/v' + $P.Version + '/'
    if (-not $Url.StartsWith($base, [StringComparison]::Ordinal)) { Fail 'RELEASE_URL_REJECTED' }
    $u = [Uri]$Url
    $b = [Uri]$P.BaseUrl
    if ($u.Scheme -ne 'https' -or $u.Authority -cne $b.Authority -or $u.UserInfo -or $u.Query -or $u.Fragment -or $Url.Contains('%') -or $Url.Contains('..') -or $Url.Contains('\')) { Fail 'RELEASE_URL_REJECTED' }
    if ($Url.Substring($base.Length) -notmatch '^[a-zA-Z0-9._-]+$') { Fail 'RELEASE_URL_REJECTED' }
}
function Assert-SignatureResult($Signature, [string]$Thumbprint) {
    if ($Signature.Status.ToString() -ne 'Valid' -or -not $Signature.SignerCertificate -or $Signature.SignerCertificate.Thumbprint -ine $Thumbprint) { Fail 'SIGNATURE_REJECTED' }
}
function Assert-Signed([string]$File, [string]$Thumbprint) {
    Assert-SignatureResult (Get-AuthenticodeSignature -LiteralPath $File) $Thumbprint
}
function Assert-NoReparse([string]$Path) {
    $p = [IO.Path]::GetFullPath($Path)
    while ($p) {
        if (Test-Path -LiteralPath $p) {
            if (((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'REPARSE_POINT_REJECTED' }
        }
        $parent = [IO.Path]::GetDirectoryName($p)
        if ($parent -eq $p) { break }; $p = $parent
    }
}
function Set-PrivateDirectory([string]$Path) {
    Assert-NoReparse $Path
    [void][IO.Directory]::CreateDirectory($Path)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($sid, $system)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    $actual = Get-Acl -LiteralPath $Path
    if (-not $actual.AreAccessRulesProtected) { Fail 'INSTALL_ACL_FAILED' }
    foreach ($rule in $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18')) { Fail 'INSTALL_ACL_FAILED' }
    }
}
function Get-ReleaseFile([string]$Url, [string]$Destination, [long]$Limit, $P) {
    Assert-ReleaseUrl $Url $P
    Add-Type -AssemblyName System.Net.Http
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.SslProtocols = [Security.Authentication.SslProtocols]::Tls12
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(5)
    $response = $null; $stream = $null; $out = $null
    try {
        $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200) { Fail 'DOWNLOAD_STATUS_REJECTED' }
        if ($response.Content.Headers.ContentLength -gt $Limit) { Fail 'DOWNLOAD_TOO_LARGE' }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $out = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = New-Object byte[] 65536; [long]$total = 0
        while (($n = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $n; if ($total -gt $Limit) { Fail 'DOWNLOAD_TOO_LARGE' }; $out.Write($buffer, 0, $n)
        }
        $out.Flush($true)
    } finally { if ($out) { $out.Dispose() }; if ($stream) { $stream.Dispose() }; if ($response) { $response.Dispose() }; $client.Dispose(); $handler.Dispose() }
}
function Assert-Hash([string]$File, [string]$Expected) {
    if ($Expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ine $Expected) { Fail 'HASH_REJECTED' }
}
function Assert-RelativeFile([string]$Name) {
    if (-not $Name -or $Name -notmatch '^[A-Za-z0-9._/-]+$' -or $Name.StartsWith('/') -or $Name.Contains('//') -or $Name.EndsWith('/')) { Fail 'ARCHIVE_PATH_REJECTED' }
    foreach ($part in $Name.Split('/')) {
        if ($part -in @('.', '..') -or $part.EndsWith('.') -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { Fail 'ARCHIVE_PATH_REJECTED' }
    }
    if ($Name -match '(?i)(^|/)(config\.env|\.env(?:\..*)?|instance\.json|.*\.sqlite(?:-wal|-shm)?|.*\.(?:key|pem|pfx))$') { Fail 'ARCHIVE_USER_DATA_REJECTED' }
}
function Assert-Manifest($M, $P, [string]$Arch) {
    $allowed = @('Schema', 'Version', 'Architecture', 'NodeVersion', 'NodeSignerThumbprint', 'Archive', 'ArchiveSha256', 'CatalogSha256', 'Files')
    foreach ($key in $M.Keys) { if ($key -notin $allowed) { Fail 'MANIFEST_INVALID' } }
    foreach ($key in $allowed) { if (-not $M.ContainsKey($key)) { Fail 'MANIFEST_INVALID' } }
    if ($M.Schema -ne 1 -or $M.Version -cne $P.Version -or $M.Architecture -cne $Arch -or $Arch -notin $P.Architectures) { Fail 'MANIFEST_COMPATIBILITY_REJECTED' }
    if ($M.NodeVersion -notmatch '^24\.\d+\.\d+$' -or [version]$M.NodeVersion -lt [version]$P.NodeMin -or $M.NodeSignerThumbprint -notmatch '^[a-fA-F0-9]{40}$') { Fail 'NODE_MANIFEST_REJECTED' }
    if ($M.Archive -cne ('skf-' + $P.Version + '-win-' + $Arch + '.zip') -or $M.ArchiveSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $M.CatalogSha256 -notmatch '^[a-fA-F0-9]{64}$') { Fail 'MANIFEST_INVALID' }
    if (@($M.Files).Count -lt 2 -or @($M.Files).Count -gt $P.MaxFiles) { Fail 'MANIFEST_INVALID' }
    $seen = @{}
    foreach ($file in $M.Files) {
        if ($file -isnot [Collections.IDictionary] -or $file.Count -ne 2 -or -not $file.ContainsKey('Path') -or -not $file.ContainsKey('Sha256')) { Fail 'MANIFEST_INVALID' }
        Assert-RelativeFile $file.Path
        if ($seen.ContainsKey($file.Path) -or $file.Sha256 -notmatch '^[a-fA-F0-9]{64}$') { Fail 'MANIFEST_INVALID' }; $seen[$file.Path] = $true
    }
    if (-not $seen.ContainsKey('runtime/node.exe') -or -not $seen.ContainsKey('app/dist/cli.js')) { Fail 'MANIFEST_RUNTIME_MISSING' }
}
function Expand-VerifiedArchive([string]$Archive, [string]$Destination, $M, $P) {
    if (Test-Path -LiteralPath $Destination) { Fail 'STAGING_ALREADY_EXISTS' }
    Set-PrivateDirectory $Destination
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $seen = @{}; [long]$total = 0; $listed = @{}
        foreach ($file in $M.Files) { $listed[$file.Path] = $file.Sha256 }
        if ($zip.Entries.Count -gt ($P.MaxFiles * 2)) { Fail 'ARCHIVE_TOO_MANY_FILES' }
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName; $isDirectory = $name.EndsWith('/')
            $check = if ($isDirectory) { $name.TrimEnd('/') } else { $name }
            Assert-RelativeFile $check
            if (($entry.ExternalAttributes -band 0x400) -ne 0 -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { Fail 'ARCHIVE_LINK_REJECTED' }
            if ($seen.ContainsKey($name)) { Fail 'ARCHIVE_DUPLICATE_REJECTED' }; $seen[$name] = $true
            if ($isDirectory) { continue }
            if (-not $listed.ContainsKey($name)) { Fail 'ARCHIVE_UNLISTED_FILE' }
            $total += $entry.Length; if ($total -gt $P.MaxExpandedBytes) { Fail 'ARCHIVE_TOO_LARGE' }
            $file = [IO.Path]::GetFullPath((Join-Path $Destination $name.Replace('/', [IO.Path]::DirectorySeparatorChar)))
            if (-not $file.StartsWith([IO.Path]::GetFullPath($Destination) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Fail 'ARCHIVE_PATH_REJECTED' }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)); Assert-NoReparse $file
            $input = $entry.Open(); $output = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $buffer = New-Object byte[] 65536; [long]$written = 0; while (($n = $input.Read($buffer, 0, $buffer.Length)) -gt 0) { $written += $n; if ($written -gt $entry.Length) { Fail 'ARCHIVE_SIZE_REJECTED' }; $output.Write($buffer, 0, $n) }; if ($written -ne $entry.Length) { Fail 'ARCHIVE_SIZE_REJECTED' }; $output.Flush($true) } finally { $input.Dispose(); $output.Dispose() }
            Assert-Hash $file $listed[$name]
        }
        foreach ($name in $listed.Keys) { if (-not $seen.ContainsKey($name)) { Fail 'ARCHIVE_FILE_MISSING' } }
    } finally { $zip.Dispose() }
}
function Assert-Payload([string]$Dir, [string]$Catalog, $M, $P) {
    Assert-NoReparse $Dir
    $listed = @{}; foreach ($f in $M.Files) { $listed[$f.Path] = $true; $file = Join-Path $Dir $f.Path; Assert-NoReparse $file; Assert-Hash $file $f.Sha256 }
    foreach ($item in Get-ChildItem -LiteralPath $Dir -Recurse -Force) {
        Assert-NoReparse $item.FullName
        if (-not $item.PSIsContainer) { $relative = $item.FullName.Substring($Dir.TrimEnd('\').Length + 1).Replace('\', '/'); if (-not $listed.ContainsKey($relative)) { Fail 'UNMANAGED_FILES_PRESERVED' } }
    }
    Assert-Hash $Catalog $M.CatalogSha256; Assert-Signed $Catalog $P.SignerThumbprint
    if (-not (Get-Command Test-FileCatalog -ErrorAction SilentlyContinue)) { Fail 'FILE_CATALOG_UNAVAILABLE' }
    if ((Test-FileCatalog -Path $Dir -CatalogFilePath $Catalog).ToString() -ne 'Valid') { Fail 'CATALOG_REJECTED' }
    Assert-Signed (Join-Path $Dir 'runtime/node.exe') $M.NodeSignerThumbprint
}
function Write-Atomic([string]$Path, [string]$Text) {
    Assert-NoReparse $Path
    $tmp = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($tmp, $Text, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
    } finally { if (Test-Path -LiteralPath $tmp) { [IO.File]::Delete($tmp) } }
}
function Merge-UserPath([string]$Current, [string]$Bin, [bool]$Remove = $false) {
    $parts = @($Current.Split(';') | Where-Object { $_ -and $_.TrimEnd('\') -ine $Bin.TrimEnd('\') })
    if (-not $Remove) { $parts += $Bin }; return ($parts -join ';')
}
function Publish-Shim([string]$Root, [string]$Version, [scriptblock]$SetPath) {
    $bin = Join-Path $Root 'bin'; Set-PrivateDirectory $bin
    $shim = Join-Path $bin 'skf.cmd'; Assert-NoReparse $shim
    $old = if (Test-Path -LiteralPath $shim) { [IO.File]::ReadAllText($shim) } else { $null }
    $target = Join-Path (Join-Path $Root 'versions') $Version
    $text = '@echo off' + "`r`n" + 'setlocal DisableDelayedExpansion' + "`r`n" + '"' + (Join-Path $target 'runtime\node.exe') + '" "' + (Join-Path $target 'app\dist\cli.js') + '" %*' + "`r`n" + 'exit /b %errorlevel%' + "`r`n"
    try { Write-Atomic $shim $text; & $SetPath $bin } catch { if ($null -eq $old) { if (Test-Path -LiteralPath $shim) { [IO.File]::Delete($shim) } } else { Write-Atomic $shim $old }; throw }
}


function Remove-ManifestFiles([string]$Dir, $M) {
    # Never recursively delete a program directory that may contain user additions.
    Assert-NoReparse $Dir
    $Dir = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
    $listed = @{}
    foreach ($f in $M.Files) { Assert-RelativeFile $f.Path; $listed[$f.Path] = $f.Sha256; Assert-Hash (Join-Path $Dir $f.Path) $f.Sha256 }
    foreach ($item in Get-ChildItem -LiteralPath $Dir -Recurse -Force) {
        Assert-NoReparse $item.FullName
        if (-not $item.PSIsContainer) { $rel=[IO.Path]::GetFullPath($item.FullName).Substring($Dir.Length+1).Replace('\','/'); if (-not $listed.ContainsKey($rel)) { Fail 'UNMANAGED_FILES_PRESERVED' } }
    }
    foreach ($f in $M.Files) { $file=Join-Path $Dir $f.Path; Assert-NoReparse $file; Assert-Hash $file $f.Sha256; [IO.File]::Delete($file) }
    $dirs = @(Get-ChildItem -LiteralPath $Dir -Directory -Recurse -Force | Sort-Object { $_.FullName.Length } -Descending)
    foreach ($d in $dirs) { if (@(Get-ChildItem -LiteralPath $d.FullName -Force).Count -eq 0) { [IO.Directory]::Delete($d.FullName) } }
    if (@(Get-ChildItem -LiteralPath $Dir -Force).Count -eq 0) { [IO.Directory]::Delete($Dir) }
}
function Invoke-ManifestUninstall([string]$Root, $P, [string]$OldPath) {
    if (-not (Test-Path -LiteralPath $Root)) { Write-Output 'SKF program directory not present; data untouched.'; return }
    Assert-NoReparse $Root
    # Read executable paths, never process command lines or environment/credentials.
    foreach ($process in Get-CimInstance Win32_Process -Filter "Name='node.exe'" -Property ExecutablePath) {
        if (-not $process.ExecutablePath) { Fail 'PROCESS_STATE_UNVERIFIED' }
        if ($process.ExecutablePath.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail 'STOP_SKF_BEFORE_UNINSTALL' }
    }
    $lock=$null
    try {
        $lock=[IO.File]::Open((Join-Path $Root 'install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $plans=@(); $versions=Join-Path $Root 'versions'
        if (Test-Path -LiteralPath $versions) {
            Assert-NoReparse $versions
            foreach ($dir in Get-ChildItem -LiteralPath $versions -Force) {
                if (-not $dir.PSIsContainer -or $dir.Name -notmatch '^\d+\.\d+\.\d+$') { Fail 'UNMANAGED_FILES_PRESERVED' }
                Assert-NoReparse $dir.FullName
                $receipt=Join-Path $Root ('receipts\' + $dir.Name); Assert-NoReparse $receipt
                $manifest=Join-Path $receipt 'release-manifest.psd1'; $catalog=Join-Path $receipt 'release.cat'
                Assert-Signed $manifest $P.SignerThumbprint
                $m=Import-PowerShellDataFile -LiteralPath $manifest; $vp=$P.Clone(); $vp.Version=$dir.Name; Assert-Manifest $m $vp 'x64'
                Assert-Payload $dir.FullName $catalog $m $vp
                $plans+=@{ Dir=$dir.FullName; Manifest=$m; Receipt=$receipt }
            }
        }
        foreach ($plan in $plans) {
            Remove-ManifestFiles $plan.Dir $plan.Manifest
            foreach ($name in @('release-manifest.psd1','release.cat')) { [IO.File]::Delete((Join-Path $plan.Receipt $name)) }
            if (@(Get-ChildItem -LiteralPath $plan.Receipt -Force).Count -eq 0) { [IO.Directory]::Delete($plan.Receipt) }
        }
        $bin=Join-Path $Root 'bin'; $shim=Join-Path $bin 'skf.cmd'; Assert-NoReparse $shim
        if (Test-Path -LiteralPath $shim) {
            $text=[IO.File]::ReadAllText($shim)
            if (-not $text.StartsWith('@echo off') -or -not $text.Contains((Join-Path $Root 'versions'))) { Fail 'UNMANAGED_SHIM_PRESERVED' }
            [IO.File]::Delete($shim)
        }
        [Environment]::SetEnvironmentVariable('Path', (Merge-UserPath $OldPath $bin $true), 'User')
        Write-Output 'Verified SKF program files removed. Configuration, credentials, data and unlisted files are retained.'
    } finally { if ($lock) { $lock.Dispose() } }
}

function Invoke-SkfInstall([switch]$Remove) {
    # Fail before touching disk, network or PATH in unconfigured builds.
    Assert-Policy $script:Policy
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or $PSVersionTable.PSVersion -lt [version]'5.1') { Fail 'WINDOWS_POWERSHELL_51_REQUIRED' }
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($arch -ne 'AMD64') { Fail 'ARCHITECTURE_NOT_VALIDATED' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'RUN_AS_STANDARD_USER_NOT_ADMIN' }
    Assert-Signed $script:InstallerPath $script:Policy.SignerThumbprint
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $local -or $local.StartsWith('\\') -or $local -match '[%"!\r\n]') { Fail 'LOCAL_USER_DIRECTORY_REQUIRED' }
    $root = Join-Path $local 'Programs\SKF'; Assert-NoReparse $root
    $disk = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
    if ($disk.DriveType -ne 'Fixed' -or $disk.AvailableFreeSpace -lt 1073741824) { Fail 'LOCAL_DISK_SPACE_REQUIRED' }
    $oldPath = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($null -eq $oldPath) { $oldPath = '' }
    if ($Remove) { Invoke-ManifestUninstall $root $script:Policy $oldPath; return }
    Set-PrivateDirectory $root
    $lock = $null; $stage = $null
    try {
        $lock = [IO.File]::Open((Join-Path $root 'install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $versions = Join-Path $root 'versions'; Set-PrivateDirectory $versions
        $version = $script:Policy.Version; $target = Join-Path $versions $version
        if (Test-Path -LiteralPath $target) { Fail 'VERSION_ALREADY_PRESENT_STOP_AND_REVIEW' }
        $stage = Join-Path $root ('staging-' + [Guid]::NewGuid().ToString('N')); Set-PrivateDirectory $stage
        $base = $script:Policy.BaseUrl.TrimEnd('/') + '/v' + $version + '/'
        $manifestPath = Join-Path $stage 'release-manifest.psd1'; $cat = Join-Path $stage 'release.cat'
        Get-ReleaseFile ($base + 'release-manifest.psd1') $manifestPath 4194304 $script:Policy
        Assert-Signed $manifestPath $script:Policy.SignerThumbprint
        $m = Import-PowerShellDataFile -LiteralPath $manifestPath; Assert-Manifest $m $script:Policy 'x64'
        Get-ReleaseFile ($base + 'release.cat') $cat 8388608 $script:Policy
        Assert-Hash $cat $m.CatalogSha256; Assert-Signed $cat $script:Policy.SignerThumbprint
        $archive = Join-Path $stage $m.Archive; Get-ReleaseFile ($base + $m.Archive) $archive $script:Policy.MaxArchiveBytes $script:Policy
        Assert-Hash $archive $m.ArchiveSha256
        $payload = Join-Path $stage 'payload'; Expand-VerifiedArchive $archive $payload $m $script:Policy
        Assert-Payload $payload $cat $m $script:Policy
        # Only verified publisher files can now execute. This check does not run any model.
        $node = Join-Path $payload 'runtime\node.exe'
        $reported = & $node --version
        if ($LASTEXITCODE -ne 0 -or $reported.Trim() -cne ('v' + $m.NodeVersion)) { Fail 'NODE_VERSION_REJECTED' }
        $probe = & $node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE VIRTUAL TABLE p USING fts5(t)');db.close();"
        if ($LASTEXITCODE -ne 0) { Fail 'NODE_SQLITE_UNAVAILABLE' }
        [IO.Directory]::Move($payload, $target)
        # Retain signed metadata outside payload; previous versions remain unchanged for rollback.
        $meta = Join-Path $root ('receipts\' + $version); Set-PrivateDirectory $meta
        [IO.File]::Copy($manifestPath, (Join-Path $meta 'release-manifest.psd1'), $false)
        [IO.File]::Copy($cat, (Join-Path $meta 'release.cat'), $false)
        $script:PathBeforeInstall = $oldPath
        Publish-Shim $root $version { param($bin) try { [Environment]::SetEnvironmentVariable('Path', (Merge-UserPath $script:PathBeforeInstall $bin), 'User') } catch { [Environment]::SetEnvironmentVariable('Path', $script:PathBeforeInstall, 'User'); throw } }
        Write-Output 'SKF installed in the current user directory. Reopen terminal, then: skf.cmd onboard'
        Write-Output 'No tools or publication permissions were granted. Configuration/data were not migrated or deleted.'
    } finally {
        if ($stage -and (Test-Path -LiteralPath $stage)) { Assert-NoReparse $stage; if (-not $stage.StartsWith($root + '\staging-', [StringComparison]::OrdinalIgnoreCase)) { Fail 'CLEANUP_PATH_REJECTED' }; Remove-Item -LiteralPath $stage -Recurse -Force }
        if ($lock) { $lock.Dispose() }
    }
}
if (-not $LibraryOnly) {
    try { Invoke-SkfInstall -Remove:$Uninstall } catch {
        $code = $_.Exception.Message
        if ($code -notmatch '^[A-Z][A-Z0-9_]+$') { $code = 'INSTALL_FAILED_REVIEW_LOCAL_SYSTEM' }
        [Console]::Error.WriteLine($code); exit 1
    }
}
