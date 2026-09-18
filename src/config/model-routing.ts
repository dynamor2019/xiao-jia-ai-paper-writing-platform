/**
 * 模型路由配置
 *
 * 不同任务类型路由到不同的模型（OpenAI / Claude）
 * 通过 .env 中的 ROUTE_XXX_PROVIDER 和 ROUTE_XXX_MODEL 控制
 */

export type ModelProvider = 'openai' | 'claude';

export type TaskType =
  | 'discovery'  // 联网选题与创新性/可行性评估
  | 'protocol'   // 研究方案与实验设计
  | 'summary'    // 文献摘要
  | 'outline'    // 大纲生成
  | 'writing'    // 段落写作
  | 'coherence'  // 连贯性检查
  | 'citation'   // 引用核验
  | 'quality'    // 独立科技论文质量审查
  | 'qualityCrossReview' // 第二评审模型交叉审查
  | 'polish';    // 润色改写

export interface ModelRoute {
  provider: ModelProvider;
  model: string;
}

/** 默认路由配置（可被 .env 中的 ROUTE_XXX 覆盖） */
const DEFAULT_ROUTES: Record<TaskType, ModelRoute> = {
  discovery: { provider: 'claude', model: 'claude-opus-5' },  // 选题：使用最强推理模型综合联网证据
  protocol:  { provider: 'claude', model: 'claude-opus-5' }, // 方案：独立审查假设、对照和统计设计
  summary:   { provider: 'claude', model: 'claude-sonnet-5' }, // 文献精读：需要提取可核验论据
  outline:   { provider: 'claude', model: 'claude-opus-5' },  // 大纲：决定论证链和贡献点
  writing:   { provider: 'claude', model: 'claude-sonnet-5' },  // 正文：优先严谨、结构和证据约束
  coherence: { provider: 'claude', model: 'claude-sonnet-5' }, // 连贯性：检查论证断裂和重复
  citation:  { provider: 'claude', model: 'claude-opus-5' }, // 引用核验：宁严勿松
  quality:   { provider: 'claude', model: 'claude-opus-5' },  // 独立审查：与正文写作模型分离
  qualityCrossReview: { provider: 'claude', model: 'claude-sonnet-5' }, // 交叉审查：第二模型模拟审稿专家
  polish:    { provider: 'claude', model: 'claude-sonnet-5' }, // 润色：保守改写，不新增事实
};

const DEFAULT_FALLBACK_ROUTES: Record<TaskType, ModelRoute> = {
  discovery: { provider: 'claude', model: 'claude-opus-5' },
  protocol: { provider: 'openai', model: 'gpt-5.6-sol' },
  summary: { provider: 'claude', model: 'claude-sonnet-5' },
  outline: { provider: 'openai', model: 'gpt-5.6-sol' },
  writing: { provider: 'openai', model: 'gpt-5.6-terra' },
  coherence: { provider: 'claude', model: 'claude-sonnet-5' },
  citation: { provider: 'claude', model: 'claude-sonnet-5' },
  quality: { provider: 'openai', model: 'gpt-5.6-sol' },
  qualityCrossReview: { provider: 'claude', model: 'claude-opus-5' },
  polish: { provider: 'claude', model: 'claude-sonnet-5' },
};

/**
 * 根据任务类型获取路由配置
 * 优先级：环境变量 > 默认值
 */
export function getRoute(task: TaskType): ModelRoute {
  const envPrefix = `ROUTE_${task.toUpperCase()}`;
  const envProvider = process.env[`${envPrefix}_PROVIDER`] as ModelProvider | undefined;
  const envModel = process.env[`${envPrefix}_MODEL`];
  const def = DEFAULT_ROUTES[task];
  return {
    provider: envProvider || def.provider,
    model: envModel || def.model,
  };
}

/** Return the task's primary route and one cross-provider recovery route. */
export function getRouteCandidates(task: TaskType): ModelRoute[] {
  const primary = getRoute(task);
  const envPrefix = `ROUTE_${task.toUpperCase()}_FALLBACK`;
  const fallback = {
    provider: (process.env[`${envPrefix}_PROVIDER`] as ModelProvider | undefined)
      || DEFAULT_FALLBACK_ROUTES[task].provider,
    model: process.env[`${envPrefix}_MODEL`] || DEFAULT_FALLBACK_ROUTES[task].model,
  };
  if (fallback.provider === primary.provider && fallback.model === primary.model) return [primary];
  return [primary, fallback];
}

/** 获取 provider 的默认模型 */
export function getDefaultModel(provider: ModelProvider): string {
  if (provider === 'claude') {
    return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  }
  return process.env.OPENAI_MODEL || 'gpt-5.6-terra';
}

/** 获取 provider 的 API Key */
export function getApiKey(provider: ModelProvider): string {
  if (provider === 'claude') {
    return process.env.ANTHROPIC_API_KEY || '';
  }
  return process.env.OPENAI_API_KEY || '';
}

/** 获取 provider 的 Base URL */
export function getBaseUrl(provider: ModelProvider): string {
  if (provider === 'claude') {
    return process.env.ANTHROPIC_BASE_URL || process.env.PROXY_BASE_URL || 'https://api.anthropic.com';
  }
  return process.env.OPENAI_BASE_URL || `${process.env.PROXY_BASE_URL || 'https://api.openai.com'}/v1`;
}

/** 打印当前路由配置（启动时调用） */
export function printRoutingTable(): void {
  const tasks: TaskType[] = ['discovery', 'protocol', 'summary', 'outline', 'writing', 'coherence', 'citation', 'quality', 'qualityCrossReview', 'polish'];
  console.log('\n📋 模型路由配置:');
  console.log('   '.padEnd(14) + 'Provider'.padEnd(10) + 'Model');
  console.log('   ' + '-'.repeat(50));
  for (const task of tasks) {
    const route = getRoute(task);
    console.log(`   ${task.padEnd(12)} ${route.provider.padEnd(10)} ${route.model}`);
  }
  console.log('');
}
