import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLATFORM_REPO, MANIFEST_ASSET, fileHash, productPath, validateUpdateManifest } from './platform-update-files.mjs';
import { powershellLiteral, runUpdatePowerShell } from './platform-update-extract.mjs';

/** Add compiled runtime without old test outputs or local install artifacts. */
function compiledFiles(root, relative = 'dist') {
  if (!existsSync(join(root, relative))) return [];
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) return compiledFiles(root, child);
    return entry.isFile() && !entry.name.includes('.test.') ? [child] : [];
  });
}

/** Package only tracked public product files and the compiled runtime, never the working directory. */
export function packagePlatformUpdate(root, output) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const tag = `v${version}`;
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const publicFiles = tracked.filter(productPath);
  const sources = new Set(publicFiles);
  const runtime = compiledFiles(root).filter(path => sources.has(path.replace(/^dist\//, 'src/')
    .replace(/(?:\.d\.ts|\.js(?:\.map)?)$/, '.ts')));
  const files = [...new Set([...publicFiles, ...runtime])].sort();
  const hashes = Object.fromEntries(files.map(path => [path, fileHash(join(root, path))]));
  mkdirSync(output, { recursive: true });
  const list = join(output, 'update-files.json');
  writeFileSync(list, JSON.stringify(files));
  const name = `XiaoJiaAI-Source-${tag}.zip`;
  const archive = join(output, name);
  if (existsSync(archive)) throw new Error('Release archive already exists; choose a fresh output directory');
  runUpdatePowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = ${powershellLiteral(root)}
$files = Get-Content -LiteralPath ${powershellLiteral(list)} -Raw -Encoding UTF8 | ConvertFrom-Json
$zip = [IO.Compression.ZipFile]::Open(${powershellLiteral(archive)}, [IO.Compression.ZipArchiveMode]::Create)
try { foreach ($file in $files) {
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $file), $file, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
} } finally { $zip.Dispose() }
`);
  const manifest = validateUpdateManifest({ format: 1, repository: PLATFORM_REPO,
    version, asset: { name, sha256: fileHash(archive) }, files: hashes }, tag);
  writeFileSync(join(output, MANIFEST_ASSET), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Platform update packaged: ${files.length} files, ${name}`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packagePlatformUpdate(process.cwd(), resolve(process.cwd(), 'release'));
}
