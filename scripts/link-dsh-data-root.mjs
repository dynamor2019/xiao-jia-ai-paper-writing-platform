import fs from 'node:fs';
import path from 'node:path';
import { resolveDataRoot } from './project-paths.mjs';

const projectDir = process.cwd();
const dataRoot = resolveDataRoot();

function assertInsideProject(targetPath) {
  const relative = path.relative(projectDir, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify path outside project: ${targetPath}`);
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function mergeDirectoryContents(sourceDir, targetDir) {
  ensureDir(targetDir);
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (fs.existsSync(targetPath)) {
      const targetStat = fs.lstatSync(targetPath);
      if (entry.isDirectory() && targetStat.isDirectory()) {
        mergeDirectoryContents(sourcePath, targetPath);
        fs.rmdirSync(sourcePath);
        continue;
      }
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      fs.renameSync(sourcePath, `${targetPath}.migrated-${stamp}`);
      continue;
    }
    fs.renameSync(sourcePath, targetPath);
  }
}

function ensureJunction(linkPath, targetPath) {
  assertInsideProject(linkPath);
  ensureDir(targetPath);
  ensureDir(path.dirname(linkPath));

  if (fs.existsSync(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.realpathSync(linkPath);
      const wantedTarget = fs.realpathSync(targetPath);
      if (currentTarget.toLowerCase() === wantedTarget.toLowerCase()) {
        return 'already-linked';
      }
      fs.unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      mergeDirectoryContents(linkPath, targetPath);
      fs.rmdirSync(linkPath);
    } else {
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      fs.renameSync(linkPath, `${linkPath}.migrated-${stamp}`);
    }
  }

  fs.symlinkSync(targetPath, linkPath, 'junction');
  return 'linked';
}

const links = [
  ['output', path.join(dataRoot, 'output')],
  [path.join('papers', 'input'), path.join(dataRoot, 'papers', 'input')],
  ['.dsh-state', path.join(dataRoot, '.dsh-state')],
];

const results = links.map(([relativeLink, targetPath]) => {
  const linkPath = path.join(projectDir, relativeLink);
  const status = ensureJunction(linkPath, targetPath);
  return { linkPath, targetPath, status };
});

for (const result of results) {
  console.log(`${result.status}: ${result.linkPath} -> ${result.targetPath}`);
}
