# 科技论文工作台架构

## 设计原则

1. `<项目目录>` 是唯一可维护源码；`%USERPROFILE%\Documents\XiaoJiaAI Data` 是唯一论文输出、原始数据和运行状态根目录；用户目录中的 DSH 文件只是运行时部署副本。
2. Web 和 CLI 都调用 `src/workflows/paper-pipeline.ts` 的 20 阶段研究生命周期，不得分别实现选题、实验或写作支线。
3. 论文工作台是核心流水线的可视化控制台，不是提示词生成器；聊天模式只用于首次研究问题确认和后续修改意见，不另建执行支线。
4. “稿件已生成”“Word 已导出”“质量已通过”“投稿包完整”是四个不同状态。

## 分层

| 层 | 唯一源码 | 职责 |
|---|---|---|
| 桌面界面 | `scripts/patch-dsh-journal-ui.mjs` | 期刊选择、流水线真实状态、一次选题确认、恢复、校验、导出和产物入口 |
| Web 接入 | `config/dsh/web/` | `/paper*` 命令、OpenAlex 搜索和进程状态 |
| Agent preset | `config/dsh/presets/paper/` | 论文 persona、工具范围、段落检查点和完成纪律 |
| Skills | `.dsh/skills/` | 阶段化研究、期刊、写作、质量与投稿规范 |
| 核心流水线 | `src/workflows/paper-pipeline.ts` | Web/CLI 共用的 20 阶段执行与断点恢复 |
| 研究生命周期 | `src/plugins/research/research-lifecycle.ts` | OpenAlex 联网选题、方案冻结、实验命令和数据验收 |
| 能力插件 | `src/plugins/` | 文献解析、逐段写作、引用、质量、Word 与 LaTeX |
| 模型路由 | `src/config/model-routing.ts` | 各阶段 OpenAI/Claude 路由的唯一代码配置 |
| 运行时部署 | `scripts/sync-dsh-runtime.mjs` | 把项目源码同步到 `~/.dsh`，不在用户目录手工开发 |

## 执行链

```text
论文工作台或 /paper
  -> config/dsh/web/paper-command.js
  -> src/workflows/paper-pipeline.ts
  -> 联网选题后暂停一次，由 /paper-confirm 确认最终研究问题
  -> 从同一断点自动继续
  -> 联网选题/方案/实验/数据/写作/核验/导出插件
  -> `%USERPROFILE%\Documents\XiaoJiaAI Data\output\papers` 下当前对话专属目录中的 milestones/ 与 final/
```

工作台按钮直接提交 `/paper`、`/paper-confirm`、`/paper-resume`、`/paper-validate`、`/paper-export`、`/paper-submission` 和 `/paper-artifacts` 等本地命令，并通过 `/dsh-paper-workbench` 读取同一份流水线状态。工作台不得再维护独立阶段提示词、独立进度或第二套目录规则。

CLI 的 `npm run paper:cli` 从第二步直接进入同一流水线。`npm run paper:validate` 对已有 Markdown/DOCX 单独执行质量门禁。

## 状态边界

- `%USERPROFILE%\Documents\XiaoJiaAI Data\.dsh-state/research-workspace.json`：项目主题、目标期刊和工作区元数据。
- `%USERPROFILE%\Documents\XiaoJiaAI Data\.dsh-state/web-paper-run.json`：Web 启动的后台进程状态，仅表示进程与当前阶段。
- `<paper-dir>/.dsh-state/paper-pipeline-state.json`：核心流水线断点，是内容执行的权威状态。
- `.dsh-state/runtime/`：逐段工作稿、运行日志和可恢复临时文件，完成后清理。
- `milestones/*quality-report.md`：完成与投稿判定依据，不允许由自然语言覆盖。
- `milestones/topic-discovery.md`：研究方向及其联网证据；没有它不能锁定选题。
- `milestones/analysis-plan.md`：实验前冻结的研究方案；变更必须写入修订记录。
- `milestones/reproducibility/`：实验代码、机器可读结果和真实运行审计依据。
- `milestones/data-validation.md`：结果写作的强制前置门禁。
- `milestones/revision-log.md` 与 `milestones/publication-record.md`：投稿后返修和发表状态。
- `final/`：通过门禁的 Markdown、DOCX、LaTeX、BibTeX 和投稿材料。

## 生命周期

```text
研究建档 → 联网选题 → 方向确认 → 文献检索/精读 → 方案冻结 → 大纲/前言
→ 程序实验 → 数据验收 → 方法/结果/讨论 → 稿件完备 → 引用/科技质量门禁
→ 期刊格式 → 投稿包 → Word/LaTeX → 编辑决定/返修/接收归档
```

系统不会把“模型生成了文字”算作研究进度：选题必须有联网证据，结果必须来自成功运行的程序和通过验收的数据，发表必须有真实投稿记录。

## 配置更新

只修改项目内 `.dsh/skills`、`config/dsh`、`src` 或 `scripts`。运行 `npm run sync:dsh` 部署，或直接使用 `npm run web` 自动同步后启动。旧会话保留创建时的 preset；需要新 persona 时创建新会话。

