#!/usr/bin/env node
// 快闸门的**跑手**：零依赖，几十秒出结果。
//
// ============================================================================
// **这个文件为什么只剩不到 3KB。**
//
// 它曾经是 72190 字节，59 条断言全写在里面。而我的写入通道只能**整文件替换**，
// 2026-08-16 同一个瓶颈一天内咬了三次：
//   1. 备份仓那边，一次「只想补个括号」把四个集合清成了空数组,而四个里只有
//      两个被断言抓到。
//   2. 这边，一条正则里的 `\\.` 写成了模板字符串里的单反斜杠，字面变成
//      `emails*!=s*`。**产品没问题，说谎的是尺子。**
//   3. 紧接着修那一行时，文件直接被写截断（62568 -> 47435），后半段消失。
//
// 三次之后再试第四次不是谨慎，是侥幸。所以拆了 —— 和备份仓拆 manifest、
// 拆它自己那份 verify.mjs 用的是同一套做法，而那套做法已经在那边验绿过。
//
// **拆的规矩（一万字节买来的教训）：只搬不改。** 标题逐字不变、判据逐字不变，
// 判据是 `scripts/manifest.json` 里那个 `fast: 59` 一字不改。
//
// **真正买到的东西**：从现在起，改一条判词只需要重写一个 10KB 上下的文件。
// 整份的字节数没少多少，少的是「一次必须写出多少」。
// ============================================================================
//
// 每一条断言都问过同一个问题：如果这个功能完全没实现，这条会不会失败？
// 不会失败的就是空断言，不许留。
//
// 第二个自问同样重要：**我在乎的属性里，有哪一个完全没有断言在看？**
// 覆盖缺口和空断言在报告上长得一模一样 —— 都是全绿。
//
// 第三个：**「测不出来的」那一节里每一条，我真的试过吗？** 手法是造变异体。
// 第四个（最便宜也最狠）：**把这条断言要守的东西故意改坏一次，它会红吗？**
import { ARTIFACTS, MANIFEST, expectEq } from './lib/verify-kit.mjs';
import { Report } from './lib/report.mjs';
import { STORE_CHECKS } from './lib/checks-store.mjs';
import { HISTORY_CHECKS } from './lib/checks-history.mjs';
import { STATIC_CHECKS } from './lib/checks-static.mjs';
import { CI_VERIFY_CHECKS } from './lib/checks-ci-verify.mjs';
import { CI_OTHER_CHECKS } from './lib/checks-ci-other.mjs';
import { makeSecretChecks } from './lib/checks-secrets.mjs';

const report = new Report('快闸门（纯核心 + 静态断言）');

// 清单拼接。**顺序与拆分前逐条一致** —— 排序变了不会让任何断言红，
// 但它会让报告跟历史对不上，而那是下一个人读报告时唯一的参系。
const CHECKS = [
  ...STORE_CHECKS,
  ...HISTORY_CHECKS,
  ...STATIC_CHECKS,
  ...CI_VERIFY_CHECKS,
  ...CI_OTHER_CHECKS,
  ...makeSecretChecks(report),

  // 自检必须住在跑手里：它读的是 `report` 与 `CHECKS` 本身。
  // **而它正是这次拆分的完成判据** —— 漏搬一条、多搬一条，那条等号当场红。
  ['自检：标题唯一 + 实际检查数等于清单数', () => {
    const titles = report.checks.map(c => c.title);
    const dup = titles.filter((t, i) => titles.indexOf(t) !== i);
    expectEq(dup, [], '重复的检查标题');
    const actual = report.checks.length + 1;
    expectEq(actual, CHECKS.length, '本次实际执行的检查数');
    expectEq(CHECKS.length, MANIFEST.fast, 'scripts/manifest.json 里登记的条数');
    return `${actual} 条检查全部执行，等号断言（不是下限，下限会自己漂）`;
  }]
];

for (const [title, fn] of CHECKS) report.check(title, fn);

report.save(ARTIFACTS, 'fast');
process.stdout.write(`\n共执行 ${report.total} 条检查，通过 ${report.passed}，失败 ${report.failed}\n`);
process.exit(report.ok ? 0 : 1);
