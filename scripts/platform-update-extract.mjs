import { execFileSync } from 'node:child_process';

/** Quote literal paths for a fixed PowerShell program, never interpolate shell code. */
export function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Validate ZIP entries before extracting; reject links, traversal, duplicates and zip bombs. */
export function extractUpdateArchive(archive, destination, manifestPath) {
  if (process.platform !== 'win32') throw new Error('此自动安装器当前仅支持 Windows');
  const command = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifest = Get-Content -LiteralPath ${powershellLiteral(manifestPath)} -Raw -Encoding UTF8 | ConvertFrom-Json
$allowed = @{}
foreach ($property in $manifest.files.PSObject.Properties) { $allowed[$property.Name] = $true }
$seen = @{}
$zip = [IO.Compression.ZipFile]::OpenRead(${powershellLiteral(archive)})
try {
  $total = 0L
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if ($name.Contains('\\') -or $name.Contains(':') -or $name.StartsWith('/') -or $name.Split('/') -contains '..') { throw 'Unsafe ZIP path' }
    if ($name.EndsWith('/')) { throw 'Unexpected directory entry' }
    if (-not $allowed.ContainsKey($name) -or $seen.ContainsKey($name)) { throw 'Unexpected or duplicate ZIP entry' }
    if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'ZIP symbolic link rejected' }
    $total += $entry.Length
    if ($total -gt 104857600) { throw 'Uncompressed update too large' }
    $seen[$name] = $true
  }
  if ($seen.Count -ne $allowed.Count) { throw 'Incomplete ZIP entries' }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory(${powershellLiteral(archive)}, ${powershellLiteral(destination)})
`;
  runUpdatePowerShell(command);
}

/** Execute only our fixed archive program in a hidden child process. */
export function runUpdatePowerShell(command) {
  if (process.platform !== 'win32') throw new Error('此归档操作当前仅支持 Windows');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
}
