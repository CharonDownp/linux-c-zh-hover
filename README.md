# Linux C 函数中文悬停速查

> 一个面向 Linux C 初学者的 VS Code 扩展：鼠标悬停，快速查看函数与宏的中文作用、参数、成功/失败返回值；不认识的 API 还可以使用 AI 辅助解释。

**当前版本：v1.4.0** · **运行环境：VS Code 1.75+** · **许可证：MIT**

本项目适用于 C/C++ 编程学习、代码阅读及日常开发，可快速查询 C 标准库函数、Linux/POSIX 系统接口及相关宏的中文说明，涵盖文件 I/O、进程与线程、进程间通信、网络编程等常见场景，并支持通过 AI 扩展函数知识库。

## ✨ 主要功能

- **悬停中文速查**：显示函数原型、用途、参数，以及成功和失败返回值。
- **简洁 / 详细双模式**：悬停默认只显示重点；点击 **「📖 查看完整解释」** 阅读完整说明。
- **AI 辅助解释**：查询未收录函数，支持自定义 OpenAI Chat Completions 兼容 API 地址和模型。
- **本地缓存与永久离线库**：AI 结果可缓存，确认无误后保存到个人离线库；支持新增、删除、导入、导出。
- **编辑中文解释（v1.4.0）**：可修改内置、AI 缓存及个人词条的**简洁版和详细版**；修改仅覆盖用户本地显示，不改动原始内置数据。
- **网络故障处理**：支持可配置超时、临时错误重试、HTTP(S) 代理以及网络连通性诊断。

### 🆕 v1.4.0 更新亮点

新增 **「✏️ 编辑解释」**：悬停函数名即可打开编辑页面，调整中文作用、参数说明、返回值与注意事项，并保存为本地覆盖词条。

> 完整版本记录请参阅 [CHANGELOG.md](CHANGELOG.md)。

## 🚀 安装与使用

### 安装扩展

1. 获取当前版本的 `zh-linux-api-hover-1.4.0.vsix` 安装包（正式发布时可放在仓库的 **Releases** 页面）。
2. 在 VS Code 中按 `Ctrl + Shift + P`，运行 **`Extensions: Install from VSIX...`**。
3. 选择 `.vsix` 文件，安装后运行 **`Developer: Reload Window`**。
4. 打开 `.c` 或 `.cpp` 文件，将鼠标悬停在 `read(...)`、`waitpid(...)` 或 `shm_open(...)` 等函数名上。

也可以在 Ubuntu 终端安装：

```bash
code --install-extension /path/to/zh-linux-api-hover-1.4.0.vsix --force
```

### 简洁速查与完整解释

默认悬停只展示 **函数原型、作用、主要参数、成功/失败返回值**。点击 **「📖 查看完整解释」** 可阅读详细说明，无需再次请求 AI。

如果希望悬停时同时显示全文，可将 VS Code 设置 `zhLinuxApiHover.hover.detailMode` 修改为 `full`（默认 `compact`）。

### ✏️ 修改现有解释

1. 在 `.c` / `.cpp` 文件中悬停函数名，点击 **「✏️ 编辑解释」**。
2. 分别修改简洁版和详细版内容。
3. 点击 **「保存全部修改」**，再次悬停即可查看新内容。

也可以按 `Ctrl + Shift + P`，运行 **`Linux C 中文速查: 编辑当前函数的中文解释（简洁版与详细版）`**。

修改结果保存到**个人永久离线库**。如果编辑了内置函数，原始内置资料不会被覆盖；通过 **「管理离线函数与宏库」** 删除对应的个人覆盖词条，即可恢复内置说明。建议定期导出个人离线库备份。

## 🤖 配置 AI（可选）

> 不配置 API Key 也可以使用内置的离线函数速查。

1. 按 `Ctrl + Shift + P`，运行 **`Linux C 中文速查: 配置 AI 接口（地址 / 模型 / API Key）`**。
2. 填写兼容 **OpenAI Chat Completions** 的 API Base URL，例如 `https://your-provider.example/v1`。
3. 填写服务商实际提供的**模型 ID**。
4. 输入 API Key；密钥由 VS Code **SecretStorage** 保存，不写入 `settings.json` 或源码。
5. 鼠标悬停未收录的函数时，点击 **「🤖 查询中文参数和返回值」**。

