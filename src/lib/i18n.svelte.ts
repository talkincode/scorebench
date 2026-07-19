/**
 * Minimal typed i18n: flat keys, en/zh dictionaries, reactive locale.
 * `t()` reads `i18n.locale` ($state), so any component using it re-renders
 * when the locale changes. English is the source of truth for keys.
 */

const en = {
  // Top bar
  "topbar.openFolder": "Open folder",
  "topbar.settings": "Settings",
  "topbar.openProject": "Open project…",
  "topbar.openProjectDialog": "Open project directory",

  // Welcome
  "welcome.eyebrow": "Agent-native music workbench",
  "welcome.body":
    "Open a scorekit project. Describe the music; the agent edits the scene, validates it, and renders the result.",
  "welcome.cta": "to begin.",
  "welcome.ctaButton": "Use Open project…",
  "setup.required": "scorekit setup required",
  "setup.notReady": "scorekit is not ready",

  // Workspace tabs
  "tabs.agent": "Agent",
  "tabs.source": "Source",
  "tabs.preview": "Preview",

  // Scene rail
  "rail.scenes": "Scenes",
  "rail.empty": "No scene YAML found.",
  "rail.noProject": "No project",
  "rail.play": "Play",
  "rail.noAudio": "No rendered audio",
  "rail.menu.delete": "Delete scene…",
  "rail.confirm.title": "Delete scene?",
  "rail.confirm.body": "This permanently removes {name} from the project directory.",
  "rail.confirm.cancel": "Cancel",
  "rail.confirm.delete": "Delete",

  // Chat
  "chat.emptyTitle": "Compose with Agent",
  "chat.emptyReady": "Describe the music or refine the selected scene.",
  "chat.emptyNoKey": "Connect the Responses API in Settings to begin composing.",
  "chat.emptyHint": "scorebench handles scene YAML, scorekit validation, and rendering.",
  "chat.placeholder": "Ask scorebench to create, edit, or refine your composition…",
  "chat.placeholderNoProject": "Open a project first",
  "chat.placeholderNoKey": "Set an API key in Settings",
  "chat.tip": "Tip: select a scene on the left to inspect, refine, and render it.",
  "chat.send": "Send message",
  "chat.stop": "Stop agent",
  "chat.attach": "Attach images or files",
  "chat.removeAttachment": "Remove attachment",
  "chat.session": "Session",
  "chat.newSession": "New session",
  "chat.newSessionTitle": "Session title (optional)",
  "chat.newSessionScene": "Link to current scene",
  "chat.newSessionCreate": "Create",
  "chat.newSessionCancel": "Cancel",
  "chat.loadingTranscript": "Loading session transcript…",
  "chat.output": "output",

  // Scene panel
  "panel.observe": "Observe",
  "panel.render": "Render",
  "panel.outputs": "Outputs",
  "panel.profileTitle": "Musical profile",
  "panel.sceneSignal": "Scene signal",
  "panel.refresh": "Refresh",
  "panel.selectScene": "Select a scene.",
  "panel.reading": "Reading scene signal…",
  "panel.unparseable": "Unparseable YAML",
  "panel.title": "Title",
  "panel.untitled": "Untitled scene",
  "panel.tempo": "Tempo",
  "panel.key": "Key",
  "panel.meter": "Meter",
  "panel.bars": "Bars",
  "panel.loop": "Loop",
  "panel.performance": "Performance",
  "panel.present": "Present",
  "panel.default": "Default",
  "panel.yes": "Yes",
  "panel.no": "No",
  "panel.tracksSections": "{tracks} tracks · {sections} sections",
  "panel.lastChange": "Last agent change",
  "panel.renderControls": "Render controls",
  "panel.renderer": "Renderer",
  "panel.sampleRate": "Sample rate",
  "panel.format": "Format",
  "panel.gain": "Gain",
  "panel.quality": "Quality",
  "panel.stems": "Stems",
  "panel.sfzProfile": "SFZ profile",
  "panel.chooseProfile": "Choose…",
  "panel.profileHint": "sfizz needs a profile YAML mapping instruments to .sfz files.",
  "panel.profileDialog": "Choose sfizz profile YAML",
  "panel.renderBtn": "Render",
  "panel.rendering": "Rendering…",
  "panel.currentOutputs": "Current outputs",
  "panel.nothingRendered": "Nothing rendered yet.",
  "panel.openOutput": "Open output folder",
  "panel.loadIntoPlayer": "Load into player",

  // Gauges
  "gauge.density": "Density",
  "gauge.dynamics": "Dynamics",
  "gauge.complexity": "Complexity",
  "gauge.energy": "Energy",

  // Source / preview views
  "source.empty": "Select a scene to view its YAML.",
  "source.loading": "Reading scene source…",
  "source.readOnly": "Read-only · the agent is the only writer",
  "preview.empty": "Select a scene to preview its structure.",
  "preview.loading": "Reading scene…",
  "preview.harmony": "Harmony",
  "preview.sections": "Sections",
  "preview.tracks": "Tracks",
  "preview.track": "Track",
  "preview.instrument": "Instrument",
  "preview.pattern": "Pattern",
  "preview.motif": "Motif",
  "preview.intensity": "Intensity",
  "preview.articulation": "Articulation",
  "preview.noTracks": "No tracks declared.",

  // Player
  "player.visual": "Visual",
  "player.auto": "Auto",
  "player.expand": "Expand visualizer",
  "player.loop": "Loop playback",
  "player.spectrumStyle": "Spectrum style",

  // Settings modal
  "settings.title": "Agent settings",
  "settings.subtitle": "Stored outside project directories. The API key is write-only.",
  "settings.close": "Close settings",
  "settings.tab.connection": "Connection",
  "settings.tab.persona": "Persona",
  "settings.tab.interface": "Interface",
  "settings.tone": "Interface tone",
  "settings.livePreview": "Live preview",
  "settings.hue": "Interface hue",
  "settings.tonePresets": "Tone presets",
  "settings.baseUrl": "Responses API base URL",
  "settings.model": "Model",
  "settings.contextBudget": "Context budget",
  "settings.maxTurns": "Maximum turns",
  "settings.apiKey": "API key",
  "settings.keySet": "set",
  "settings.keyNotSet": "not set",
  "settings.keyKeep": "Leave blank to keep the stored key",
  "settings.keyEnter": "Enter API key",
  "settings.insecure":
    "If the OS keychain is unavailable, store the key insecurely in app config with mode 0600.",
  "settings.personaLabel": "Personal style & skill directives",
  "settings.personaHint":
    "Injected into every agent run. Describe your creative style, favourite idioms, and standing instructions.",
  "settings.personaPlaceholder":
    "e.g. Prefer lush jazz voicings; keep drums understated; always name scenes in English…",
  "settings.language": "Language",
  "settings.versions": "Version information",
  "settings.testConnection": "Test connection",
  "settings.cancel": "Cancel",
  "settings.save": "Save",
  "settings.saving": "Saving…",
  "settings.saved": "Settings saved.",
  "settings.testing": "Testing connection…",

  // Visualizer overlay
  "overlay.close": "Close visualizer",
  "overlay.hint": "Esc to close",
};

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  "topbar.openFolder": "打开目录",
  "topbar.settings": "设置",
  "topbar.openProject": "打开项目…",
  "topbar.openProjectDialog": "打开项目目录",

  "welcome.eyebrow": "Agent 原生音乐工作台",
  "welcome.body": "打开一个 scorekit 项目。描述你想要的音乐，agent 会编辑场景、校验并渲染结果。",
  "welcome.cta": "开始创作。",
  "welcome.ctaButton": "点击「打开项目…」",
  "setup.required": "需要安装 scorekit",
  "setup.notReady": "scorekit 尚未就绪",

  "tabs.agent": "Agent",
  "tabs.source": "源码",
  "tabs.preview": "预览",

  "rail.scenes": "场景",
  "rail.empty": "没有找到场景 YAML。",
  "rail.noProject": "未打开项目",
  "rail.play": "播放",
  "rail.noAudio": "尚无渲染音频",
  "rail.menu.delete": "删除场景…",
  "rail.confirm.title": "删除场景？",
  "rail.confirm.body": "将从项目目录中永久删除 {name}。",
  "rail.confirm.cancel": "取消",
  "rail.confirm.delete": "删除",

  "chat.emptyTitle": "与 Agent 一起作曲",
  "chat.emptyReady": "描述音乐，或继续打磨当前场景。",
  "chat.emptyNoKey": "先在设置中连接 Responses API。",
  "chat.emptyHint": "scorebench 负责场景 YAML、scorekit 校验与渲染。",
  "chat.placeholder": "让 scorebench 创建、编辑或润色你的作品…",
  "chat.placeholderNoProject": "请先打开项目",
  "chat.placeholderNoKey": "请先在设置中配置 API key",
  "chat.tip": "提示：在左侧选择场景即可检视、打磨并渲染。",
  "chat.send": "发送",
  "chat.stop": "停止 agent",
  "chat.attach": "添加图片或文件",
  "chat.removeAttachment": "移除附件",
  "chat.session": "会话",
  "chat.newSession": "新建会话",
  "chat.newSessionTitle": "会话标题（可选）",
  "chat.newSessionScene": "关联当前场景",
  "chat.newSessionCreate": "创建",
  "chat.newSessionCancel": "取消",
  "chat.loadingTranscript": "正在加载会话记录…",
  "chat.output": "输出",

  "panel.observe": "观测",
  "panel.render": "渲染",
  "panel.outputs": "产物",
  "panel.profileTitle": "音乐画像",
  "panel.sceneSignal": "场景信号",
  "panel.refresh": "刷新",
  "panel.selectScene": "请选择一个场景。",
  "panel.reading": "正在读取场景信号…",
  "panel.unparseable": "YAML 无法解析",
  "panel.title": "标题",
  "panel.untitled": "未命名场景",
  "panel.tempo": "速度",
  "panel.key": "调性",
  "panel.meter": "拍号",
  "panel.bars": "小节",
  "panel.loop": "循环",
  "panel.performance": "演奏参数",
  "panel.present": "已设置",
  "panel.default": "默认",
  "panel.yes": "是",
  "panel.no": "否",
  "panel.tracksSections": "{tracks} 轨 · {sections} 段落",
  "panel.lastChange": "Agent 最近一次修改",
  "panel.renderControls": "渲染参数",
  "panel.renderer": "渲染器",
  "panel.sampleRate": "采样率",
  "panel.format": "格式",
  "panel.gain": "增益",
  "panel.quality": "质量",
  "panel.stems": "分轨",
  "panel.sfzProfile": "SFZ profile",
  "panel.chooseProfile": "选择…",
  "panel.profileHint": "sfizz 需要一个把乐器映射到 .sfz 的 profile YAML。",
  "panel.profileDialog": "选择 sfizz profile YAML",
  "panel.renderBtn": "渲染",
  "panel.rendering": "渲染中…",
  "panel.currentOutputs": "当前产物",
  "panel.nothingRendered": "还没有渲染结果。",
  "panel.openOutput": "打开输出目录",
  "panel.loadIntoPlayer": "载入播放器",

  "gauge.density": "密度",
  "gauge.dynamics": "动态",
  "gauge.complexity": "复杂度",
  "gauge.energy": "能量",

  "source.empty": "选择场景以查看 YAML 源码。",
  "source.loading": "正在读取场景源码…",
  "source.readOnly": "只读 · 仅 agent 可写入",
  "preview.empty": "选择场景以预览其结构。",
  "preview.loading": "正在读取场景…",
  "preview.harmony": "和声",
  "preview.sections": "段落",
  "preview.tracks": "音轨",
  "preview.track": "音轨",
  "preview.instrument": "乐器",
  "preview.pattern": "型态",
  "preview.motif": "动机",
  "preview.intensity": "强度",
  "preview.articulation": "奏法",
  "preview.noTracks": "没有声明音轨。",

  "player.visual": "视觉",
  "player.auto": "自动",
  "player.expand": "全屏视觉",
  "player.loop": "循环播放",
  "player.spectrumStyle": "频谱风格",

  "settings.title": "Agent 设置",
  "settings.subtitle": "存储在项目目录之外。API key 只写不读。",
  "settings.close": "关闭设置",
  "settings.tab.connection": "连接",
  "settings.tab.persona": "创作人格",
  "settings.tab.interface": "界面",
  "settings.tone": "界面色调",
  "settings.livePreview": "实时预览",
  "settings.hue": "界面色相",
  "settings.tonePresets": "色调预设",
  "settings.baseUrl": "Responses API base URL",
  "settings.model": "模型",
  "settings.contextBudget": "上下文预算",
  "settings.maxTurns": "最大轮数",
  "settings.apiKey": "API key",
  "settings.keySet": "已设置",
  "settings.keyNotSet": "未设置",
  "settings.keyKeep": "留空则保留已存储的 key",
  "settings.keyEnter": "输入 API key",
  "settings.insecure": "当系统钥匙串不可用时，以 0600 权限把 key 不安全地存入应用配置。",
  "settings.personaLabel": "个性化风格与技能指令",
  "settings.personaHint": "会注入每次 agent 运行。描述你的创作风格、常用语汇与固定要求。",
  "settings.personaPlaceholder": "例如：偏好丰满的爵士和声；鼓点保持克制；场景一律用英文命名…",
  "settings.language": "界面语言",
  "settings.versions": "版本信息",
  "settings.testConnection": "测试连接",
  "settings.cancel": "取消",
  "settings.save": "保存",
  "settings.saving": "保存中…",
  "settings.saved": "设置已保存。",
  "settings.testing": "正在测试连接…",

  "overlay.close": "关闭视觉",
  "overlay.hint": "按 Esc 关闭",
};

const dictionaries: Record<"en" | "zh", Record<MessageKey, string>> = { en, zh };

export type Locale = "en" | "zh";

class I18nState {
  locale = $state<Locale>("en");
}

export const i18n = new I18nState();

export function setLocale(locale: string) {
  i18n.locale = locale === "zh" ? "zh" : "en";
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text = dictionaries[i18n.locale][key] ?? en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
