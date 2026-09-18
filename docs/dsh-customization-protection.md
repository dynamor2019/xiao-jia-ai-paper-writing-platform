# DSH 本地定制保护

这个项目把 DSH 原始预览版武装成科研论文工作台，已经包含大量本地定制：非 DeepSeek API 路由、OpenAI/Claude 中转兼容、继续按钮、论文工作台、Word 预览、任务状态、文件编辑恢复、Figures for Papers 图表规则、论文生命周期和质量门禁。

为避免升级 DSH 包后这些内容被覆盖，使用下面四个命令。

## 保护当前稳定状态

```powershell
npm run custom:protect
```

保护快照保存在仓库外：

```text
%USERPROFILE%\Documents\XiaoJiaAI Data\.dsh-state\protected-customizations\
```

其中会包含 `.env`。这是为了保住你的中转站和模型路由配置，不会提交到 GitHub。

## 升级前后校验

```powershell
npm run custom:verify
```

如果显示 `changed`，说明当前文件和保护快照不一致。可能是你刚做了新修改，也可能是升级破坏了定制。

## 一键恢复定制

```powershell
npm run custom:restore
npm run sync:dsh
```

恢复后会把项目内的论文 skills、preset 和 Web profile 重新同步到 `%USERPROFILE%\.dsh`。

## 安全升级 DSH

默认升级 DSH 兼容版本。当前 `dsh-univer-office` 只声明兼容 DSH `0.1.2-rc.1`，所以默认不会强行升级到 `0.1.5-rc.2`，避免破坏 Word/工作台能力：

```powershell
npm run update:dsh
```

指定安装某个包版本：

```powershell
npm run update:dsh -- @deepseek-ai/dsh@0.1.5-rc.2
```

需要临时改变默认 DSH 目标版本时：

```powershell
$env:DSH_TARGET_VERSION="0.1.2-rc.1"
$env:DSH_UNIVER_OFFICE_TARGET_VERSION="0.2.14"
npm run update:dsh
```

安全升级流程会执行：

```text
保护当前定制 → npm 更新 → 安装/更新 Figures for Papers → 同步 DSH runtime → 编译检查 → 定制校验
```

如果升级后出现问题，先运行：

```powershell
npm run custom:restore
npm run web
```

## 重点保护内容

- `.env` 与 `.env.example`
- `package.json` 的脚本入口
- `scripts/patch-dsh-*.mjs` 系列运行时补丁
- `scripts/start-dsh-web.mjs` 和 `scripts/sync-dsh-runtime.mjs`
- `config/dsh/**` 的 Web profile 和 paper preset
- `.dsh/skills/**` 的论文写作、图表、数据诚信和投稿门禁
- `src/lib/model-client.ts` 的 OpenAI/Claude/中转站兼容
- `src/workflows/paper-pipeline.ts` 的论文流水线
- `src/plugins/**` 中的导出、研究和质量校验插件

