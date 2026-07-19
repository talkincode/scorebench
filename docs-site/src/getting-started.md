# 快速开始

目标是完成一条最短闭环：安装依赖、打开项目目录、让 Agent 创建场景、渲染并试听。

## 1. 准备 scorebench 和 ScoreKit

从 [scorebench Releases](https://github.com/talkincode/scorebench/releases) 下载适合系统的安装包。scorebench 运行时还需要单独安装 ScoreKit；它不会随桌面应用捆绑。

macOS 或 Linux 使用 Homebrew：

```bash
brew install talkincode/tap/scorekit
scorekit doctor
```

其他平台可从 [ScoreKit Releases](https://github.com/talkincode/scorekit/releases) 下载二进制。`scorekit doctor` 应确认 FFmpeg 和至少一个渲染器可用，并报告默认 SoundFont 的状态。

> 如果 scorebench 找不到命令，可把 `SCOREBENCH_SCOREKIT` 设置为 ScoreKit 可执行文件的绝对路径。macOS 图形应用的 `PATH` 往往比终端更短，因此“终端能运行、应用找不到”并不矛盾。

## 2. 创建项目目录

新建一个普通目录并在 scorebench 中打开它。一个窗口只对应一个项目目录；切换项目就是打开另一个目录。

```text
my-score/
├── scene.yaml          # Agent 创建或修改的场景
├── bench.json          # 渲染后端、StylePack 等项目选择
├── sessions/           # 对话会话与记忆
└── out/                # 渲染产物
```

目录可以是 Git 仓库，也可以先从空目录开始。scorebench 不会替你初始化或管理 Git。

## 3. 配置模型连接

在 Settings 中填写：

- Base URL：兼容 OpenAI Responses API 的端点；
- Model：端点上可用的模型名；
- API key：优先存入操作系统钥匙串；
- Context budget：决定何时压缩较长的对话。

前端不会直接访问模型端点，所有网络请求都由 Rust 后端发出。不要把 API key 写进项目文件或提交到 Git。

## 4. 发出第一条创作请求

比“做一首好听的音乐”更有效的描述应包含用途、情绪、结构与限制。例如：

> 为夜间森林探索做一段 8 小节、D 小调、92 BPM 的无缝循环。用长弦乐铺底、钢琴分解和弦、低音与很轻的鼓。旋律留出呼吸，不要太明亮；请创建场景、验证并渲染 OGG。

Agent 会创建 YAML，并通过 ScoreKit 的校验、构建和差异工具工作。不要要求它发明不存在的字段；如果某个目标超出协议，它应该说明限制并用现有字段寻找近似方案。

## 5. 观察、渲染、试听

工作区的常用位置：

- **Agent**：继续描述修改意图；
- **Source**：只读查看场景 YAML；
- **Preview**：查看编译后的音乐参数和最近一次语义差异；
- **Review**：从作曲、编曲、制作等视角生成结构化建议；
- **右侧 Render**：选择渲染器、采样率、格式、增益、质量和 stems；
- **右侧 Outputs**：加载 `out/` 中的音频并查看 `meta.json` 摘要。

第一次建议保留默认设置：

| 设置 | 建议 | 原因 |
| --- | --- | --- |
| Renderer | `fluidsynth` | 安装简单，使用默认 GM SoundFont |
| Sample rate | `44100 Hz` | 适合普通试听与多数音乐资产 |
| Format | `OGG` | 文件较小，适合迭代 |
| Gain | `0.8` | ScoreKit 默认值，先留出余量 |
| Quality | `5` | OGG 质量与体积的中间点 |
| Stems | 关闭 | 先确认完整混音，再按需输出分轨 |

完成后，`out/` 中会出现音频和同名的 `meta.json`。若启用 stems，还会出现同名 `.stems/` 目录。

## 下一步

- 不认识 YAML 字段：读[ScoreKit 场景协议](scene-protocol.md)。
- 场景有效但听起来单薄：读[从协议到编曲](arrangement-basics.md)。
- 想更换真实乐器采样：读[渲染流程与后端](rendering.md)和[音源、采样库与许可](sound-sources.md)。
