import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

import { PROJECT_ROOT, resolveDataRoot } from './project-paths.mjs';

const DSH_HOME = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
const SAFE_DEFAULT_MODEL = { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
const PROVIDER_CREDENTIAL_ENV = {
  rayinai: 'OPENAI_API_KEY',
  'rayinai-claude': 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_OFFICIAL_API_KEY',
  anthropic: 'ANTHROPIC_OFFICIAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

async function copyRuntimeFile(source, target) {
  if (!existsSync(source)) throw new Error(`运行时源码不存在: ${source}`);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { force: true, recursive: true });
}

async function copyRenderedRuntimeFile(source, target) {
  await copyRuntimeFile(source, target);
  const content = await readFile(target, 'utf8');
  const rendered = content
    .replaceAll('__DSH_PAPER_PROJECT_DIR__', PROJECT_ROOT)
    .replaceAll('__PAPER_DATA_ROOT__', resolveDataRoot());
  if (rendered !== content) await writeFile(target, rendered, 'utf8');
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

function readYamlFile(path) {
  return existsSync(path) ? parse(readFileSync(path, 'utf8')) || {} : {};
}

async function repairMissingDefaultModelCredential() {
  const settingsPath = join(DSH_HOME, 'settings.yaml');
  if (!existsSync(settingsPath)) return false;
  const settings = readYamlFile(settingsPath);
  const current = settings['agent-default-model'];
  const provider = typeof current?.provider === 'string' ? current.provider : '';
  if (!provider || defaultModelHasCredential(provider)) return false;
  settings['agent-default-model'] = { ...SAFE_DEFAULT_MODEL };
  await writeFile(settingsPath, stringify(settings), 'utf8');
  return true;
}

function defaultModelHasCredential(provider) {
  const envName = PROVIDER_CREDENTIAL_ENV[provider];
  if (!envName) return true;
  if (process.env[envName]?.trim()) return true;
  const credentials = readYamlFile(join(DSH_HOME, '.credentials.yaml'));
  return typeof credentials.refs?.[envName] === 'string' && credentials.refs[envName].trim().length > 0;
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
  for (const file of ['paper-command.js', 'paper-feedback.js', 'academic-search.js', 'research-memory.js', 'model-router.js', 'cordis.patch.yml']) {
    await copyRenderedRuntimeFile(join(profileSource, file), join(profileTarget, file));
  }

  const presetSource = join(PROJECT_ROOT, 'config', 'dsh', 'presets', 'paper');
  const presetTarget = join(DSH_HOME, '.agent-presets', 'paper');
  for (const file of ['agent.cordis.yml', 'preset.yml']) {
    await copyRenderedRuntimeFile(join(presetSource, file), join(presetTarget, file));
  }

  const repairedDefaultModel = await repairMissingDefaultModelCredential();
  return { dshHome: DSH_HOME, skills: skills.length, repairedDefaultModel };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await syncDshRuntime();
  console.log(`DSH 运行时已同步: ${result.skills} 个论文 skills -> ${result.dshHome}`);
  if (result.repairedDefaultModel) console.log('已将缺少凭据的默认模型重置为 DeepSeek 默认模型。');
}
