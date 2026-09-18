/**
 * Paper Agent - 基于 DeepSeek Harness 的长链路学术论文撰写 Agent
 *
 * 开发诊断入口：展示核心流水线插件和模型路由；Web 运行时由 scripts/start-dsh-web.mjs 启动。
 */

import { dshConfig } from './config/dsh.config.js';
import { printRoutingTable } from './config/model-routing.js';

// 导入所有插件
import { arxivSearchPlugin } from './plugins/literature/arxiv-search.js';
import { pdfParserPlugin } from './plugins/literature/pdf-parser.js';
import { paperSummarizerPlugin } from './plugins/literature/paper-summarizer.js';
import { outlineGeneratorPlugin } from './plugins/writing/outline-generator.js';
import { sectionWriterPlugin } from './plugins/writing/section-writer.js';
import { coherenceCheckerPlugin } from './plugins/writing/coherence-checker.js';
import { citationVerifierPlugin } from './plugins/verification/citation-verifier.js';
import { plagiarismCheckerPlugin } from './plugins/verification/plagiarism-checker.js';
import { docxExporterPlugin } from './plugins/export/docx-exporter.js';
import { latexExporterPlugin } from './plugins/export/latex-exporter.js';

// 加载环境变量
async function loadEnv() {
  try {
    const dotenv = await import('dotenv');
    dotenv.config();
  } catch {
    // dotenv 可选，未安装时使用系统环境变量
  }
}

// 注册所有自定义插件
const allPlugins = [
  arxivSearchPlugin,
  pdfParserPlugin,
  paperSummarizerPlugin,
  outlineGeneratorPlugin,
  sectionWriterPlugin,
  coherenceCheckerPlugin,
  citationVerifierPlugin,
  plagiarismCheckerPlugin,
  docxExporterPlugin,
  latexExporterPlugin,
];

/**
 * 启动 dsh Web UI
 *
 * 注意：dsh 处于开发者预览版，具体启动 API 可能随版本变化。
 * 以下代码展示了插件注册的概念，实际运行时请参考 dsh 官方文档。
 * 如果 dsh 的编程式 API 有变动，可以改用 CLI 方式：
 *   npx @deepseek-ai/dsh web --config src/config/dsh.config.ts
 */
async function startWebUI() {
  await loadEnv();

  console.log('🚀 Paper Agent 启动中...');
  console.log(`📋 已注册 ${allPlugins.length} 个插件:`);
  allPlugins.forEach((p) => console.log(`   - ${p.name}: ${p.description}`));

  // 打印模型路由配置
  printRoutingTable();

  console.log(`\n工作流: 20 阶段科技论文研究生命周期`);
  console.log(`   选题→文献检索→精读→大纲→逐段写作→引用核验→润色→质量门禁→排版→导出`);

  console.log(`\n⚙️  配置:`);
  console.log(`   端口: ${dshConfig.port}`);
  console.log(`   沙箱: ${dshConfig.sandbox.enabled ? '启用' : '禁用'}`);
  console.log(`   持久化: ${dshConfig.persistence.enabled ? '启用' : '禁用'}`);

  // ===== dsh 启动代码（需根据实际 API 调整）=====
  // dsh 目前主要通过 CLI 启动，编程式 API 可能在后续版本完善。
  // 推荐使用方式：在 package.json 中配置 "web": "dsh web"
  //
  // 当 dsh 提供编程式 API 时，代码大致如下：
  //
  // import { createHarness } from '@deepseek-ai/dsh';
  // const harness = createHarness(dshConfig);
  // allPlugins.forEach(plugin => harness.use(plugin));
  // await harness.start({ port: dshConfig.port });
  //
  // ============================================

  console.log(`\n📌 启动方式：`);
  console.log(`   1. Web UI:  npm run web`);
  console.log(`   2. 命令行:  npm run paper -- "你的论文选题"`);
  console.log(`   3. 开发模式: npm run dev`);

  console.log(`\n⚠️  dsh 处于开发者预览版，如遇 API 不兼容请查看官方文档`);
  console.log(`   GitHub: https://github.com/deepseek-ai/deepseek-harness`);
}

// 启动
startWebUI().catch(console.error);

export { allPlugins, dshConfig };
