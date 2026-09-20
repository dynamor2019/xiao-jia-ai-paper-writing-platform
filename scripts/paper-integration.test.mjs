import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WORKBENCH_STAGE_LABELS, prepareProjectInput } from '../config/dsh/web/paper-command.js';
import { PIPELINE_STAGES } from '../src/workflows/paper-pipeline.ts';
import { resolvePaperModelEnv } from './paper-model-env.mjs';

test('workbench stages match the pipeline contract', () => {
  assert.deepEqual(WORKBENCH_STAGE_LABELS.map(([id]) => id), PIPELINE_STAGES);
});

test('paper inputs stay in their own project directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-input-'));
  try {
    const source = join(root, 'reference.pdf');
    await writeFile(source, 'sample A');
    const first = await prepareProjectInput(join(root, 'paper-a'), source);
    await writeFile(source, 'sample B');
    const second = await prepareProjectInput(join(root, 'paper-b'), source);
    assert.equal(await readFile(join(first, 'reference.pdf'), 'utf8'), 'sample A');
    assert.equal(await readFile(join(second, 'reference.pdf'), 'utf8'), 'sample B');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('paper model settings use Web credentials when env keys are absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-model-env-'));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    rayinai:\n      apiKeyEnv: WEB_OPENAI_KEY\n      baseURL: https://proxy.example/v1\n      api: openai-responses\n    rayinai-claude:\n      apiKeyEnv: WEB_CLAUDE_KEY\n      baseURL: https://proxy.example/v1\n      api: openai-completions\n');
    await writeFile(join(root, '.credentials.yaml'), 'refs:\n  WEB_OPENAI_KEY: web-openai-secret\n  WEB_CLAUDE_KEY: web-claude-secret\n');
    const fromWeb = resolvePaperModelEnv({}, root);
    assert.equal(fromWeb.OPENAI_API_KEY, 'web-openai-secret');
    assert.equal(fromWeb.ANTHROPIC_API_KEY, 'web-claude-secret');
    assert.equal(fromWeb.ANTHROPIC_API_MODE, 'openai-completions');
    const fromEnv = resolvePaperModelEnv({ OPENAI_API_KEY: 'env-secret', OPENAI_BASE_URL: 'https://official.example/v1' }, root);
    assert.equal(fromEnv.OPENAI_API_KEY, 'env-secret');
    assert.equal(fromEnv.OPENAI_BASE_URL, 'https://official.example/v1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a CLI project can be attached to a Web session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojia-paper-attach-'));
  const previousRoot = process.env.PAPER_DATA_ROOT;
  const previousProject = process.env.DSH_PAPER_PROJECT_DIR;
  try {
    process.env.PAPER_DATA_ROOT = root;
    process.env.DSH_PAPER_PROJECT_DIR = root;
    const projectDir = join(root, 'output', 'paper-projects', 'paper-cli-1');
    await mkdir(join(projectDir, '.dsh-state'), { recursive: true });
    await writeFile(join(projectDir, '.dsh-state', 'paper-pipeline-state.json'), JSON.stringify({
      topic: 'Sample topic', stage: 'literature-search', metadata: { paperProjectId: 'paper-cli-1' },
    }));
    const { apply } = await import(`../config/dsh/web/paper-command.js?attach=${Date.now()}`);
    const commands = new Map();
    apply({
      commands: { register: (command) => commands.set(command.name, command) },
      systemPrompt: { context: () => {} },
      effect: () => {},
    });
    const result = await commands.get('paper-attach').handler({ rawInput: 'paper-cli-1', agent: { id: 'session-one' } });
    assert.equal(result.kind, 'success');
    const state = JSON.parse(await readFile(join(root, '.dsh-state', 'paper-runs', 'session-one.json'), 'utf8'));
    assert.equal(state.paperProjectId, 'paper-cli-1');
    assert.equal(state.outputDir, projectDir);
  } finally {
    if (previousRoot === undefined) delete process.env.PAPER_DATA_ROOT;
    else process.env.PAPER_DATA_ROOT = previousRoot;
    if (previousProject === undefined) delete process.env.DSH_PAPER_PROJECT_DIR;
    else process.env.DSH_PAPER_PROJECT_DIR = previousProject;
    await rm(root, { recursive: true, force: true });
  }
});
