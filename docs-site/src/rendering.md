# 渲染流程与后端

scorebench 不在进程内生成或处理声音。它把参数交给 ScoreKit，ScoreKit 再调用外部渲染器和 FFmpeg：

```text
scene.yaml
   │ validate + deterministic compile
   ▼
MIDI
   │
   ├── FluidSynth + SF2
   ├── TiMidity++  + SF2
   └── sfizz_render + SFZ profile
            │
            ▼
        raw audio
            │ loop seal / tail / export
            ▼
 OGG 或 WAV + meta.json + 可选 stems
```

ScoreKit 负责调用这些工具、检查退出状态并原子写入产物。scorebench 只读取最终文件，通过 WebAudio 播放、求频谱和绘制可视化。

## 三种渲染后端

| 后端 | 音源输入 | 适合 | 注意事项 |
| --- | --- | --- | --- |
| `fluidsynth` | 一个 GM 兼容 SF2 | 默认草图、快速迭代、安装简单 | 所有乐器来自同一 SoundFont；`articulation` 不生效 |
| `timidity` | 一个 GM 兼容 SF2 | 备用 SF2 路径、交叉检查 | 不同实现的混音与音色响应可能不同；`articulation` 不生效 |
| `sfizz` | SFZ 文件集合 + renderer profile | 使用更细致的开放采样库和奏法 | 必须提供 profile；每个场景乐器都要有映射，先做 profile check |

`fluidsynth` 是 scorebench 的默认选择。只有在音乐结构已经可靠、并且你愿意管理采样库、路径与许可时，才需要切换 sfizz。

## Render 面板参数

| 参数 | 含义 | 使用建议 |
| --- | --- | --- |
| Renderer | MIDI 到 PCM 的合成后端 | 默认 FluidSynth；sfizz 需要 profile |
| Sample rate | 每秒采样数，44100 或 48000 Hz | 音乐发行常用 44100；视频/部分游戏管线常用 48000 |
| Format | `OGG` 或 `WAV` | OGG 适合小体积交付；WAV 适合后续制作或无损存档 |
| Gain | 传给合成器的整体增益，界面范围 0–2 | 先用 0.8；爆音时降低，不要靠它修复编曲平衡 |
| Quality | Vorbis 质量 0–10 | 主要影响 OGG 编码质量和体积，默认 5 |
| Stems | 是否逐轨输出等长音频 | 需要游戏内动态混音或后期分轨时开启 |
| SFZ profile | 乐器/奏法到 `.sfz` 的映射 | 仅 sfizz 使用；缺少映射时构建会失败 |

渲染器与 SFZ profile 会保存在项目的 `bench.json` 中，并被 Agent 读取，用于在写场景时提前检查乐器映射。其他面板参数是当前运行时选择。

## 输出文件

单场景 `forest.yaml` 通常得到：

```text
out/
├── forest.ogg
├── forest.meta.json
└── forest.stems/
    ├── 01-flute.ogg
    ├── 02-slow_strings.ogg
    └── ...
```

`meta.json` 是机器可读的构建结果，包含采样率、总采样数、循环区间、音频和 stems 等信息。scorebench 依赖这个文件判断构建成功，不解析 ScoreKit 的人类可读 stdout。

带 `sections` 的 suite 会按 section 输出多个音频资产。每条 stem 与对应完整混音采样对齐，可在游戏运行时增加或移除声部；它们不是“自动母带后的独立歌曲”。

## 确定性边界

- 同一场景、同一 ScoreKit 版本和同一 humanize seed 会生成相同 MIDI。
- 音频还依赖渲染器、SoundFont/SFZ、FFmpeg、采样率等外部环境。需要字节级一致时，应固定完整工具链和音源校验值。
- 更换音源不改变场景的音符结构，但可能显著改变包络、响度、频谱、空间感和奏法效果，必须重新试听。
- scorebench 不在渲染后追加压限、均衡、响度标准化或母带处理。

## 选择后端的简单决策

1. 还在改旋律/和声/段落？使用 FluidSynth。
2. 只想比较另一个 SF2 后端？尝试 TiMidity++。
3. 需要真实采样细节或多奏法？准备 SFZ 库和经过检查的 profile，再使用 sfizz。
4. 需要商业插件、DAW 效果链或复杂母带？导出 WAV/stems，交给外部制作流程；不要期待 scorebench 内置完成。
