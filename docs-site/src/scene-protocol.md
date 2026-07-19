# ScoreKit 场景协议

场景文件是 Agent 与 ScoreKit 编译器之间的协议。它是严格的 UTF-8 YAML：未知字段会报错，字段范围和交叉约束会被校验，不会静默忽略拼写错误。

规范的机器真相始终是当前安装版本输出的 JSON Schema：

```bash
scorekit schema
scorekit --json validate scene.yaml
```

当本手册、示例与本机二进制不一致时，以本机 `scorekit schema` 为准。

## 最小但完整的场景

```yaml
title: Forest at Dusk
story: 夜间森林探索，安全、克制、带一点未知感。
tempo: 92
key: D_minor
time_signature: "4/4"
bars: 8
loop: true

harmony: [i, iv, VI, v]

performance:
  humanize: { timing_ms: 12, velocity: 8, seed: 7 }
  legato: true
  dynamics: { start: p, peak: mf }

motifs:
  forest_call:
    - { degree: 5, beats: 1 }
    - { degree: 8, beats: 1 }
    - { degree: 7, beats: 2 }
    - { degree: 0, beats: 4 }

tracks:
  - instrument: flute
    pattern: melody
    motif: forest_call
    intensity: 0.45
  - instrument: slow_strings
    pattern: sustain
    intensity: 0.35
  - instrument: harp
    pattern: arpeggio
    intensity: 0.3
  - instrument: bass
    pattern: bass
    intensity: 0.3
```

`story` 只为人和评审 Agent 保留叙事意图，并被带入 `meta.json`；它不改变任何音符或音频。

## 场景顶层字段

| 字段 | 音乐含义 | 关键约束 |
| --- | --- | --- |
| `title` | 人类可读标题 | 可选，不影响输出 |
| `story` | 主题、情绪、戏剧意图 | 可选，只提供信息 |
| `tempo` | 每分钟拍数 BPM | 20–300，必填 |
| `key` | 主音与大小调音阶 | 如 `C_major`、`F#_minor`；默认 `C_major` |
| `time_signature` | 拍号 | 如 `4/4`、`3/4`、`6/8`；默认 `4/4` |
| `bars` | 场景小节数 | 1–256，必填 |
| `loop` | 是否输出无缝循环 | 默认 `false` |
| `harmony` | 每小节一个罗马数字和弦 | 循环到场景结束 |
| `motifs` | 命名旋律动机 | 由 `melody` 轨引用 |
| `performance` | 摇摆、连奏、力度弧线、确定性人性化 | 可选 |
| `tracks` | 乐器轨道 | 1–16，最多一个鼓轨 |
| `sections` | 共享材料的多个段落/状态 | 可选，构建时逐段输出 |

ScoreKit 当前根据场景音阶构造自然音三和弦。罗马数字大小写是书写习惯，`VI` 与 `vi` 在当前协议中选择相同的音阶级数，并不会强制不同和弦性质。不要把它当作完整的古典和声记谱系统。

## 轨道与五种 pattern

每条轨道必须选择 `instrument` 和 `pattern`：

| pattern | 生成内容 | 常见角色 |
| --- | --- | --- |
| `melody` | 循环或截断指定 `motif` | 主题、对位、短句、带休止的进出 |
| `sustain` | 每小节持续完整和弦 | Pad、弦乐铺底、和声背景 |
| `arpeggio` | 以八分音符轮转根音、三音、五音、三音 | 流动织体、钢琴/竖琴分解 |
| `bass` | 当前和弦根音的低音型 | 低频支撑 |
| `drums` | 固定的底鼓、军鼓、踩镲节奏 | 基础律动；只能配 `instrument: drums` |

轨道还可设置：

- `intensity`：0.0–1.0，缩放该轨音符力度；
- `articulation`：`sustain`、`staccato`、`spiccato`、`pizzicato`、`tremolo`、`mute`；只用于 SFZ profile 选择样本，SF2 后端忽略；
- `pan`：0.0 最左、0.5 居中、1.0 最右，对应 MIDI CC10；
- `reverb`：0.0–1.0 的 MIDI CC91 发送量；SFZ 是否响应取决于 patch；
- `glide`：仅 `melody` 可用，控制每个音末尾滑向下一个音的比例。

## motif 与音级

motif 由 `{ degree, beats }` 组成：

- `degree: 1` 是当前调的主音；
- `degree: 8` 是高八度主音；
- `degree: 0` 是休止；
- 负数向下方音区延伸；
- `beats` 是以四分音符为一拍的时值，范围 0.125–16。

旋律会重复或截断以精确填满场景/section。超过 16 拍的长休止要拆成多个条目。

## performance

```yaml
performance:
  swing: 0.10
  legato: true
  humanize:
    timing_ms: 14
    velocity: 8
    seed: 42
  dynamics:
    start: p
    peak: f
```

- `swing` 延迟反拍八分音符，范围 0.0–0.5；
- `legato` 轻微延长非鼓音符，使相邻音衔接；
- `humanize` 对起音和力度做带 seed 的小幅变化，同一 seed 可复现；
- `dynamics` 使用 `pp p mp mf f ff`，从 `start` 上升到中点 `peak`，再回到 `start`，天然适合循环。

## sections：共享材料的场景组

```yaml
sections:
  - { name: intro, bars: 4, loop: false, mute: [2, 3], intensity: 0.7 }
  - { name: explore, bars: 8, loop: true, mute: [3], intensity: 0.9 }
  - { name: combat, bars: 8, loop: true, intensity: 1.25, tempo: 108 }
  - { name: victory, bars: 4, loop: false, mute: [3], intensity: 1.1 }
```

section 可以改变 `bars`、`tempo`、`loop`、整体 `intensity`，或通过 **从 0 开始的轨道索引** `mute` 声部。它们共享顶层的 key、harmony、motifs、tracks 和 performance；当前协议不能为每个 section 单独换和声或改 motif 内容。

## 不属于场景协议的内容

- SoundFont、SFZ 文件路径和渲染器；这些属于构建参数/渲染 profile。
- 任意的 `mood`、`danger`、`avoid` 等无编译语义标签；请写在对话或 `story` 中。
- 效果器链、母带、插件、音频后期；ScoreKit 不提供这些字段。
- MIDI 手工事件、自动化曲线和逐音符任意编辑；协议只支持 schema 声明的确定性结构。

需要完整字段范围和当前乐器枚举时，不要复制旧列表，直接运行 `scorekit schema`，或查阅 [ScoreKit Scene Protocol](https://talkincode.github.io/scorekit/scene-protocol.html)。
