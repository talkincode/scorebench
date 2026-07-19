/**
 * Creative assist tag library: prompt fragments the user clicks into the
 * chat input. Pure data — the agent remains the only writer of scene YAML.
 *
 * Instrument names inside `text` use real scorekit DSL instrument keys
 * (see `scorekit schema --json` $defs.Instrument) so the agent can map the
 * suggestion straight onto tracks.
 *
 * `recommends` lists tag ids (any category) that pair well; the panel
 * highlights them once a tag is selected ("smart mode").
 */

export interface AssistTag {
  id: string;
  label: { en: string; zh: string };
  /** One prompt line inserted into the chat input. */
  text: { en: string; zh: string };
  /** Ids of tags (across categories) that pair well with this one. */
  recommends?: string[];
}

export interface AssistCategory {
  id: string;
  label: { en: string; zh: string };
  tags: AssistTag[];
}

export const ASSIST_CATEGORIES: AssistCategory[] = [
  {
    id: "mood",
    label: { en: "Mood", zh: "情绪表达" },
    tags: [
      {
        id: "mood.sad",
        label: { en: "Sad", zh: "悲伤" },
        text: {
          en: "Mood: sorrowful — minor key, slow tempo (60-72 BPM), descending melodic lines, restrained dynamics.",
          zh: "情绪：悲伤——小调、慢速（60-72 BPM）、下行旋律线，力度克制，哀而不伤。",
        },
        recommends: [
          "inst.piano-strings",
          "inst.cello-piano",
          "perf.legato",
          "perf.rubato",
          "genre.ballad",
          "genre.cinematic",
        ],
      },
      {
        id: "mood.joyful",
        label: { en: "Joyful", zh: "欢快" },
        text: {
          en: "Mood: joyful — major key, upbeat tempo (110-132 BPM), bouncing rhythms and bright timbres.",
          zh: "情绪：欢快——大调、明快速度（110-132 BPM）、跳跃的节奏与明亮音色。",
        },
        recommends: ["perf.staccato", "perf.syncopation", "genre.folk", "region.latin", "inst.chamber-winds"],
      },
      {
        id: "mood.tense",
        label: { en: "Tense", zh: "紧张" },
        text: {
          en: "Mood: tense — driving ostinato, dissonant accents, tight low-register pulse that keeps rising.",
          zh: "情绪：紧张——推进的固定音型、不协和重音、低音区紧凑脉冲逐步收紧。",
        },
        recommends: ["perf.ostinato", "perf.tremolo", "genre.cinematic", "inst.orchestra"],
      },
      {
        id: "mood.epic",
        label: { en: "Epic", zh: "史诗" },
        text: {
          en: "Mood: epic — huge dynamic arc, heroic brass themes over full strings, timpani hits at climaxes.",
          zh: "情绪：史诗——宏大的力度弧线，铜管英雄主题叠满编弦乐，高潮处定音鼓强击。",
        },
        recommends: ["inst.orchestra", "perf.ostinato", "genre.cinematic", "perf.call-response"],
      },
      {
        id: "mood.calm",
        label: { en: "Calm", zh: "平静" },
        text: {
          en: "Mood: calm — slow harmonic rhythm, soft pad or sustained strings, sparse gentle melody.",
          zh: "情绪：平静——和声节奏缓慢，柔和 pad 或持续弦乐铺底，旋律稀疏轻柔。",
        },
        recommends: ["inst.synth-ambient", "perf.legato", "genre.ambient", "inst.piano-solo"],
      },
      {
        id: "mood.nostalgic",
        label: { en: "Nostalgic", zh: "怀旧" },
        text: {
          en: "Mood: nostalgic — warm mid-register voicing, gentle swing, slightly bittersweet major-minor shifts.",
          zh: "情绪：怀旧——温暖的中音区排列、轻微摇摆感、大小调间略带苦甜的游移。",
        },
        recommends: ["genre.lofi", "genre.jazz", "inst.epiano-combo", "perf.rubato"],
      },
      {
        id: "mood.mysterious",
        label: { en: "Mysterious", zh: "神秘" },
        text: {
          en: "Mood: mysterious — ambiguous harmony, low sustained tones, sparse bell-like accents in silence.",
          zh: "情绪：神秘——含混的和声、低音持续音，寂静中点缀稀疏的钟铃质感重音。",
        },
        recommends: ["inst.synth-ambient", "perf.tremolo", "genre.ambient", "region.east-asia"],
      },
      {
        id: "mood.hopeful",
        label: { en: "Hopeful", zh: "希望" },
        text: {
          en: "Mood: hopeful — rising melodic contours, brightening harmony that opens from minor into major.",
          zh: "情绪：希望——旋律轮廓不断上行，和声由小调渐次打开走向大调的明亮。",
        },
        recommends: ["inst.piano-strings", "perf.arpeggio", "genre.cinematic", "perf.crescendo"],
      },
    ],
  },
  {
    id: "instrumentation",
    label: { en: "Instrumentation", zh: "乐器组合" },
    tags: [
      {
        id: "inst.piano-solo",
        label: { en: "Solo piano", zh: "钢琴独奏" },
        text: {
          en: "Instrumentation: solo piano — one `piano` track carrying melody and harmony together.",
          zh: "乐器组合：钢琴独奏——单条 `piano` 轨同时承担旋律与和声。",
        },
        recommends: ["mood.calm", "perf.rubato", "genre.classical"],
      },
      {
        id: "inst.piano-strings",
        label: { en: "Piano + strings", zh: "钢琴+弦乐" },
        text: {
          en: "Instrumentation: `piano` lead over sustained `strings` (or `slow_strings`) pads, optional `cello` counter-line.",
          zh: "乐器组合：`piano` 主奏铺在持续的 `strings`（或 `slow_strings`）之上，可加 `cello` 对位线。",
        },
        recommends: ["mood.sad", "mood.hopeful", "genre.cinematic", "perf.legato"],
      },
      {
        id: "inst.string-quartet",
        label: { en: "String quartet", zh: "弦乐四重奏" },
        text: {
          en: "Instrumentation: string quartet — `violin` ×2 roles, `viola`, `cello`; conversational four-part writing.",
          zh: "乐器组合：弦乐四重奏——`violin` 两声部、`viola`、`cello`，四声部对话式写作。",
        },
        recommends: ["genre.classical", "perf.call-response", "perf.pizzicato-style"],
      },
      {
        id: "inst.cello-piano",
        label: { en: "Cello + piano", zh: "大提琴+钢琴" },
        text: {
          en: "Instrumentation: `cello` singing the melody with `piano` accompaniment — intimate duo writing.",
          zh: "乐器组合：`cello` 歌唱旋律、`piano` 伴奏——亲密的二重奏写法。",
        },
        recommends: ["mood.sad", "perf.legato", "perf.rubato", "genre.classical"],
      },
      {
        id: "inst.orchestra",
        label: { en: "Full orchestra", zh: "管弦乐队" },
        text: {
          en: "Instrumentation: full orchestra — `strings`, `brass`, `horn`, `flute`/`oboe`/`clarinet` woodwinds, `timpani`, optional `harp`.",
          zh: "乐器组合：管弦乐队——`strings`、`brass`、`horn`，木管 `flute`/`oboe`/`clarinet`，`timpani`，可加 `harp`。",
        },
        recommends: ["mood.epic", "genre.cinematic", "perf.crescendo", "perf.tremolo"],
      },
      {
        id: "inst.jazz-combo",
        label: { en: "Jazz combo", zh: "爵士三重奏" },
        text: {
          en: "Instrumentation: jazz combo — `epiano` or `piano` comping, walking `bass`, brushed `drums`, optional `sax` lead.",
          zh: "乐器组合：爵士三重奏——`epiano` 或 `piano` 伴奏，行走 `bass`，刷子 `drums`，可加 `sax` 主奏。",
        },
        recommends: ["genre.jazz", "perf.syncopation", "mood.nostalgic"],
      },
      {
        id: "inst.epiano-combo",
        label: { en: "E-piano groove", zh: "电钢律动组" },
        text: {
          en: "Instrumentation: `epiano` chords, `fretless_bass` or `synth_bass`, tight `drums`, `vibraphone` sprinkles.",
          zh: "乐器组合：`epiano` 和弦、`fretless_bass` 或 `synth_bass`、紧凑 `drums`，点缀 `vibraphone`。",
        },
        recommends: ["genre.lofi", "mood.nostalgic", "perf.syncopation"],
      },
      {
        id: "inst.rock-band",
        label: { en: "Rock band", zh: "摇滚编制" },
        text: {
          en: "Instrumentation: rock band — `electric_guitar` riffs, `picked_bass`, hard `drums`, optional `organ` pad.",
          zh: "乐器组合：摇滚编制——`electric_guitar` 连复段、`picked_bass`、有力的 `drums`，可加 `organ` 铺底。",
        },
        recommends: ["genre.rock", "perf.ostinato", "mood.tense"],
      },
      {
        id: "inst.synth-ambient",
        label: { en: "Synth ambient", zh: "合成器氛围" },
        text: {
          en: "Instrumentation: layered synth pads — `warm_pad`, `halo_pad` or `bowed_pad`, slow `synth_strings`, sparse `music_box` accents.",
          zh: "乐器组合：合成器 pad 层叠——`warm_pad`、`halo_pad` 或 `bowed_pad`，缓慢 `synth_strings`，稀疏 `music_box` 点缀。",
        },
        recommends: ["genre.ambient", "mood.calm", "mood.mysterious", "genre.electronic"],
      },
      {
        id: "inst.chamber-winds",
        label: { en: "Wind ensemble", zh: "木管重奏" },
        text: {
          en: "Instrumentation: wind ensemble — `flute` lead, `clarinet` and `oboe` inner voices, `bassoon` bass line.",
          zh: "乐器组合：木管重奏——`flute` 主奏，`clarinet` 与 `oboe` 内声部，`bassoon` 低音线。",
        },
        recommends: ["mood.joyful", "genre.classical", "region.celtic"],
      },
      {
        id: "inst.chiptune-kit",
        label: { en: "Chiptune kit", zh: "芯片音源组" },
        text: {
          en: "Instrumentation: chiptune kit — `square_lead` melody, `saw_lead` harmony, `synth_bass`, punchy `drums`.",
          zh: "乐器组合：芯片音源组——`square_lead` 旋律、`saw_lead` 和声、`synth_bass`、干脆的 `drums`。",
        },
        recommends: ["genre.chiptune", "perf.arpeggio", "mood.joyful"],
      },
      {
        id: "inst.choir-orchestra",
        label: { en: "Choir + orchestra", zh: "合唱+乐队" },
        text: {
          en: "Instrumentation: `choir` (or `choir_pad`) over `strings` and `horn` — sacred, monumental colour.",
          zh: "乐器组合：`choir`（或 `choir_pad`）叠加 `strings` 与 `horn`——庄严宏大的色彩。",
        },
        recommends: ["mood.epic", "genre.cinematic", "perf.crescendo"],
      },
    ],
  },
  {
    id: "performance",
    label: { en: "Performance", zh: "演奏风格" },
    tags: [
      {
        id: "perf.legato",
        label: { en: "Legato", zh: "连奏" },
        text: {
          en: "Performance: legato phrasing — long connected lines, overlapping note ends, minimal articulation gaps.",
          zh: "演奏风格：连奏——长气息连贯乐句，音尾交叠，几乎无断口。",
        },
        recommends: ["mood.sad", "mood.calm", "inst.piano-strings"],
      },
      {
        id: "perf.staccato",
        label: { en: "Staccato", zh: "断奏" },
        text: {
          en: "Performance: staccato — short detached notes, playful precision, lots of air between attacks.",
          zh: "演奏风格：断奏——短促分离的音符，精准俏皮，音与音之间留足空气感。",
        },
        recommends: ["mood.joyful", "perf.syncopation", "inst.chamber-winds"],
      },
      {
        id: "perf.arpeggio",
        label: { en: "Arpeggiated", zh: "琶音分解" },
        text: {
          en: "Performance: arpeggiated accompaniment — broken-chord figures flowing under the melody.",
          zh: "演奏风格：琶音分解伴奏——分解和弦音型在旋律下方流动。",
        },
        recommends: ["mood.hopeful", "inst.piano-solo", "genre.classical"],
      },
      {
        id: "perf.ostinato",
        label: { en: "Ostinato", zh: "固定音型" },
        text: {
          en: "Performance: ostinato — a relentless repeating rhythmic cell that drives the whole scene forward.",
          zh: "演奏风格：固定音型——不断重复的节奏细胞，推动整段音乐持续向前。",
        },
        recommends: ["mood.tense", "mood.epic", "genre.cinematic", "inst.rock-band"],
      },
      {
        id: "perf.tremolo",
        label: { en: "Tremolo", zh: "震音" },
        text: {
          en: "Performance: string tremolo — use `tremolo_strings` for shimmering suspense layers.",
          zh: "演奏风格：弦乐震音——用 `tremolo_strings` 制造颤动悬疑的层次。",
        },
        recommends: ["mood.tense", "mood.mysterious", "inst.orchestra"],
      },
      {
        id: "perf.pizzicato-style",
        label: { en: "Pizzicato", zh: "拨奏" },
        text: {
          en: "Performance: pizzicato strings — use `pizzicato` for light plucked rhythmic support.",
          zh: "演奏风格：弦乐拨奏——用 `pizzicato` 提供轻盈的弹拨节奏支撑。",
        },
        recommends: ["mood.joyful", "inst.string-quartet", "perf.staccato"],
      },
      {
        id: "perf.syncopation",
        label: { en: "Syncopation", zh: "切分律动" },
        text: {
          en: "Performance: syncopated groove — off-beat accents and anticipations that make the rhythm dance.",
          zh: "演奏风格：切分律动——反拍重音与抢拍让节奏舞动起来。",
        },
        recommends: ["genre.jazz", "region.latin", "mood.joyful"],
      },
      {
        id: "perf.rubato",
        label: { en: "Rubato", zh: "自由节奏" },
        text: {
          en: "Performance: rubato feel — breathing tempo, phrase endings that relax, expressive timing over strict grid.",
          zh: "演奏风格：自由节奏——呼吸般的速度伸缩，乐句尾自然松弛，表现力优先于严格网格。",
        },
        recommends: ["mood.sad", "mood.nostalgic", "inst.piano-solo"],
      },
      {
        id: "perf.call-response",
        label: { en: "Call & response", zh: "呼应对答" },
        text: {
          en: "Performance: call and response — two voices trading phrases, question in one register, answer in another.",
          zh: "演奏风格：呼应对答——两个声部轮流接句，一处发问、另一处应答。",
        },
        recommends: ["inst.string-quartet", "genre.jazz", "mood.epic"],
      },
      {
        id: "perf.crescendo",
        label: { en: "Long crescendo", zh: "长渐强" },
        text: {
          en: "Performance: one long crescendo — start sparse and quiet, add layers each section toward a full climax.",
          zh: "演奏风格：一条长渐强——从稀疏安静起步，每个段落叠加声部，直至完全的高潮。",
        },
        recommends: ["mood.epic", "mood.hopeful", "inst.orchestra", "genre.cinematic"],
      },
    ],
  },
  {
    id: "regional",
    label: { en: "Regional", zh: "地域风格" },
    tags: [
      {
        id: "region.east-asia",
        label: { en: "East Asian", zh: "东方雅韵" },
        text: {
          en: "Regional colour: East Asian — pentatonic melodies, `harp` imitating plucked zither, airy `flute` ornaments, space and silence.",
          zh: "地域风格：东方雅韵——五声音阶旋律，`harp` 模拟古筝弹拨，`flute` 气声装饰，重视留白。",
        },
        recommends: ["mood.mysterious", "mood.calm", "perf.rubato"],
      },
      {
        id: "region.celtic",
        label: { en: "Celtic", zh: "凯尔特" },
        text: {
          en: "Regional colour: Celtic — dancing 6/8 jig feel, `whistle` or `recorder` lead, drone bass, modal (dorian) harmony.",
          zh: "地域风格：凯尔特——舞动的 6/8 吉格律动，`whistle` 或 `recorder` 主奏，持续低音，多利亚调式。",
        },
        recommends: ["mood.joyful", "genre.folk", "inst.chamber-winds"],
      },
      {
        id: "region.latin",
        label: { en: "Latin", zh: "拉丁" },
        text: {
          en: "Regional colour: Latin — clave-driven syncopation, `guitar` montuno patterns, bright `trumpet` hits, percussive `drums`.",
          zh: "地域风格：拉丁——clave 骨架的切分，`guitar` montuno 音型，明亮 `trumpet` 重音，打击感 `drums`。",
        },
        recommends: ["perf.syncopation", "mood.joyful", "genre.jazz"],
      },
      {
        id: "region.middle-east",
        label: { en: "Middle Eastern", zh: "中东" },
        text: {
          en: "Regional colour: Middle Eastern — harmonic-minor/phrygian melodic turns, ornamented `oboe` or `english_horn` lead, hand-drum groove.",
          zh: "地域风格：中东——和声小调/弗里几亚旋法转折，装饰化的 `oboe` 或 `english_horn` 主奏，手鼓律动。",
        },
        recommends: ["mood.mysterious", "perf.ostinato", "genre.cinematic"],
      },
      {
        id: "region.nordic",
        label: { en: "Nordic", zh: "北欧" },
        text: {
          en: "Regional colour: Nordic — cold open fifths, slow `strings` under fragile `violin` melody, vast and austere space.",
          zh: "地域风格：北欧——清冷的空五度，缓慢 `strings` 铺底、脆弱的 `violin` 旋律，辽阔而克制。",
        },
        recommends: ["mood.calm", "mood.sad", "genre.ambient", "genre.cinematic"],
      },
      {
        id: "region.african",
        label: { en: "African", zh: "非洲律动" },
        text: {
          en: "Regional colour: African — interlocking polyrhythms, `marimba` and `xylophone` patterns, call-and-response voices.",
          zh: "地域风格：非洲律动——交错的复合节奏，`marimba` 与 `xylophone` 音型，呼应对答的声部。",
        },
        recommends: ["perf.call-response", "perf.syncopation", "mood.joyful"],
      },
      {
        id: "region.americana",
        label: { en: "Americana", zh: "美式乡野" },
        text: {
          en: "Regional colour: Americana — open-string `steel_guitar` or `guitar` picking, warm `accordion` or `harmonica`-like pads, easy shuffle.",
          zh: "地域风格：美式乡野——`steel_guitar` 或 `guitar` 开放弦分解，温暖的 `accordion` 质感铺底，松弛的 shuffle。",
        },
        recommends: ["genre.folk", "mood.nostalgic", "perf.syncopation"],
      },
    ],
  },
  {
    id: "genre",
    label: { en: "Genre", zh: "流派" },
    tags: [
      {
        id: "genre.classical",
        label: { en: "Classical", zh: "古典" },
        text: {
          en: "Genre: classical chamber writing — clear periodic phrases, functional harmony, balanced voice leading.",
          zh: "流派：古典室内乐写作——清晰的方整乐句、功能和声、均衡的声部进行。",
        },
        recommends: ["inst.string-quartet", "perf.arpeggio", "inst.piano-solo"],
      },
      {
        id: "genre.cinematic",
        label: { en: "Cinematic", zh: "影视配乐" },
        text: {
          en: "Genre: cinematic scoring — evolving textures, theme statements at key moments, dynamics that follow a narrative arc.",
          zh: "流派：影视配乐——演进的织体、关键节点的主题陈述，力度跟随叙事弧线。",
        },
        recommends: ["inst.orchestra", "mood.epic", "perf.crescendo", "inst.piano-strings"],
      },
      {
        id: "genre.jazz",
        label: { en: "Jazz", zh: "爵士" },
        text: {
          en: "Genre: jazz — extended chords (7th/9th), swing feel, walking bass, conversational solo lines.",
          zh: "流派：爵士——七和弦/九和弦延伸、摇摆律动、行走低音、对话式独奏线条。",
        },
        recommends: ["inst.jazz-combo", "perf.syncopation", "perf.call-response", "mood.nostalgic"],
      },
      {
        id: "genre.electronic",
        label: { en: "Electronic", zh: "电子" },
        text: {
          en: "Genre: electronic — `synth_bass` foundation, `saw_lead` hooks, pad layers, four-on-the-floor or breakbeat `drums`.",
          zh: "流派：电子——`synth_bass` 根基、`saw_lead` 钩子、pad 层叠，四四踩点或碎拍 `drums`。",
        },
        recommends: ["inst.synth-ambient", "perf.ostinato", "mood.tense"],
      },
      {
        id: "genre.lofi",
        label: { en: "Lo-fi", zh: "Lo-fi" },
        text: {
          en: "Genre: lo-fi chill — laid-back tempo (70-85 BPM), dusty `epiano` chords, soft `drums`, warm mellow mix.",
          zh: "流派：Lo-fi 放松——慵懒速度（70-85 BPM）、带尘感的 `epiano` 和弦、轻软 `drums`、温暖柔和。",
        },
        recommends: ["inst.epiano-combo", "mood.nostalgic", "mood.calm"],
      },
      {
        id: "genre.rock",
        label: { en: "Rock", zh: "摇滚" },
        text: {
          en: "Genre: rock — riff-driven form, power-chord energy, verse/chorus dynamic contrast, live-band grit.",
          zh: "流派：摇滚——连复段驱动的曲式、强力和弦能量、主副歌力度对比、乐队现场质感。",
        },
        recommends: ["inst.rock-band", "perf.ostinato", "mood.tense"],
      },
      {
        id: "genre.folk",
        label: { en: "Folk", zh: "民谣" },
        text: {
          en: "Genre: folk — strummed or fingerpicked `guitar`, singable stepwise melody, simple honest harmony.",
          zh: "流派：民谣——扫弦或指弹 `guitar`、可歌唱的级进旋律、朴素真诚的和声。",
        },
        recommends: ["region.americana", "region.celtic", "mood.joyful", "mood.nostalgic"],
      },
      {
        id: "genre.ambient",
        label: { en: "Ambient", zh: "氛围" },
        text: {
          en: "Genre: ambient — beatless or near-beatless, slowly morphing pads, long reverb tails, texture over melody.",
          zh: "流派：氛围——无拍或近无拍，缓慢变形的 pad、绵长残响，织体重于旋律。",
        },
        recommends: ["inst.synth-ambient", "mood.calm", "mood.mysterious", "region.nordic"],
      },
      {
        id: "genre.chiptune",
        label: { en: "Chiptune", zh: "芯片音乐" },
        text: {
          en: "Genre: chiptune — 8-bit palette, fast arpeggio chords, catchy square-wave hooks, boss-battle energy.",
          zh: "流派：芯片音乐——8-bit 音色盘、快速琶音和弦、洗脑方波钩子、Boss 战能量。",
        },
        recommends: ["inst.chiptune-kit", "perf.arpeggio", "mood.joyful", "mood.tense"],
      },
      {
        id: "genre.ballad",
        label: { en: "Ballad", zh: "抒情歌谣" },
        text: {
          en: "Genre: ballad — slow expressive melody in the spotlight, supportive harmony, one emotional climax near the end.",
          zh: "流派：抒情歌谣——缓慢深情的旋律居于聚光灯下，和声托底，接近结尾处一个情感高潮。",
        },
        recommends: ["mood.sad", "inst.piano-strings", "inst.cello-piano", "perf.legato"],
      },
    ],
  },
];

const TAG_INDEX = new Map<string, AssistTag>(
  ASSIST_CATEGORIES.flatMap((category) => category.tags.map((tag) => [tag.id, tag])),
);

export function assistTag(id: string): AssistTag | undefined {
  return TAG_INDEX.get(id);
}

/** Union of `recommends` over the selected tags, minus the selection itself. */
export function recommendedFor(selected: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of selected) {
    for (const rec of TAG_INDEX.get(id)?.recommends ?? []) {
      if (!selected.has(rec) && TAG_INDEX.has(rec)) out.add(rec);
    }
  }
  return out;
}
