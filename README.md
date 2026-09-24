# 小贾AI科研论文写作平台

> 从联网选题、文献证据、研究设计、程序实验和数据验收到逐段写作、独立校验、投稿返修与发表归档的一站式桌面平台。

## 项目初衷

很多中文用户在直接使用 OpenAI 或 Claude 时，会遇到账号风控、封号或访问不稳定的问题；更痛的是，辛苦打磨出来的长对话、研究过程和写作上下文可能瞬间消失。小贾AI科研论文写作平台的初衷，就是把论文写作过程尽量留在本地，把模型调用接入到更稳定的中转站方案里，降低账号不可用带来的损失。

本项目默认面向 OpenAI-compatible 与 Anthropic-compatible 的中转接口，方便调用主流闭源大模型，同时保留本地项目文件、论文材料、输出结果和断点状态，避免把关键研究过程只放在单一网页账号里。

## 下载后快速启动

### 方式一：直接下载桌面端 exe

进入 GitHub 仓库的 **Actions** 或 **Releases** 页面，下载自动打包生成的 Windows 桌面端 zip，解压后双击里面的 `小贾AI科研论文写作平台.exe` 即可启动桌面窗口。

### 方式二：克隆源码运行

1. 安装完整 Node.js LTS 20 或更高版本：<https://nodejs.org/>
2. 双击根目录 `setup-dsh.bat`，自动安装依赖并准备 `%USERPROFILE%\Documents\XiaoJiaAI Data` 数据目录。
3. 填写 `.env` 里的模型 API 配置，也可以启动后在项目设置里填写。
4. 双击根目录 `桌面端启动小贾AI.bat`，以桌面窗口启动；也可以双击 `一键启动小贾AI.bat` 使用浏览器版。

后续再次使用时，通常只需要双击 `桌面端启动小贾AI.bat`。普通用户不用运行任何 `.ps1` 文件。

## 架构

项目内文件是唯一源码；`npm run web` 会先把 Web profile、论文 preset 和 skills 部署到 DSH 用户运行时，再启动界面。Web `/paper` 与 CLI `npm run paper:cli` 调用同一个 20 阶段研究生命周期：

```
建档 → 联网选题 → 文献/证据 → 方案冻结 → 前言 → 程序实验 → 数据验收
→ 方法/结果/讨论 → 稿件完备 → 独立门禁 → 期刊格式/投稿包 → 返修/发表归档
```

### 关键特性

- **研究生命周期**：20 阶段流水线，研究与段落级保存，单阶段失败可断点续跑
- **强制实验门禁**：程序未成功或机器可读结果未验收时，禁止撰写结果与讨论
- **防幻觉引用**：引用核验阶段逐条检查文献真实性，标记编造引用
- **人工审批节点**：选题、大纲、润色三个关键阶段可暂停等待确认
- **多模型支持**：写作模型和摘要模型可分开配置，省钱又保证质量
- **质量阻断**：源稿、独立科技审查与 DOCX 检查任一失败都不能标记完成
- **双格式输出**：Pandoc 原生公式 Word 与 LaTeX/BibTeX
- **个人文献库**：支持本地 PDF 解析，构建个人知识库

## 项目结构

```
dsh/
├── package.json
├── tsconfig.json
├── .dsh/skills/              # 论文 skills 唯一源码
├── config/dsh/               # Web profile 与 paper preset 唯一源码
├── scripts/
│   ├── start-dsh-web.mjs     # 同步运行时并启动 Web
│   ├── sync-dsh-runtime.mjs  # 项目源码 → DSH 用户运行时
│   └── md-to-docx.mjs        # Pandoc Word 导出与二次校验
├── electron/
│   └── main.cjs              # 桌面端主进程，自动承载本地 Web 服务
├── src/
│   ├── index.ts              # 主入口，注册插件启动 dsh
│   ├── types.ts              # 通用类型定义
│   ├── config/
│   │   └── dsh.config.ts     # dsh 运行配置
│   ├── lib/
│   │   └── model-client.ts   # 通用大模型调用客户端
│   ├── plugins/
│   │   ├── literature/       # 文献阶段（3个插件）
│   │   │   ├── arxiv-search.ts
│   │   │   ├── pdf-parser.ts
│   │   └── paper-summarizer.ts
│   │   ├── writing/          # 写作阶段（3个插件）
│   │   │   ├── outline-generator.ts
│   │   │   ├── section-writer.ts
│   │   │   └── coherence-checker.ts
│   │   ├── verification/     # 核验阶段（2个插件）
│   │   │   ├── citation-verifier.ts   # ⭐ 防幻觉核心
│   │   │   └── plagiarism-checker.ts
│   │   └── export/           # 输出阶段（2个插件）
│   │       ├── docx-exporter.ts
│   │       └── latex-exporter.ts
│   └── workflows/
│       ├── paper-pipeline.ts # 20 阶段 Web/CLI 共用研究生命周期
│       └── validate-paper.ts # 独立质量门禁入口
└── knowledge-base/           # 可提交的通用知识库结构
```

