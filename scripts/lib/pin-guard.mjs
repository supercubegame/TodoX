// 回写引用（`uses: .../report.yml@<ref>`）的**判词**，唯一一份实现，连自证一起。
//
// ============================================================================
// **为什么要抽出来，而不是就地改 verify.mjs 里那四行。**
//
// 要把回写从钉 SHA 改成跟随 `@main`，必须改判词。而 `scripts/verify.mjs` 是
// **72190 字节**，而我的写入通道只能整文件替换。同一个动作 2026-08-16 在
// clickup-brain-backup 那边刚出过事：我只想补一个括号，结果顺手把四个集合
// 清成了空数组，而四个里只有两个被断言抓到。
//
// 所以顺序是硬的：**先拆，再翻。** 反过来做，得到的是一个当天修不动的红灯。
//
// **而抽的时候只拿走判词，不拿走解析器。** jobBlocks / needsOf / stripYamlComments
// 那套东西留在调用方，由它把已经切好的 `summary` job 文本传过来。理由：
// 这个仓库里 `scripts/lib/report.mjs` 已经在两个仓库各有一份并且真的分叉了
// （一份多了个 checkAsync），而没有任何断言看得见。promote-guard.mjs 的文件头
// 就为这件事写着一段。**同一个形状不许在同一个仓库里再长一次。**
// ============================================================================

// 四份 workflow 应当跟的那个引用。**它是一个常量，不是一个参数默认值** ——
// 让调用方传一个「期望」进来，那就变成两处各自漂的字面量。
export const EXPECTED_REF = 'main';

export const RE_WRITEBACK = /uses:\s*supercubegame\/ci-workflows\/\.github\/workflows\/report\.yml@([^\s]+)/g;

// 40 位十六进制。**这个正则以前是「必须匹配」，现在是「不许匹配」** ——
// 同一条双向断言掉了个头，而不是被删掉。以前防的是「有人改成浮动引用」，
// 现在防的是「有人偷偷把某一处钉回去」—— 而后者正是上游担心的那个形状：
// A 仓停在旧 SHA、B 仓在新的，两边都绿而行为已经不同。
export const RE_SHA40 = /^[0-9a-f]{40}$/;

// ============================================================================
// entries: [{ path, summaryText, hasLocalSteps }]
//
// 四件事，和旧判词一一对应（**换掉，不是删掉**）：
//   1. 每份 workflow 恰好引用共享回写一次。
//   2. 那个引用必须恰好是 `main`，**而且不许是 40 位 SHA**。
//      两句都要写：只写后半句，改成 `v1` 这种浮动 tag 会悄悄通过。
//   3. 四份跟的引用集合大小恰好为 1。**这一条一字未改** —— 它防的从来不是
//      「钉没钉」，而是「只改了一半」。
//   4. summary 自己不许长出 steps。
// ============================================================================
export function writebackRefProblems(entries, expectedRef = EXPECTED_REF) {
  const out = [];
  const refs = new Set();

  if (!Array.isArray(entries) || entries.length === 0) {
    out.push('一份 workflow 都没传进来 —— 那这条断言是空的（空集合永远自洽）');
    return { problems: out, refs };
  }

  for (const e of entries) {
    const found = [...String(e.summaryText || '').matchAll(RE_WRITEBACK)].map(m => m[1]);
    if (found.length !== 1) {
      out.push(`${e.path} 引用共享回写 workflow 的次数是 ${found.length}，应该恰好 1 次`);
      continue;
    }
    const ref = found[0];
    refs.add(ref);

    if (RE_SHA40.test(ref)) {
      out.push(`${e.path} 把回写钉在 ${ref.slice(0, 7)} 这个 40 位 SHA 上 —— ` +
        `策略已经改成跟随上游 ${expectedRef}。钉回去会让多个消费者停在不同的版本上，` +
        `而那时两边都绿、行为已经不同`);
    } else if (ref !== expectedRef) {
      out.push(`${e.path} 把回写跟在 ${ref} 上，应当恰好是 ${expectedRef}`);
    }

    if (e.hasLocalSteps) out.push(`${e.path} 的 summary 自己长出了 steps`);
  }

  if (refs.size !== 1) {
    out.push(`四份 workflow 跟的引用有 ${refs.size} 个（${[...refs].join(' / ')}），应当恰好 1 个 —— ` +
      `只改了一半比全部没改更坏：那时四条流水线的回写行为不一致，而它们全是绿的`);
  }

  return { problems: out, refs };
}

