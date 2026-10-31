#!/usr/bin/env node
/**
 * 市场卡片的**文案模板**：中英描述里的每个数字、每个物种都从注册表推出来，不手写。
 *
 * 为什么要有这个文件：`market/index.json` 里那句「7 个数据库、34 个工具」曾经过期很久，
 * 因为没人负责数它。现在数字由这里算，`check-index.mjs` 拿算出的文本与索引逐字比对，
 * 对不上就非零退出——过期数字再也过不了检查。
 *
 * 物种名是唯一需要人翻译的东西，用双向对账兜住：注册表里出现新品种而这里没文案 → 失败；
 * 这里有文案而注册表已经没有 → 也失败。故意不收录的物种写在 EXCLUDED_SPECIES 里并写明理由。
 */

/** 物种 → 中英常用名。键是注册表 `manifest.species` 的原文，不模糊匹配。 */
export const SPECIES_LABELS = {
  'Triticum aestivum': { zh: '小麦', en: 'wheat' },
  'Triticum turgidum': { zh: '硬粒小麦', en: 'durum wheat' },
  'Aegilops tauschii': { zh: '节节麦', en: 'Aegilops tauschii' },
  'Oryza sativa': { zh: '水稻', en: 'rice' },
  'Oryza sativa Indica Group': { zh: '籼稻', en: 'indica rice' },
  'Zea mays': { zh: '玉米', en: 'maize' },
  'Fragaria vesca': { zh: '野草莓', en: 'wild strawberry' },
  'Fragaria × ananassa': { zh: '栽培草莓', en: 'cultivated strawberry' },
  'Saccharum spontaneum': { zh: '割手密（甘蔗野生种）', en: 'wild sugarcane' },
  'Arabidopsis thaliana': { zh: '拟南芥', en: 'Arabidopsis' },
  'Taraxacum kok-saghyz': { zh: '橡胶蒲公英', en: 'rubber dandelion' },
};

/**
 * 有意不写进卡片的物种：卡片只放「这是覆盖哪些作物」，病原/模式真菌列进去会让读者误以为本插件查病原。
 * 键是注册表原文，值是排除理由（写清楚，别人才能复核这个决定）。
 */
export const EXCLUDED_SPECIES = {
  'Botrytis cinerea': '灰葡萄孢是草莓源收录的病原真菌，不是本插件查询的植物物种',
};

/** 卡片上的物种出现顺序：常见作物在前，越靠后越少见。 */
export const SPECIES_ORDER = [
  '小麦',
  '水稻',
  '玉米',
  '草莓',
  '甘蔗',
  '拟南芥',
  '橡胶蒲公英',
  '硬粒小麦',
  '节节麦',
  '籼稻',
  '野草莓',
  '栽培草莓',
  '割手密（甘蔗野生种）',
];

/** 同一个作物有多种拉丁名时，卡片上只出现作物名（例如小麦不再分「硬粒小麦」）。 */
const CROP_ALIASES = {
  硬粒小麦: '小麦',
  节节麦: '小麦',
  籼稻: '水稻',
  野草莓: '草莓',
  栽培草莓: '草莓',
  '割手密（甘蔗野生种）': '甘蔗',
};

const EN_CROP = {
  小麦: 'wheat',
  水稻: 'rice',
  玉米: 'maize',
  草莓: 'strawberry',
  甘蔗: 'sugarcane',
  拟南芥: 'Arabidopsis',
  橡胶蒲公英: 'rubber dandelion',
};

/** 卡片最多点名几个作物，其余用「等 / and more」。 */
const MAX_NAMED_CROPS = 5;

export function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/**
 * 卡片文案只描述**这份名单里有的**物种；`SPECIES_LABELS` 覆盖的是全仓物种表，
 * 所以这里只查「名单里有、却没写过文案」这一侧。反过来的「写了文案但注册表没有」
 * 由 `auditSpeciesLabels()` 拿全量物种清单单独查——发布口径天然比源码口径少物种，
 * 用同一把尺子量两边会误报。
 *
 * @param {string[]} species 这份口径实际覆盖的物种（原文）
 * @returns {{zh: string, en: string, named: string[]}}
 */
export function cropsFromSpecies(species) {
  const unknown = species.filter((name) => !SPECIES_LABELS[name] && !EXCLUDED_SPECIES[name]);
  if (unknown.length > 0) {
    fail(
      `这份清单里有没写过文案的物种：${unknown.join(', ')}\n` +
        '  在 market/scripts/card-copy.mjs 的 SPECIES_LABELS 里补中英名，或在 EXCLUDED_SPECIES 里写明排除理由',
    );
  }

  const crops = new Set();
  for (const name of species) {
    const label = SPECIES_LABELS[name];
    if (!label) continue;
    crops.add(CROP_ALIASES[label.zh] ?? label.zh);
  }
  const named = SPECIES_ORDER.filter((crop) => crops.has(crop));
  const ordered = [...new Set(named)];

  const shown = ordered.slice(0, MAX_NAMED_CROPS);
  const shownEn = shown.map((crop) => EN_CROP[crop] ?? crop);
  const rest = ordered.length - shown.length;

  // 卡片一行话，点名最多 5 个作物，其余收进「等 / and more」，不逐个堆成一长串。
  return {
    named: ordered,
    zh: rest > 0 ? `${shown.join('、')}等` : shown.join('、'),
    en: rest > 0 ? `${shownEn.join(', ')} and more` : shownEn.join(', '),
  };
}

/**
 * 反向对账：全仓源码注册表里已经没有的物种，文案表里不该留着（否则卡片会宣称查得到实际没有的物种）。
 * @param {string[]} allSpecies 源码注册表所有源的物种并集
 */
export function auditSpeciesLabels(allSpecies) {
  const stale = Object.keys(SPECIES_LABELS).filter((name) => !allSpecies.includes(name));
  if (stale.length > 0) {
    fail(
      `SPECIES_LABELS 里有源码注册表已不存在的物种：${stale.join(', ')}\n` +
        '  删掉这些条目，否则卡片会宣称查得到实际没有的物种',
    );
  }
  const unmapped = allSpecies.filter((name) => !SPECIES_LABELS[name] && !EXCLUDED_SPECIES[name]);
  if (unmapped.length > 0) {
    fail(`源码注册表里有没写过文案的物种：${unmapped.join(', ')}（SPECIES_LABELS 或 EXCLUDED_SPECIES 补一条）`);
  }
}

/**
 * 卡片描述模板：数字短语由 `scripts/counts.mjs` 的 `renderDescriptionClause()` 渲染（唯一实现），
 * 这里只接上「覆盖哪些作物」与统一的后半句。
 * @param {{clause: {zh: string, en: string}, crops: {zh: string, en: string}}} input
 */
export function renderCardDescription({ clause, crops }) {
  return {
    en: `${clause.en}, covering ${crops.en}. Thin plugin plus a remote MCP service; every output carries full provenance.`,
    zh: `${clause.zh}，覆盖${crops.zh}。薄插件 + 远程 MCP 服务，输出带完整出处尾注。`,
  };
}