运行数据放在仓库外：

```text
%USERPROFILE%\Documents\XiaoJiaAI Data\
├── output/                   # 每个对话一篇论文的输出
├── papers/input/             # 本地原始文献与输入材料
└── .dsh-state/               # 工作流状态（断点续跑）
```

## 安装

### 1. 克隆后先准备本机环境

双击根目录的 `setup-dsh.bat` 即可；它会自动检查 Node.js/npm、安装项目依赖、创建数据目录并连接运行时。

熟悉命令行时，也可以在项目根目录运行：

```powershell
npm run setup
```

`npm run setup` 会自动创建外部数据目录：

```text
%USERPROFILE%\Documents\XiaoJiaAI Data\
├── output\
├── output\papers\
├── papers\input\
└── .dsh-state\
```

如果提示未安装 Node，请安装完整 Node.js LTS 20 或更高版本：<https://nodejs.org/>。Windows 也可以运行：

```powershell
winget install OpenJS.NodeJS.LTS
```

不要只复制单个 `node.exe`，完整 Node 安装必须包含 `node` 和 `npm`。

本机目录看起来很大通常是因为 `node_modules/`，它已写入 `.gitignore`，GitHub 仓库只提交源码、配置、skills 和启动脚本；克隆后由 `npm run setup` 重新安装依赖。

### 2. 安装依赖

`npm run setup` 会在缺少 `node_modules` 时自动执行 `npm install`。如需手动安装：

```bash
npm install
```

### 3. 配置 API Key

```bash
copy .env.example .env
```

推荐先编辑 `.env`，填入 OpenAI 与 Claude 中转接口配置：

```env
OPENAI_API_KEY=sk-xxxxxxxxxxxx
OPENAI_BASE_URL=https://your-openai-compatible-endpoint/v1
OPENAI_MODEL=gpt-5.6-terra
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
ANTHROPIC_BASE_URL=https://your-anthropic-compatible-endpoint
ANTHROPIC_MODEL=claude-opus-5
```

也可以启动后在项目设置里填写 API Key 和接口地址；这种方式更直观，但需要用户理解不同服务商的 API Key、Base URL、模型名和路由设置。为降低配置门槛，本项目按中转站调用习惯整理了 OpenAI-compatible 与 Anthropic-compatible 配置，方便接入 GPT、Claude 等主流闭源大模型。

论文流水线启动时会读取 Web「模型」设置中的 `rayinai`、`rayinai-claude` 凭据与接口地址；若 `.env` 已填写对应 API Key，则优先使用 `.env`。各写作阶段的模型仍由 `.env` 中的 `ROUTE_*` 配置控制，实际路由见运行日志。

> 正文流水线仅使用 OpenAI 与 Claude 路由；Web 搜索使用 OpenAlex，不再调用 DeepSeek provider。请妥善保管 API Key，不要把填写了真实 Key 的 `.env` 上传到 GitHub。

### 4. 同步并检查 DSH 运行时

```bash
npm run sync:dsh
```

正常使用 `npm run web` 时会自动执行同步，不需要手工维护 `%USERPROFILE%\.dsh` 中的副本。

### 5. 保护本地定制后再升级

本项目包含非 DeepSeek API、中转站、论文工作台、继续按钮、Word 预览、图表门禁和论文流水线等本地定制。升级 DSH 前先保存保护快照：

```powershell
npm run custom:protect
```

安全升级使用：

```powershell
npm run update:dsh
```

如升级后发现定制被破坏，可恢复：

```powershell
npm run custom:restore
npm run web
```

保护说明见 [docs/dsh-customization-protection.md](docs/dsh-customization-protection.md)。

### 6. 可选系统依赖

| 工具 | 用途 | 安装方式 |
|------|------|----------|
| pandoc | Word 导出 | `winget install pandoc` |
| pdftotext (Poppler) | PDF 解析 | `winget install poppler` |
| LaTeX | 编译 PDF | TeX Live / MiKTeX |