// ============================================================================
// 自证。**变异体不靠字串替换构造，直接造 entries** —— promote-guard 那边
// 2026-08-14 那条红就是 `String.replace` 只换第一个弄出来的，而沙箱里用 Python
// 重写一遍验过「它判红了」（Python 的 str.replace 默认换全部）。
// **用一种语言的语义去验另一种语言的代码，等于没验。** 这里干脆不给它
// 那个机会。
//
// 样本数是**等号**，而且只许从跑出来的输出里抄。
// ============================================================================
export const SAMPLE_COUNT = 9;

const SHA = 'f0fccd3ff41e6864088bd26d90a163e662982c83';

function entry(path, ref, hasLocalSteps = false) {
  return {
    path,
    summaryText: `    uses: supercubegame/ci-workflows/.github/workflows/report.yml@${ref}\n`,
    hasLocalSteps
  };
}

function four(ref) {
  return ['verify.yml', 'release.yml', 'screenshots.yml', 'mirror.yml'].map(p => entry(p, ref));
}

export function pinGuardSelfProof() {
  const out = [];
  const one = (name, problems, want) => out.push({
    ok: want === 0 ? problems.length === 0 : problems.length >= 1,
    name,
    detail: problems.length > 0 ? JSON.stringify(problems) : ''
  });

  // 1 真货对照。没有它，下面每一条红都可能只是夹具自己坏了。
  one('真货：四份都跟 @main -> 不抓', writebackRefProblems(four('main')).problems, 0);

  // 2 旧世界：四份都钉着同一个 SHA。**这正是迁移前仓库里的真实状态**，
  //   而新判词必须对它判红 —— 否则这条断言没换成任何东西。
  one('四份都还钉着旧 SHA -> 抓到（这是迁移前的真实状态）',
    writebackRefProblems(four(SHA)).problems, 1);

  // 3 只改了一半。**比全部没改更坏，而且正是上游那段话担心的形状。**
  one('只翻了两份（两个 main + 两个 SHA）-> 抓到',
    writebackRefProblems([...four('main').slice(0, 2), ...four(SHA).slice(2)]).problems, 1);

  // 4 浮动 tag 不算数。只写「不许是 SHA」会把它放过去。
  one('改成 v1 这类浮动 tag -> 抓到（只写「不许是 SHA」会放它过去）',
    writebackRefProblems(four('v1')).problems, 1);

  // 5 引用没了。
  one('某一份压根不引用共享回写 -> 抓到',
    writebackRefProblems([...four('main').slice(0, 3), { path: 'mirror.yml', summaryText: '    runs-on: ubuntu-24.04\n' }]).problems, 1);

  // 6 引用两次。
  one('某一份引用两次 -> 抓到', writebackRefProblems([
    ...four('main').slice(0, 3),
    { path: 'mirror.yml', summaryText: entry('x', 'main').summaryText + entry('x', 'main').summaryText }
  ]).problems, 1);

  // 7 summary 自己长出 steps。
  one('summary 长出了本地 steps -> 抓到', writebackRefProblems([
    ...four('main').slice(0, 3), entry('mirror.yml', 'main', true)
  ]).problems, 1);

  // 8 空输入。**这一条守的是这条断言自己**：调用方一份都没传进来时，
  //   一个只会遍历的检查器会安静地全绿（空集合永远自洽）。
  one('一份都没传进来 -> 抓到（否则空集合会让这条断言变成装饰）',
    writebackRefProblems([]).problems, 1);

  // 9 样本数自己。等号，不是下限。
  out.push({
    ok: out.length + 1 === SAMPLE_COUNT,
    name: `样本数等于登记的 ${SAMPLE_COUNT}（等号断言，这个数只许从输出里抄）`,
    detail: `本次生成 ${out.length + 1} 个`
  });

  return out;
}
