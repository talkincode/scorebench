# 认识 scorebench

scorebench 是 [ScoreKit](https://github.com/talkincode/scorekit) 的 Agent 原生桌面工作台。你用自然语言描述音乐，Agent 把意图写成 ScoreKit 场景 YAML，ScoreKit 再把 YAML 编译、渲染成可以播放和交付的音频。

```text
你的描述
   │
   ▼
scorebench Agent ──写入──► scene.yaml
                              │
                              ▼
                         ScoreKit CLI
                              │
                    MIDI + 渲染后端 + FFmpeg
                              │
                              ▼
                  OGG/WAV + meta.json + stems
                              │
                              ▼
                    scorebench 播放与频谱显示
```

## 三个角色

| 组件 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| scorebench | 对话、项目文件、Agent 工具调用、只读观察、试听与频谱 | 不合成、不混音、不在应用内做钢琴卷帘编辑 |
| Agent | 理解需求、编排音乐、写场景 YAML、根据验证结果迭代 | 不绕过 ScoreKit 直接生成音频 |
| ScoreKit | 校验场景、确定性编译 MIDI、调用渲染器、导出音频与元数据 | 不理解自然语言，不替你决定作品应该表达什么 |

一句话记忆：**Agent 作曲，ScoreKit 编译，scorebench 承载工作流。**

## 适合的任务

- 游戏场景循环音乐、战斗/探索/胜利等同主题变体；
- 电影感或叙事型器乐配乐草图；
- 可通过 stems 在游戏引擎中动态增减声部的配乐；
- 希望把音乐描述、场景文件和输出一起纳入 Git 的项目；
- 想用自然语言迭代，但仍要求结果可复现、可校验。

## 需要先理解的边界

- scorebench 不是 DAW，没有钢琴卷帘、时间线和插件链。
- 场景 YAML 是音乐的可执行描述，不是任意自然语言容器。字段必须符合当前 ScoreKit schema。
- 同一份场景能稳定地产生相同 MIDI；最终音色仍取决于渲染器、音源文件和外部工具版本。
- ScoreKit 与音源是外部依赖。scorebench 不把 ScoreKit、SoundFont 或 SFZ 采样库打包进项目。
- Agent 的 Review 面板根据场景、schema、验证和渲染元数据做评审；它没有直接“听见”音频。最终听感仍要由人试听确认。

如果这是你第一次使用，继续阅读[快速开始](getting-started.md)。如果你已经能完成渲染，但不知道怎样把需求翻译成场景字段，直接看[从协议到编曲](arrangement-basics.md)。
