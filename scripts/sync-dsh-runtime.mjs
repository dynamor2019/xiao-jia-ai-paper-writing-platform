import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, parseDocument, stringify } from 'yaml';

import { PROJECT_ROOT, resolveDataRoot } from './project-paths.mjs';
import { assertSharedRuntimeCompatible } from './shared-runtime-guard.mjs';

const DSH_HOME = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
const PROVIDER_CREDENTIAL_ENV = {
  rayinai: 'OPENAI_API_KEY',
  'rayinai-claude': 'ANTHROPIC_API_KEY',
  'sub2api-grok': 'SUB2API_API_KEY',
  openai: 'OPENAI_OFFICIAL_API_KEY',
  anthropic: 'ANTHROPIC_OFFICIAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};
const GROK_PROVIDER = {
  displayName: 'Sub2API Grok',
  apiKeyEnv: 'SUB2API_API_KEY',
  api: 'openai-responses',
  baseURL: 'https://api-slb.rayinai.com/v1',
  transport: 'sse',
  // Figure checks use this provider. Text chat stays text; image is only sent by an image tool.
  defaultInput: ['text', 'image'],
  models: [
    { id: 'grok-4.7', name: 'Grok 4.7' },
  ],
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

async function ensureGrokProvider() {
  const settingsPath = join(DSH_HOME, 'settings.yaml');
  const importedPath = `${settingsPath}.imported`;
  const sourcePath = existsSync(settingsPath) ? settingsPath : importedPath;
  const original = existsSync(sourcePath) ? readFileSync(sourcePath) : undefined;
  const hasBom = original?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || false;
  const originalText = original ? new TextDecoder('utf-8', { fatal: true }).decode(original) : '';
  const document = parseDocument(originalText);
  if (document.errors.length) throw document.errors[0];
  let changed = false;

  const envModels = (providerId, prefix, defaults) => {
    const models = new Set(defaults);
    const configuredModel = process.env[`${prefix}_MODEL`]?.trim();
    if (configuredModel) models.add(configuredModel);
    for (const [key, model] of Object.entries(process.env)) {
      if (!/^ROUTE_.+_MODEL$/u.test(key) || !model?.trim()) continue;
      const route = key.replace(/_MODEL$/u, '_PROVIDER');
      if (process.env[route]?.trim().toLowerCase() === providerId) models.add(model.trim());
    }
    return [...models].map((id) => ({ id, name: id }));
  };

  const openaiModels = envModels('openai', 'OPENAI', [
    'codex-auto-review',
    'gpt-5.5',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-6-astra',
    'gpt-6-luna',
    'gpt-6-sol',
    'gpt-6.1-sol',
  ]);
  const claudeModels = [
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-opus-5-5',
    'claude-opus-5',
  ].map((id) => ({ id, name: id }));
  const providers = [
    ['rayinai', {
      displayName: 'RayinAI OpenAI',
      apiKeyEnv: 'OPENAI_API_KEY',
      api: 'openai-completions',
      baseURL: process.env.OPENAI_BASE_URL?.trim() || 'https://api-slb.rayinai.com/v1',
      models: openaiModels,
    }],
    ['rayinai-claude', {
      displayName: 'Sub2API Anthropic',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://api-slb.rayinai.com/v1',
      models: claudeModels,
    }],
  ];
  for (const [providerId, config] of providers) {
    const providerPath = ['llm-pi-ai', 'providers', providerId];
    if (!document.hasIn(providerPath)) {
      document.setIn(providerPath, config);
      changed = true;
      continue;
    }

    const settings = document.toJSON() || {};
    const current = settings['llm-pi-ai']?.providers?.[providerId] || {};
    const currentModels = Array.isArray(current.models) ? current.models : [];
    const nextModels = providerId === 'rayinai-claude'
      ? config.models
      : [...currentModels, ...config.models.filter((model) => !currentModels.some((entry) => entry?.id === model.id))];
    const next = providerId === 'rayinai-claude'
      ? { ...current, ...config, defaultInput: ['text', 'image'] }
      : { ...current, models: nextModels, defaultInput: ['text', 'image'] };
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      document.setIn(providerPath, next);
      changed = true;
    }
  }

  const providerPath = ['llm-pi-ai', 'providers', 'sub2api-grok'];
  if (!document.hasIn(providerPath)) {
    document.setIn(providerPath, GROK_PROVIDER);
    changed = true;
  } else {
    const settings = document.toJSON() || {};
    const current = settings['llm-pi-ai']?.providers?.['sub2api-grok'] || {};
    const next = { ...current, ...GROK_PROVIDER };
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      document.setIn(providerPath, next);
      changed = true;
    }
  }
  if (!changed && sourcePath === settingsPath) return false;
  await mkdir(dirname(settingsPath), { recursive: true });
  const lineEnding = originalText.includes('\r\n') ? '\r\n' : '\n';
  const rendered = document.toString().replaceAll('\n', lineEnding);
  await writeFile(settingsPath, Buffer.from(`${hasBom ? '\ufeff' : ''}${rendered}`, 'utf8'));
  return true;
}

