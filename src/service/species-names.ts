/**
 * 物种中文名映射（拉丁名 → 中文常用名）——**只有一份**（契约 v1.2 §三.1 规则 3）。
 *
 * 为什么不让每个 manifest 再写一份中文：拉丁名是**科学标识**（检索层与
 * `speciesKnownInCatalog` 都靠它判断覆盖），中文名只是**呈现层翻译**。
 * 两者挤进同一字段会让检索层拿到中文、判断失准。
 *
 * 缺映射时 `createRegistry()` 直接拒绝启动——不许默默回落拉丁名，否则页面会中英混排，
 * 用户看不出哪个是物种名。
 */
export const SPECIES_NAMES_ZH: Readonly<Record<string, string>> = {
  'Triticum aestivum': '小麦',
  'Triticum turgidum': '硬粒小麦',
  'Aegilops tauschii': '节节麦',
  'Oryza sativa': '水稻',
  'Oryza sativa Indica Group': '籼稻',
  'Oryza sativa Japonica Group': '粳稻',
  'Arabidopsis thaliana': '拟南芥',
  'Zea mays': '玉米',
  'Saccharum spontaneum': '甘蔗',
  'Fragaria vesca': '野草莓',
  'Fragaria × ananassa': '栽培草莓',
  'Botrytis cinerea': '灰葡萄孢',
  'Taraxacum kok-saghyz': '橡胶草',
};

/** 取中文名；没有映射就抛（调用方是启动门禁，宁可起不来也不许混排）。 */
export function speciesNameZh(latin: string): string {
  const name = SPECIES_NAMES_ZH[latin];
  if (!name) {
    throw new Error(
      `物种「${latin}」没有中文映射：在 src/service/species-names.ts 的 SPECIES_NAMES_ZH 里补一条。`
        + '不许默默回落拉丁名——页面会中英混排，用户看不出哪个是物种名。',
    );
  }
  return name;
}
