# Node 运行与磁盘占用

## 共用什么

- 使用电脑上已有的 Node.js 和 npm；源码安装不会再安装一套 Node.js。
- 安装、启动和升级共用用户级 npm 下载缓存：Windows 默认 `%LOCALAPPDATA%\npm-cache`，其他系统默认 `~/.npm`。已有 `NPM_CONFIG_CACHE` / `npm_config_cache` 优先保留，`DSH_NPM_CACHE` 可单独覆盖。
- 只为本次 DSH 进程设置缓存路径，不修改系统 npm 配置、网络设置或其他项目。
- `node_modules`、缓存、私有论文、会话和 API 密钥不上传 GitHub；源码用户克隆后运行 `setup-dsh.bat` 安装依赖。

## 为什么不能把所有库放进全局目录

Node 运行器可以共用，但不同项目可能依赖不同版本的同名库。ESM、插件和原生模块也不保证从全局 `NODE_PATH` 解析。把各项目统一指向一个可变的全局 `node_modules`，可能让一个项目的升级破坏其他项目。

因此当前整理统一的是下载缓存和安装入口，**没有把现有依赖搬到全局目录，也没有声称已消除全部重复安装**。现有 DSH 模型依赖、版本、路径和校验基线保持不变。若未来切换到 pnpm 内容寻址存储，需要单独验证 DSH 插件发现、原生模块、桌面打包和模型锁，不对当前运行环境直接转换。Windows 硬链接不能跨盘共享同一文件。

## 清理边界

旧数据目录 `.dsh-state/npm-cache/_cacache` 是可重新下载的包缓存；`_npx` 则可能包含正在运行的 MCP，不是普通下载缓存，清理器始终跳过。公共 npm 缓存不属于 DSH 私有目录，DSH 不自动遍历删除其他项目的公共缓存。

检查旧缓存与过期临时产物：

```shell
node scripts/cleanup-dsh-data.mjs --dry-run --npm-cache-days=30
```

核对报告后，将 `--dry-run` 换为 `--apply`。清空旧下载缓存可使用 `--npm-cache-days=0`，但不要在安装或升级依赖时执行。不会删除原始实验数据、论文交付文件、不同内容的历史证据、已安装依赖或 `_npx`。

桌面发行包为了让未安装 Node.js 的用户直接运行，会自带 Electron 运行时；这与源码版共用系统 Node.js 是两种不同的分发方式。
