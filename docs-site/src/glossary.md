# 术语表

## 产品与协议

| 术语 | 解释 |
| --- | --- |
| Agent | 根据自然语言目标选择步骤、调用工具并修改场景的模型驱动组件。 |
| Scene / 场景 | 一份可编译的 YAML 音乐描述；也可以包含多个共享材料的 sections。 |
| DSL | Domain-Specific Language，领域专用语言；这里指 ScoreKit 场景 YAML。 |
| Schema | 场景字段、类型、范围和约束的机器可读规范，由 `scorekit schema` 输出。 |
| Deterministic / 确定性 | 相同输入与固定版本产生相同结果；humanize 通过 seed 保持可复现。 |
| Semantic diff / 语义差异 | 比较音乐含义，而不是空格、缩进等文本格式。 |
| `story` | 场景的叙事意图，只进入元数据和评审上下文，不生成音符。 |
| StylePack | scorebench 中给 Agent 使用的结构化创作偏好与评审标准。 |
| Grammar / 音乐文法 | ScoreKit 对编译结果执行的可量化审美约束，不是渲染器配置。 |

## 音乐结构

| 术语 | 解释 |
| --- | --- |
| BPM / Tempo | 每分钟拍数，数值越大通常速度越快。 |
| Beat / 拍 | ScoreKit motif 中 `beats` 的时值单位，以四分音符为一拍。 |
| Bar / 小节 | 按拍号组织的一组拍；`bars` 决定场景长度。 |
| Time signature / 拍号 | 如 4/4、3/4、6/8；分子表示每小节拍数，分母表示拍的记谱单位。 |
| Key / 调性 | 主音与 major/minor 音阶，如 `D_minor`。 |
| Scale degree / 音级 | 音在当前音阶中的位置；ScoreKit 中 1 是主音，8 是高八度主音，0 是休止。 |
| Motif / 动机 | 短小、可重复辨认的旋律或节奏材料。 |
| Harmony / 和声 | 同时或连续组织的和弦关系；ScoreKit 当前每小节使用一个自然音级三和弦。 |
| Roman numeral / 罗马数字 | 用 I–VII 表示调内和弦所在音阶级数；ScoreKit 当前大小写不改变所选级数。 |
| Pattern | ScoreKit 的音符生成方式：melody、sustain、arpeggio、bass、drums。 |
| Arrangement / 编曲 | 把旋律、和声、低音、节奏和音色分配给不同乐器与段落。 |
| Texture / 织体 | 声部同时如何组织，例如稀疏独奏、旋律加伴奏或厚重和声层。 |
| Register / 音区 | 声音处在低、中、高哪个范围。 |
| Section | suite 中的命名段落，可改长度、速度、循环、整体强度和静音轨道。 |

## 演奏与空间

| 术语 | 解释 |
| --- | --- |
| Intensity | 轨道力度缩放；section intensity 会再乘到所有轨道。 |
| Dynamics / 力度 | pp、p、mp、mf、f、ff 等强弱层级；ScoreKit 可生成中点峰值的力度弧。 |
| Articulation / 奏法 | sustain、staccato、pizzicato 等发音方式；当前只用于 SFZ profile 选样本。 |
| Legato / 连奏 | 相邻音衔接或重叠；协议的 legato 不等于采样库中的专用连奏脚本。 |
| Swing / 摇摆 | 延后反拍八分音符形成不均分律动。 |
| Humanize / 人性化 | 对起音时间和力度做小幅、带 seed 的可复现变化。 |
| Glide / 滑音 | 旋律音尾通过 pitch bend 滑向下一个音。 |
| Pan / 声像 | 声音在左右声道中的位置，对应 MIDI CC10。 |
| Reverb send / 混响发送 | 发送到合成器混响效果的控制值，对应 MIDI CC91；实际响应取决于后端/音源。 |

## 渲染与音源

| 术语 | 解释 |
| --- | --- |
| MIDI | 记录音高、时值、力度、program/CC 等演奏事件的数据，不包含真实声音。 |
| Renderer / 渲染器 | 把 MIDI 和音源转换为 PCM 音频的软件，如 FluidSynth、TiMidity++、sfizz。 |
| SoundFont / SF2 | 把多个 GM 乐器采样和映射打包在一个文件中的音源格式。 |
| SFZ | 用文本描述采样映射的乐器格式，通常引用外部 WAV/FLAC 文件。 |
| Renderer profile | 把 ScoreKit instrument/articulation 映射到本机 `.sfz` 的 YAML。 |
| General MIDI / GM | 标准化的 program 与鼓通道约定，让场景乐器能映射到兼容 SoundFont。 |
| Sample / 采样 | 真实或合成声音的数字录音片段，采样乐器用它们重建演奏。 |
| Sample rate / 采样率 | 每秒音频采样数，常见为 44100 或 48000 Hz。 |
| Gain / 增益 | 渲染时的整体幅度倍率，不等同于响度标准化或母带。 |
| OGG | 使用 Vorbis 压缩的有损音频，体积较小。 |
| WAV | 通常为未压缩 PCM 音频，体积较大，适合后续制作。 |
| Stem / 分轨 | 一条轨道单独渲染的等长音频，可用于动态混音或后期。 |
| `meta.json` | 与音频同名的机器可读元数据，记录采样数、循环点、stems 等。 |
| Loop / 循环 | 结尾接回开头继续播放的资产。ScoreKit 对 loop 做采样级长度与接缝处理。 |
| One-shot | 播放一次后结束的 cue，通常保留衰减尾音。 |
| Tail / 尾音 | one-shot 主体结束后保留的混响或乐器衰减。 |
