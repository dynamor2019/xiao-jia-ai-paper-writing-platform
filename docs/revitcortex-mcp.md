# RevitCortex MCP 安装与连接

小贾通过 RevitCortex MCP 查询 Revit 构件、读取参数和尺寸、导出模型数据。**要使用这些能力，必须另外安装 Autodesk Revit 和 RevitCortex 的 Revit 插件及 MCP Server**；仅安装小贾或 npm 依赖不足以操作 Revit。

这是一项可选集成，不使用 Revit 的用户不用安装，也不用启用；正常论文写作不依赖它。仓库提供连接配置，不附带第三方插件二进制、Revit 软件或用户模型。

## 安装插件

1. 确认电脑运行 Windows，已安装所用版本的 Autodesk Revit；版本支持以 [RevitCortex 官方说明](https://github.com/LuDattilo/RevitCortex#installation) 为准。
2. 从 [官方发行页面](https://github.com/LuDattilo/revitcortex-releases/releases/latest) 下载 ZIP 并解压，先关闭 Revit。
3. 运行包内 `install.bat`；若发行包没有该入口，按官方说明运行 `install.ps1`，根据安装器提示处理管理员权限。此安装器属于第三方插件，不是小贾的 setup。
4. 安装器会部署 Revit 插件和 MCP Server；默认 Server 路径为 `%USERPROFILE%\.revitcortex\server\RevitCortex.Server.exe`。
5. 重新打开 Revit，确认出现 RevitCortex 功能区，打开目标模型，并通过 **Cortex Switch** 开启连接。只安装 Server、未加载 Revit 插件或未开启开关，不能查询模型。

## 在小贾中启用

在项目 `.env` 中添加以下非敏感开关，然后完整退出并重新启动小贾：

```dotenv
REVITCORTEX_ENABLED=1
```

默认按当前 Windows 用户目录寻找 Server，不依赖开发者的用户名或 F 盘。自定义安装位置时，再设置 Server 所在目录，不要填写 EXE 文件本身：

```dotenv
REVITCORTEX_SERVER_DIR=D:/Tools/RevitCortex/server
```

桌面安装用户也可以在启动程序前设置同名用户环境变量。DSH 使用 `stdio` 启动本机 Server；不要在命令中附加 API key，不需要修改 DNS、网关、VPN、模型 API 或 TLS。

集成默认关闭；关闭时不启动 MCP 进程。启用后的初始连接失败不会阻断 DSH 启动，也不会无限重连；修复插件或路径后重新启动小贾。取消启用可将 `REVITCORTEX_ENABLED` 改为 `0`。

## 检查与安全

- 首次只让 AI 查询当前文档和少量构件参数，确认构件 ID、单位和导出路径正确后再批量导出；不要用写操作测试连接。
- 导出的 Revit 参数和设计尺寸属于模型资料，不代表现场实测；保留来源模型、构件 ID、单位和导出时间。
- 修改、删除或批量写入构件前，先备份 RVT，并明确确认范围；DSH 的 MCP 接入本身不等于只读权限，请使用插件提供的只读/权限设置。
- 找不到 Server：核对上述 EXE 是否存在，以及目录变量是否正确；没有功能区：核对插件是否安装到当前 Revit 版本，安装后是否重启 Revit；无法读取模型：检查目标文档是否打开及 Cortex Switch 是否开启。

本次发布不自动安装第三方插件，不自动打开或修改 Revit 模型。