**默认使用手动 AI 查询**，仅悬停不会自动产生 API 请求和费用。查询成功后可以保存在缓存中，并按需手动转存为永久离线词条。

如果忘记配置位置，在命令面板搜索 `Linux C 中文速查`。常用命令还有：

- **设置 / 删除 API Key（安全存储）**
- **检查 AI 配置状态（不显示密钥）**
- **测试 AI 接口网络连通性（无需消耗 Token）**
- **清空 AI 查询缓存**
- **管理离线函数与宏库**

### AI 相关设置

在 VS Code 设置中搜索 `zhLinuxApiHover`：

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `zhLinuxApiHover.ai.baseUrl` | 空 | API 接口地址（不要填 API Key） |
| `zhLinuxApiHover.ai.model` | 空 | 模型 ID |
| `zhLinuxApiHover.ai.hoverMode` | `manual` | `manual` 手动查询；`auto` 未收录函数悬停自动查询 |
| `zhLinuxApiHover.ai.saveMode` | `manual` | `manual` 手动转存；`auto` 自动转存；`off` 关闭自动转存 |
| `zhLinuxApiHover.ai.cacheEnabled` | `true` | 是否启用 AI 查询缓存 |
| `zhLinuxApiHover.ai.timeoutMs` | `90000` | 请求超时，单位毫秒 |
| `zhLinuxApiHover.ai.retryCount` | `1` | 临时错误最多自动重试次数（0～2） |
| `zhLinuxApiHover.ai.proxyUrl` | 空 | 可选 HTTP(S) 代理地址；留空直连 |
| `zhLinuxApiHover.hover.detailMode` | `compact` | `compact` 简洁悬停；`full` 悬停显示全文 |

**注意**：临时错误重试可能导致重复 API 计费；自动查询模式也可能增加 Token 消耗。插件只支持 HTTP(S) 代理，不直接支持 SOCKS 代理。

## 📚 数据与隐私

优先显示顺序：**个人永久离线库 → 内置离线库 → AI 查询缓存**。

- 内置函数和宏随扩展安装；个人词条和缓存独立保存在 VS Code 的扩展存储中，正常同 ID 升级通常不会覆盖。
- 个人离线库支持导入、导出 JSON，**导出文件不包含 API Key**。升级或迁移设备前，建议自行备份。
- AI 查询会把函数名及可用的本机 `man` 文档摘录发送给**你配置的 API 服务商**；不会主动发送整个项目源码。
- API Key 保存在 VS Code 安全存储中；使用第三方 API 时仍应了解服务商的费用、隐私与数据政策。

## 🛠️ 开发与测试

插件主体基于 JavaScript、VS Code Extension API 与 Node.js 内置模块，无第三方运行时依赖。

在项目根目录运行：

```bash
node --check extension.js
node test/run-tests.js
```

项目结构（节选）：

```text
├── extension.js           # VS Code 扩展入口
├── builtin-docs.js       # 内置基础函数数据
├── additional-docs.json  # 补充函数与宏的数据
├── categories.json       # 分类数据
├── lib/                  # AI、存储、网络请求与简洁解释逻辑
├── test/                 # 自动化测试
├── tools/                # VSIX 打包工具
├── README.md             # 项目介绍和使用指南
├── CHANGELOG.md          # 版本更新记录
└── LICENSE               # MIT 许可证
```

## ⚠️ 使用范围与局限

- AI 解释**不能替代**官方文档；当解释有歧义时，以本机 `man` 手册、头文件和官方文档为准。
- 扩展使用词法启发式判断函数名，不能在所有场景下识别同名自定义函数或 C++ 重载。
- AI 采用 Chat Completions 风格接口，并非所有“兼容 OpenAI”的网关或模型都支持。
- 代理地址需符合运行环境：当 VS Code 在 Ubuntu 虚拟机中运行时，`127.0.0.1` 指的是**虚拟机本身**，不是 Windows 物理机。

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。版权署名请以 `LICENSE` 文件为准。

本项目是独立的学习辅助工具，与 VS Code 官方或任何课程出品方没有隶属关系。
