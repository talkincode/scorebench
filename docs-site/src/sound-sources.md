# 音源、采样库与许可

音源决定“这些音符由什么声音演奏”。它与渲染后端有关，但不是同一个概念：FluidSynth 是软件，SoundFont 是它读取的音色数据；sfizz 是软件，SFZ 与采样文件是它读取的乐器定义和声音数据。

## 默认 SoundFont 从哪里来

ScoreKit 的标准安装使用官方 **MuseScore General 0.2.0** SoundFont，文件名为 `MuseScore_General.sf2`。ScoreKit 的安装脚本同时保存其 MIT 许可证文件。

默认声音目录通常包含：

```text
~/.local/share/scorekit/sounds/
├── sf2/MuseScore_General.sf2
├── sfz/
└── profiles/
```

Homebrew 安装会使用包管理的声音目录，并通过 `SCOREKIT_SOUND_LIBRARY_DIR` 告诉 ScoreKit 去哪里查找。源码安装可用同一个环境变量改到其他磁盘。

```bash
export SCOREKIT_SOUND_LIBRARY_DIR=/Volumes/Samples/scorekit
scorekit doctor
```

scorebench 不复制或重新分发这个文件；它通过 ScoreKit 使用本机安装的默认音源。

## 使用自定义 SF2

FluidSynth 和 TiMidity++ 接受 GM 兼容 `.sf2`。Scene 中的 `instrument` 会映射到 General MIDI program，因此一个完整、映射正确的 GM SoundFont 最容易直接替换。

自定义 SF2 需要注意：

- 文件扩展名正确不代表内容有效；先用 ScoreKit/渲染器验证；
- GM program 缺失或映射不同，会出现错误乐器、静音或替代音色；
- 同一 MIDI 在不同 SoundFont 上的平衡差异可能很大；
- `articulation` 不会让 SF2 自动切到 pizzicato、spiccato 等奏法；该字段只供 SFZ profile 使用；
- 许可证可能允许创作输出，却禁止重新分发原始样本或音色库。

scorebench 当前 Render 面板没有自定义 SoundFont 选择器；Agent/后端工具接口支持 `soundfont` 参数。需要固定项目音源时，应让工作流明确传入路径，或配置 ScoreKit 的声音目录，而不是把大型音源复制进仓库。

## SFZ：乐器文件与采样文件

SFZ 是文本格式的采样乐器定义。一个 `.sfz` 往往引用同目录或其他目录中的 WAV/FLAC 样本。只拷贝 `.sfz` 文件而没有它引用的样本，不能发声。

ScoreKit 使用 renderer profile 把协议乐器映射到本机 SFZ：

```yaml
name: open-orchestra
root: /Volumes/Samples
instruments:
  violin:
    sustain: VSCO/Violin/Violin-Sustain.sfz
    pizzicato: VSCO/Violin/Violin-Pizzicato.sfz
  cello:
    sustain: VSCO/Cello/Cello-Sustain.sfz
  drums:
    sustain: Drums/Programs/basic-kit.sfz
```

每件乐器必须有 `sustain` 映射。某个专门奏法未映射时，ScoreKit 回退到该乐器的 `sustain`。profile 把机器相关路径留在场景协议之外，因此 `scene.yaml` 仍可移植，但 profile 自身仍需要团队约定路径或安装脚本。

使用前先认证 profile：

```bash
scorekit profile check profile.yaml
scorekit --json profile check profile.yaml
```

检查会验证路径、渲染探针、静音、警告和重复渲染表现。一个 patch 通过，不代表同一采样库的所有 patch 都兼容 sfizz。

## 可考虑的开放音源

ScoreKit 仓库附带的示例 profile 使用或研究过以下类型的来源：

| 来源 | 常见用途 | 许可提醒 |
| --- | --- | --- |
| MuseScore General 0.2.0 | 默认 GM 草图音源 | ScoreKit 安装脚本记录为 MIT；保留随附许可证 |
| VSCO 2 Community Edition | 管弦乐 SFZ/采样 | 常见版本以 CC0 发布；仍应核对实际下载包 |
| VCSL | 乐器与实验性采样 | 常见内容为 CC0；逐个核对版本和来源 |
| FreePats | GM、吉他、鼓、合成器等 | 不同包许可不同，不能把整个站点概括为一种许可 |

这些名称不是“已内置”或“整库已兼容”的承诺。大型 SFZ 库可能使用 sfizz 尚未完整支持的 SFZv2/ARIA opcode、keyswitch、round-robin、mic mixer 或脚踏控制。应对实际 patch 做渲染验收。

## “免费”不等于“可以随软件分发”

至少区分三件事：

1. **可以免费下载安装吗？**
2. **可以把渲染出来的音乐用于商业项目吗？**
3. **可以把原始采样/SF2/SFZ 随你的应用或仓库再次分发吗？**

三个答案可能不同。CC0、CC BY、MIT、GPL、CC BY-NC 和厂商 EULA 的义务也不同。软件许可证与录音样本许可证不能混为一谈。

## 音源接入清单

- 从项目官方网站或正式 release 下载，不使用来源不明的重打包；
- 固定版本、下载 URL、文件大小与 SHA-256；
- 保存 LICENSE/NOTICE，CC BY 内容保留署名；
- 验证常用音域、最低/最高力度、重复音、note-off、延音踏板和 release；
- 用目标采样率连续渲染至少两次，检查静音、警告和不可接受的随机漂移；
- 只把通过测试的具体 patch 写进 profile；
- 不把没有再分发授权的大型样本提交到项目仓库；
- 更换音源后重新做完整试听和响度检查。

这不是法律意见。面向商业发布时，应根据你实际下载的版本和许可证文本复核授权范围。
