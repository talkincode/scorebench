# 故障排查

先判断问题发生在哪一层：模型连接、场景协议、ScoreKit 环境、渲染后端、音源，还是最终听感。不要用“重新生成”掩盖环境错误。

## scorebench 找不到 ScoreKit

症状：启动提示 ScoreKit missing，或 Agent/Render 调用失败。

```bash
which scorekit
scorekit --version
scorekit doctor
```

终端可用但桌面应用不可用时，设置 `SCOREBENCH_SCOREKIT` 为可执行文件绝对路径后重新启动应用。确认文件对当前用户可执行。

## `doctor` 报告环境未就绪

ScoreKit 完整构建需要 FFmpeg 和至少一个渲染器：

- FluidSynth 缺失：安装 `fluid-synth`/`fluidsynth`；
- TiMidity++ 缺失：如果不用该后端可忽略；
- FFmpeg 缺失：安装后重新运行 `scorekit doctor`；
- 默认 SoundFont `missing`：重新安装 ScoreKit 默认音源，或配置 `SCOREKIT_SOUND_LIBRARY_DIR`。

`doctor` 的提示比本手册更了解当前平台和 ScoreKit 版本，应优先照它处理。

## YAML 无效或出现 unknown field

```bash
scorekit schema
scorekit --json validate path/to/scene.yaml
```

常见原因：

- 字段拼写错误或缩进错误；
- 把自然语言标签写成不存在的字段；
- `melody` 没有 `motif`，或引用了不存在的 motif；
- 非 `melody` 轨却设置了 motif/glide；
- `drums` instrument 与非 drums pattern 混用；
- track 超过 16，或出现多个鼓轨；
- 使用了比本机 ScoreKit 更新的字段。

让 Agent 根据错误中的 `field` 和 `message` 定点修复，不要删除不理解的整个段落。

## sfizz 无法渲染

按顺序检查：

1. Render 面板是否选择了 profile；
2. profile 的 `root` 和相对 `.sfz` 路径是否存在；
3. 场景中的每个 instrument 是否都有映射；
4. 每个 instrument 是否至少有 `sustain`；
5. `sfizz_render` 是否在 `PATH`；
6. profile 是否通过 `scorekit profile check profile.yaml`；
7. `.sfz` 引用的 WAV/FLAC 是否完整。

某个奏法没有专门映射时会回退到 sustain；整件乐器没有映射则会失败。

## articulation 没有听感变化

如果后端是 FluidSynth 或 TiMidity++，这是预期行为：`articulation` 不改变 MIDI，也不切换 SF2 program。只有 sfizz profile 可以把不同奏法映射到不同 `.sfz`。

如果已经使用 sfizz，检查 profile 是否为该奏法提供专门映射；否则它仍会回退到 sustain。

## 有输出，但乐器错误或没有声音

- SF2：确认是有效且映射完整的 GM SoundFont；
- SFZ：确认目标 patch 的音域覆盖场景实际音符；
- 检查 gain、track intensity 和 section intensity 是否过低；
- 检查 section 是否通过 0-based `mute` 索引静音了该轨；
- 不要仅看退出码，查看界面显示的结构化 ScoreKit 错误和 `meta.json`。

## 循环接缝听起来突兀

ScoreKit 能保证资产长度和接缝处理，但不能替代音乐上的闭环设计：

- 最后和弦是否愿意回到第一和弦；
- 末尾旋律是否突然停在强张力音；
- 末尾是否增加了开头没有的鼓/高频层；
- 是否使用 `loop: true`；
- 是否连续播放多轮而不是只听单次结尾。

## 场景有效，但听起来混浊或平

- 减少同时承担相同角色的轨道；
- 只保留一个明确低频核心；
- 给 melody 写休止；
- 用 section mute 做密度变化；
- 调整声像和背景强度，而不是所有轨一起加响；
- 先用默认音源确认编曲，再判断是否需要 SFZ；
- humanize 只能增加细微变化，不能修复结构问题。

## 模型连接失败

- 检查 Base URL 是否是 Responses API 兼容端点；
- 检查 model 名称和 API key 权限；
- 查看 HTTP 状态是鉴权、限流还是服务端错误；
- 如果使用 Azure/OpenAI 兼容代理，确认它支持工具调用和流式 Responses 事件；
- 不要把 key 粘贴到对话、场景或故障截图中。

## 仍然无法定位

报告问题时附上：

- scorebench 与 ScoreKit 版本；
- 操作系统和架构；
- `scorekit --json doctor` 的脱敏输出；
- 最小可复现 scene YAML；
- 选择的 renderer、采样率、格式和 profile 名称；
- 完整结构化错误；
- 是否可用默认 FluidSynth + MuseScore General 复现。

不要附 API key、授权头、私有音源文件或许可证不允许公开的采样。
