/**
 * Backup retention policy for state files
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MAX_BACKUPS_PER_FILE = 3;

/**
 * Keep only the N most recent backups for a given file, delete older ones
 */
export function pruneOldBackups(baseFile: string, maxBackups: number = MAX_BACKUPS_PER_FILE): void {
  if (!existsSync(baseFile)) return;

  const dir = dirname(baseFile);
  const name = basename(baseFile);

  try {
    const allFiles = readdirSync(dir);
    const backups = allFiles
      .filter(f => f.startsWith(name) && f.includes('.before-') && f.endsWith('.bak'))
      .map(f => {
        const fullPath = join(dir, f);
        return {
          name: f,
          path: fullPath,
          mtime: statSync(fullPath).mtimeMs
        };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    // Keep maxBackups, delete the rest
    const toDelete = backups.slice(maxBackups);
    for (const backup of toDelete) {
      unlinkSync(backup.path);
    }

    if (toDelete.length > 0) {
      console.log(`[backup-cleanup] Pruned ${toDelete.length} old backups for ${name}`);
    }
  } catch (err) {
    // Non-fatal: backup cleanup failure shouldn't block the workflow
    console.warn(`[backup-cleanup] Failed to prune backups for ${baseFile}:`, err);
  }
}