Pandoc 是正式 Word 交付的必需依赖；导出失败时平台保留 Markdown，但不会把回退文件报告为 Word 成功。

## 使用

### 推荐方式：桌面端

```bash
npm run desktop
```

也可以直接双击根目录 `桌面端启动小贾AI.bat`。桌面端会自动启动本地 DSH 服务，并在独立窗口中打开小贾AI科研论文写作平台。

### 浏览器版

```bash
npm run web
```

也可以双击根目录 `一键启动小贾AI.bat`。浏览器会自动全屏打开平台。新会话默认使用论文研究 preset；旧会话保留创建时的 preset。使用“论文工作台”管理选题、文献、方案、实验、写作、校验、投稿和产物，或用 `/paper <宽泛研究领域>` 启动统一生命周期。

### 打包 Windows 桌面端

GitHub 已配置自动打包：

- 手动打包：进入 GitHub 仓库 `Actions` -> `Build Desktop` -> `Run workflow`
- 正式发布：推送 `v0.1.0` 这类 tag，GitHub 会自动创建 Release 并上传 Windows 桌面端 zip

本地打包：

```bash
scripts\package-desktop.bat
```

打包完成后，安装包会生成在数据根下的 `release` 目录（默认 `F:\DSH data\release`，可用 `DESKTOP_OUTPUT_DIR` 指定），不再写进项目目录。也可以手动运行：

```bash
npm run build
npm run desktop:pack
```

### 恢复方式：命令行

```bash
npm run paper:cli -- "基于深度学习的建筑结构健康监测研究"
```

CLI 与 Web 的 `/paper` 调用同一条核心流水线和同一套模型路由。CLI 启动时会打印论文项目 ID；需要在 Web 工作台查看或接续时，新建对话并输入 `/paper-attach <论文项目ID>`。

### 方式三：开发模式

```bash
npm run dev
```

## 断点续跑

如果 CLI 工作流中断（网络错误、手动停止等），使用首次运行打印的论文项目 ID 从原目录继续：

```bash
# 第一次运行，在"大纲生成"阶段断了
npm run paper:cli -- "你的选题"

# 再次运行，替换成首次运行打印的项目 ID
npm run paper:cli -- "你的选题" --project-id paper-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

状态保存在 `%USERPROFILE%\Documents\XiaoJiaAI Data\.dsh-state` 和各论文目录内的 `.dsh-state/paper-pipeline-state.json`。

## 定期清理

先预览可清理内容：

```powershell
npm run cleanup
```

确认后执行清理：

```powershell
npm run cleanup:apply
```

安装每天自动清理任务：

```powershell
npm run cleanup:schedule
```

清理器只处理低风险文件：日志、临时目录、npm 缓存、失败尝试、空目录和 `.dsh-state` 中的短期垃圾；默认不删除每篇论文的 `milestones/`、`final/`、`real_data/`、`raw/`、输入材料和定制保护快照。每次清理都会在 `%USERPROFILE%\Documents\XiaoJiaAI Data\.dsh-state\cleanup-reports\` 写入报告。

## 插件开发

每个插件遵循统一格式：

```typescript
export const myPlugin = {
  name: 'my-plugin',
  description: '插件描述',
  tools: {
    my_tool: {
      description: '工具描述',
      parameters: {
        param1: { type: 'string', description: '参数说明', required: true },
      },
      handler: async (params) => {
        // 工具实现
        return { success: true, data: ... };
      },
    },
  },
};
```

在 `src/index.ts` 中注册即可被 dsh 加载。

## 注意事项

1. **引用核验是生命线**：大模型会编造文献，务必查看 `%USERPROFILE%\Documents\XiaoJiaAI Data\output` 下对应论文目录中的引用核验报告，人工确认问题引用
2. **学术诚信**：AI 生成的内容需要你亲自审核、改写、确认，遵守所在机构的 AI 使用政策
3. **dsh 预览版**：DeepSeek Harness 目前是开发者预览版，API 可能有破坏性更新，如遇兼容问题请查看官方仓库
4. **API 费用**：长链路写作会消耗大量 token，建议设置用量上限

## 后续迭代路线

- [ ] 第 2 期：接入知网/万方中文文献检索
- [ ] 第 2 期：长上下文滑动窗口优化（万字以上论文）
- [ ] 第 3 期：自动润色改写（针对高重复段落）
- [ ] 第 3 期：期刊模板库（一键套用目标期刊格式）
- [ ] 第 4 期：个人写作风格学习（基于过往论文）
- [ ] 第 4 期：多模型智能路由（不同阶段自动选最优模型）

## License

MIT