async function repairMissingDefaultModelCredential() {
  const settingsPath = join(DSH_HOME, 'settings.yaml');
  if (!existsSync(settingsPath)) return false;
  const settings = readYamlFile(settingsPath);
  const current = settings['agent-default-model'];
  const provider = typeof current?.provider === 'string' ? current.provider : '';
  if (!provider || defaultModelHasCredential(provider)) return false;
  console.warn(`默认模型 ${provider}/${current.model || ''} 缺少凭据；已保留用户选择，请在模型设置中补充。`);
  return false;
}

function defaultModelHasCredential(provider) {
  const envName = PROVIDER_CREDENTIAL_ENV[provider];
  if (!envName) return true;
  if (process.env[envName]?.trim()) return true;
  const credentials = readYamlFile(join(DSH_HOME, '.credentials.yaml'));
  return typeof credentials.refs?.[envName] === 'string' && credentials.refs[envName].trim().length > 0;
}

export async function syncAgentPresets(profileTarget) {
  const presetsRoot = join(PROJECT_ROOT, 'config', 'dsh', 'presets');
  const presetDirs = (await readdir(presetsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const declarations = [];

  for (const entry of presetDirs) {
    const presetDir = join(presetsRoot, entry.name);
    const metadata = parse(await readFile(join(presetDir, 'preset.yml'), 'utf8')) || {};
    const plugins = await readFile(join(presetDir, 'agent.cordis.yml'), 'utf8');
    if (!/^\s*- id:/m.test(plugins)) throw new Error(`无效的 agent preset: ${entry.name}`);

    const assetDir = join(profileTarget, 'agent-presets', entry.name);
    await mkdir(assetDir, { recursive: true });
    for (const asset of await readdir(presetDir, { withFileTypes: true })) {
      if (asset.isFile() && (asset.name.endsWith('.mjs') || asset.name === 'NOTICE')) {
        await cp(join(presetDir, asset.name), join(assetDir, asset.name), { force: true });
      }
    }

    const rewrittenPlugins = plugins
      .replace(/^(\s*name:\s*)\.\/(.+)$/gm, `$1./agent-presets/${entry.name}/$2`)
      .replaceAll('__DSH_PAPER_PROJECT_DIR__', PROJECT_ROOT)
      .replaceAll('__PAPER_DATA_ROOT__', resolveDataRoot());
    const order = Number.isFinite(metadata.order) ? `        order: ${metadata.order}\n` : '';
    declarations.push([
      `    - id: preset-${entry.name}`,
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      `        id: ${entry.name}`,
      `        name: ${JSON.stringify(metadata.name || entry.name)}`,
      `        description: ${JSON.stringify(metadata.description || '')}`,
      order.trimEnd(),
      '        plugins:',
      rewrittenPlugins.trimEnd().split(/\r?\n/).map((line) => `          ${line}`).join('\n'),
    ].filter(Boolean).join('\n'));
  }

  const patchPath = join(profileTarget, 'cordis.patch.yml');
  const patchText = await readFile(patchPath, 'utf8');
  const eol = patchText.includes('\r\n') ? '\r\n' : '\n';
  const defaultPatch = `- id: agent-preset-registry${eol}`;
  if (patchText.split(defaultPatch).length !== 2) throw new Error('论文 agent 默认 preset 配置项缺失或重复');
  const presetPatch = `- insert:\n${declarations.join('\n')}\n`.replaceAll('\n', eol);
  await writeFile(patchPath, patchText.replace(defaultPatch, `${presetPatch}${defaultPatch}`), 'utf8');
  return declarations.length;
}

export async function syncDshRuntime() {
  assertSharedRuntimeCompatible(PROJECT_ROOT, DSH_HOME);
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
  const presets = await syncAgentPresets(profileTarget);

  const presetSource = join(PROJECT_ROOT, 'config', 'dsh', 'presets', 'paper');
  const presetTarget = join(DSH_HOME, '.agent-presets', 'paper');
  for (const file of ['agent.cordis.yml', 'preset.yml']) {
    await copyRenderedRuntimeFile(join(presetSource, file), join(presetTarget, file));
  }

  // API 配置收敛：provider 定义只存在 cordis.patch.yml（权威源），
  // 不再向 settings.yaml 写入 providers 副本，避免多份配置互相覆盖。
  const repairedDefaultModel = await repairMissingDefaultModelCredential();
  return { dshHome: DSH_HOME, skills: skills.length, presets, repairedDefaultModel };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await syncDshRuntime();
  console.log(`DSH 运行时已同步: ${result.skills} 个论文 skills -> ${result.dshHome}`);
  console.log(`DSH agent 预设已同步: ${result.presets} 套`);
  if (result.repairedDefaultModel) console.log('已将缺少凭据的默认模型重置为 DeepSeek 默认模型。');
}
