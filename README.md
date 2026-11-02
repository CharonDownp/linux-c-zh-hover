# C/C++ 中文标识符速查（Linux）

面向 C/C++ 编程学习、代码阅读和日常开发的 VS Code 扩展。鼠标悬停即可查看函数、结构体、类型别名、宏、结构体成员及部分普通变量的中文说明；内置离线知识库，也支持按需使用 AI 解释和修改内容。

**运行环境：** VS Code 1.75+ · **许可证：** [MIT](LICENSE) · **下载：** [最新版本与安装包](https://github.com/CharonDownp/linux-c-zh-hover/releases/latest)

## 功能

- **中文悬停速查**：函数可查看原型、作用、参数和返回值；类型、宏、成员等可查看定义、用途及注意事项。
- **离线优先**：内置常见 C 标准库及 Linux/POSIX 接口等中文词条；未配置 AI 也能使用。
- **简洁 / 详细说明**：悬停默认显示摘要，点击“查看完整解释”阅读详细内容；代码示例保留换行与缩进。
- **AI 辅助解释**：可查询未收录标识符，并自定义解释重点、用词和详细程度；未填写要求时使用默认规则。
- **定向修改**：对已有说明提出“只修改某个参数，其余不变”等要求，尽量保留未指定的内容；也可以手动编辑简洁版和详细版。
- **结果审核**：AI 生成结果先作为待审核草稿，支持对照原说明、确认保存或放弃；关闭页面及重启 VS Code 后仍可恢复审核。
- **个人离线知识库**：支持新增、编辑、删除和 JSON 导入/导出；AI 查询缓存与永久离线词条分开管理。
- **可配置接口**：使用 OpenAI Chat Completions 兼容 API，支持自定义服务地址、模型、超时和 HTTP(S) 代理。

## 安装

1. 打开 [Releases](https://github.com/CharonDownp/linux-c-zh-hover/releases/latest)，下载最新版本的 `.vsix` 文件。
2. 在 VS Code 中按 `Ctrl + Shift + P`，执行 `Extensions: Install from VSIX...`。
3. 选择下载的文件并完成安装；如有必要，执行 `Developer: Reload Window`。
4. 打开 C/C++ 文件，将鼠标悬停在函数、结构体、宏等名称上。

也可以通过终端安装：

~~~bash
code --install-extension /path/to/zh-linux-api-hover-<version>.vsix --force
~~~

将 `<version>` 替换为下载文件中的实际版本号。

## 使用示例

在以下代码中，可分别悬停 `sockaddr_in`、`addr`、`AF_INET`、`sin_port` 或 `htons`，查看对应的中文说明：

~~~c
#include <netinet/in.h>
#include <sys/socket.h>

int main(void)
{
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(8080);
    return 0;
}
~~~

普通变量的本地说明主要依据可识别的声明推断其类型，不代表插件能够获知变量的运行时值。

### 查询、编辑与保存说明

- **查看详细解释**：在悬停提示中点击“查看完整解释”。
- **手动编辑**：点击“编辑解释”，分别修改简洁版和详细版，然后保存到个人离线库。
- **AI 查询或重新解释**：点击相应入口，按需要填写补充要求；留空则按默认规则生成。
- **审核 AI 结果**：在审核页面对比新旧内容，再选择保存或放弃。审核草稿不会因通知消失而丢失。
- **重新打开审核草稿**：按 `Ctrl + Shift + P`，搜索 `Linux C 中文速查`，执行“查看待审核的 AI 解释 / 确认保存”。

修改内置词条时，插件会保存用户覆盖记录，而不直接修改扩展自带的词库。删除个人覆盖记录后，可以恢复对应的内置说明。

## 配置 AI（可选）

离线速查**不要求**配置 API Key。需要 AI 功能时：

1. 打开命令面板（`Ctrl + Shift + P`）。
2. 运行 `Linux C 中文速查: 配置 AI 接口（地址 / 模型 / API Key）`。
3. 填写服务商提供的 API Base URL（例如 `https://example.com/v1`）、模型 ID 和 API Key。
4. 在代码中主动选择 AI 查询或重新解释。

API Key 通过 VS Code 的 SecretStorage 存储，不会写入 `settings.json` 或源码。若需更新密钥，可使用命令“设置 / 更新 API Key（安全存储）”。

AI 默认使用**手动查询**模式。未收录函数可选择自动悬停查询；未知变量、类型和宏仍需主动查询。对普通变量请求局部代码上下文时，插件会先展示将发送的片段并征求同意。

### 常用设置

在 VS Code 设置中搜索 `zhLinuxApiHover`：

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `zhLinuxApiHover.ai.baseUrl` | 空 | 兼容接口的基础地址 |
| `zhLinuxApiHover.ai.model` | 空 | 模型 ID |
| `zhLinuxApiHover.ai.hoverMode` | `manual` | 手动查询或对未收录函数自动查询 |
| `zhLinuxApiHover.ai.cacheEnabled` | `true` | 启用 AI 查询缓存 |
| `zhLinuxApiHover.ai.saveMode` | `manual` | 控制 AI 结果向离线库转存的方式 |
| `zhLinuxApiHover.ai.timeoutMs` | `90000` | 请求超时时间（毫秒） |
| `zhLinuxApiHover.ai.retryCount` | `1` | 临时错误的重试次数 |
| `zhLinuxApiHover.ai.proxyUrl` | 空 | 可选 HTTP(S) 代理，留空则直连 |
| `zhLinuxApiHover.hover.detailMode` | `compact` | 简洁悬停或完整悬停（`full`） |

如遇到 API 认证错误，可通过命令面板检查配置状态，或运行“测试真实 AI 鉴权（POST，可能消耗少量 Token）”。单纯的网络连通性测试不携带密钥，即使返回 HTTP 401，也不能据此判定 API Key 无效。

## 数据与隐私

- 优先读取个人永久离线库、内置知识库及可用的本地缓存。个人数据与扩展安装包分开保存；升级扩展通常不会清除个人词条。
- AI 查询会向所配置的接口提供标识符名称、可用的本机 `man` 手册摘录，以及用户主动填写的补充要求。定向修改时，还可能提供当前说明供模型参考。
- 解释普通变量时，如需附带附近代码，插件会先展示片段并要求用户明确同意；不会仅因鼠标悬停就自动发送整个项目源码。
- 个人离线词库支持 JSON 备份；导出内容不包含 API Key。使用第三方模型前，请了解对应服务的费用与隐私政策。

## 局限性

- 标识符识别采用轻量级规则，并非完整的 C/C++ 语义分析器。复杂模板、跨文件类型推断、宏展开及同名变量遮蔽可能无法准确处理。
- AI 生成内容可能存在错误；涉及接口行为、参数约束和返回值时，以官方文档、头文件及本机 `man` 手册为准。
- 不同服务商的“OpenAI 兼容”接口可能存在实现差异；代理设置支持 HTTP(S)，不直接支持 SOCKS。
- 若 VS Code 在虚拟机中运行，代理地址 `127.0.0.1` 指向虚拟机本身，而非宿主机。

## 开发

扩展使用 JavaScript、VS Code Extension API 与 Node.js 内置模块开发，无第三方运行时依赖。

~~~bash
node --check extension.js
node test/run-tests.js
~~~

仓库主要包括：

~~~text
extension.js           扩展入口
builtin-docs.js        内置基础词条
symbol-docs.js         结构体、类型及其他标识符词条
additional-docs.json   补充函数与宏
categories.json        分类数据
lib/                   AI、渲染、存储和网络逻辑
test/                  自动化测试
tools/                 VSIX 打包工具
~~~

## 更新记录与下载

- [CHANGELOG.md](CHANGELOG.md)：完整版本更新历史
- [GitHub Releases](https://github.com/CharonDownp/linux-c-zh-hover/releases)：各版本更新说明和 VSIX 安装包

## 许可证

本项目基于 [MIT License](LICENSE) 开源，是独立开发的辅助工具，与 VS Code 官方无隶属关系。
