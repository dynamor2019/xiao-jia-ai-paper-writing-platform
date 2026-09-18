import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));

async function copyRuntimeFile(source, target) {
  if (!existsSync(source)) throw new Error(`运行时源码不存在: ${source}`);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { force: true, recursive: true });
}

async function removeConflictingFlatSkill(targetRoot, skillName) {
  const flatPath = join(targetRoot, `${skillName}.md`);
  if (!existsSync(flatPath)) return;
  const content = await readFile(flatPath, 'utf8');
  if (!new RegExp(`^---\\s*[\\s\\S]*?^name:\\s*${skillName}\\s*$`, 'm').test(content)) {
    throw new Error(`拒绝删除无法确认归属的同名 skill: ${flatPath}`);
  }
  await rm(flatPath);
}

export async function syncDshRuntime() {
  const skillSource = join(PROJECT_ROOT, '.dsh', 'skills');
  const skillTarget = join(DSH_HOME, 'skills');
  await mkdir(skillTarget, { recursive: true });
  const skills = (await readdir(skillSource, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  for (const skill of skills) {
    await removeConflictingFlatSkill(skillTarget, skill.name);
    await copyRuntimeFile(join(skillSource, skill.name), join(skillTarget, skill.name));
  }

  const profileSource = join(PROJECT_ROOT, 'config', 'dsh', 'web');
  const profileTarget = join(DSH_HOME, 'profiles', 'web');
  for (const file of ['paper-command.js', 'academic-search.js', 'research-memory.js', 'cordis.patch.yml']) {
    await copyRuntimeFile(join(profileSource, file), join(profileTarget, file));
  }

  const presetSource = join(PROJECT_ROOT, 'config', 'dsh', 'presets', 'paper');
  const presetTarget = join(DSH_HOME, '.agent-presets', 'paper');
  for (const file of ['agent.cordis.yml', 'preset.yml']) {
    await copyRuntimeFile(join(presetSource, file), join(presetTarget, file));
  }

  return { dshHome: DSH_HOME, skills: skills.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await syncDshRuntime();
  console.log(`DSH 运行时已同步: ${result.skills} 个论文 skills -> ${result.dshHome}`);
}
