# eval-public —— 公开的判分器与判据说明

> **本目录是"评测怎么判"的公开部分；题面与期望值不在公开仓。**

## 为什么只公开判分器

评测题集（`tasks.txt` / `tasks.json`）与每题期望值留在**私有目录 `eval/`**，不进公开仓。
理由只有一个：**防止照题刷分**——题面一旦公开，"通过率"就不再衡量真实能力，只衡量是否背下了题。

公开判分器是为了让人能复核：**判定是怎么算的**（哪些检查、什么算失败、边界怎么取）。
这两件事不冲突：**逻辑公开，题目不公开**。

## 文件

| 文件 | 说明 |
|---|---|
| `scorer.mjs` | 公开版判分器。判定逻辑**逐字照抄**私有判分器，只把"期望来源 / runner 身份 / 题集哈希"改成命令行参数 |
| `example/expect.json` | 示例期望：**不含任何真实题面或期望值** |
| `example/artifact.json` | 示例产物：合成数据（`demo_*`），不是真实源 |

`scorer.mjs` 由 `scripts/build-eval-public.mjs` 从私有判分器生成（生成脚本不进公开仓）；
文件头记录了源文件 sha256，可用于核对"公开判分器与私有判分器是否同源"。

## 怎么跑

```bash
# 用自己的产物与期望跑（期望由你提供，本仓不提供真实题面）
node eval-public/scorer.mjs <产物.json> --expect <期望.json> \
  [--expect-sha <sha256>] [--tasks-sha <sha256>] [--runner-sha <sha256>]

# 跑本目录自带的合成示例（不涉及任何真实题目）
node eval-public/scorer.mjs eval-public/example/artifact.json \
  --expect eval-public/example/expect.json \
  --tasks-sha EXAMPLE-TASKS-SHA-NOT-REAL \
  --runner-sha EXAMPLE-RUNNER-SHA-NOT-REAL
```

退出码：逐题有 FAIL → `1`；缺 `--expect` 或期望文件不存在 → `2`；instrument 身份不符 → `4`；全通过 → `0`。

## 三条边界（务必读）

1. **公开判分器不是官方成绩单**。官方数字由私有冻结仪器产出（`eval/` 内的 runner + scorer + 冻结题集），
   公开版只用于复核判据逻辑。
2. **期望值由调用方提供**，所以 `--expect-sha` 不传时**不会校验期望哈希**（程序会明确打印这句提示）；
   要可复现，就传哈希。
3. **示例是合成数据**：`demo_seed_lookup` 等名字是编的，不对应任何真实源，也不代表任何真实评测结果。

## 与发布的关系

公开仓导出脚本把 `eval/` 排除、把本目录放行；`.gitignore` 里 `/eval/` 也已忽略。
两个目录名相邻（`eval/` 与 `eval-public/`），**最容易漏掉一层**——`test/publish-public.test.ts`
有一条专门断言：导出结果**含** `eval-public/scorer.mjs`、**不含** `eval/tasks.*`。
