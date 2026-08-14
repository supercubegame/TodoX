// 「镜像转正那一步真的会返回退出码吗」的**唯一一份实现**，连自证一起。
//
// 为什么要抽出来：它有两个调用方，而这两个调用方的触发时机完全不同 ——
//   - verify-release-mirror.mjs：只在发版时跑。**它能拦住发布**（这条红 ->
//     转正那一步的 if 不成立 -> 压根不会转正），这是它最值钱的地方。
//   - verify-mirror.mjs：每次推 main 都跑。发版可能几周一次，中间那几周
//     没有任何东西看着这段守卫,而「几周之后才发现它被删了」和「没有守卫」
//     差别不大。
//
// 两个都要，但**绝不能各写一份。** 这个项目里 scripts/lib/report.mjs 已经
// 在两个仓库各有一份并且真的分叉了（一份多了 checkAsync），而没有任何断言
// 看得见。同一个形状不许在同一个仓库里再长一次。
//
// **连自证的循环也放在这里（promotionSelfProofProblems）。** 第一版只把
// 检查器抽了出来，那三个变异体的循环在两个调用方各抄了一份 —— 于是修一处
// 就得记得修另一处，而那正是这个文件存在要防的事。

// 只剥**整行**注释。行内 # 一概不动 —— YAML 里 # 可以合法出现在字符串中间，
// 一个半懂的剥离器比它守的东西更容易错，而且错法是给出一条没人看得懂的红。
// 实际观察到的失效模式全是整行注释（这个仓库一天里抓到过四条）。
export function stripYamlComments(text) {
  return text.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
}

export function runBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*\|\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { body.push(l); continue; }
      const ind = l.length - l.replace(/^\s+/, '').length;
      if (ind <= indent) break;
      body.push(l);
    }
    blocks.push({ line: i + 1, body: body.join('\n') });
  }
  return blocks;
}

export const PROMOTE_MARK = '--draft=false';

// 转正那一块的**块体**。返回 null 表示找不到、或者找到不止一个。
// 抽成函数是因为自证那边要用它做「变异体到底改到哪一块」的判断。
export function promoteBlockBody(rawWf) {
  const blocks = runBlocks(stripYamlComments(rawWf)).filter(b => b.body.includes(PROMOTE_MARK));
  return blocks.length === 1 ? blocks[0].body : null;
}

// ============================================================================
// 守的是什么：公开仓那个 Release 被转正之后，有没有人**读回来断言**它真的
// 对外可见了。
//
// 这个洞的来历值得记：镜像闸门有一条断言「审计时它必须还是草稿」（顺序是对的，
// 建草稿 -> 上传 -> 审计 -> 通过了才转正）。但那条断言的副作用是**镜像闸门这辈子**
// **都跑在转正之前**，所以「已经对外可见」那个终态它断言不了。而转正那一步原来
// 的最后一行是 `gh release view ... --json tagName,isDraft,isLatest,url`——
// **打印了，没人解析。日志里有答案不算断言。**
//
// **必须块内检查。** 全文找 `exit 1` 会被文件末尾那个无关的
// 「闸门失败则失败 -> run: exit 1」骗过去。这个仓库为完全一样的形状红过一次
// （镜像令牌守卫：两个独立子串搜索，而 exit 1 来自别处）。
//
// 四件事：
//   1. 全仓恰好一个 run 块在做转正（两个就意味着有一条路绕过了断言）。
//   2. 那一块里读回了 isDraft / isLatest / 资产数。
//   3. 那一块里有 exit 1 —— 读回来却不会失败，那就只是打印。
//   4. 那一块里对资产数的等号比较，数值等于传进来的 expectTotal。
//      第 4 条顺手消掉一处硬编码耦合：不然那个 `-eq 8` 就是又一个会各自漂的 8。
// ============================================================================
export function promotionGuardProblems(rawWf, expectTotal) {
  const out = [];
  const body = promoteBlockBody(rawWf);
  if (body === null) {
    const n = runBlocks(stripYamlComments(rawWf)).filter(b => b.body.includes(PROMOTE_MARK)).length;
    out.push(`把镜像转正（${PROMOTE_MARK}）的 run 块有 ${n} 个，应当恰好 1 个`);
    return out;
  }
  for (const [label, re] of [['isDraft', /isDraft/], ['isLatest', /isLatest/], ['资产数（assets）', /assets/]]) {
    if (!re.test(body)) out.push(`转正那一块里没有读回 ${label} —— 那个终态就没人核对`);
  }
  if (!/(^|\s)exit 1(\s|$)/.test(body)) {
    out.push('转正那一块里没有 exit 1 —— 读回来了却不会失败，那就只是打印，而日志里有答案不算断言');
  }
  const m = /-eq\s+([0-9]+)/.exec(body);
  if (!m) out.push('转正那一块里没有对资产数做等号比较');
  else if (Number(m[1]) !== expectTotal) {
    out.push(`转正那一块要求 ${m[1]} 个资产，与期望的 ${expectTotal} 不符 —— 两处各自漂了`);
  }
  return out;
}

// ============================================================================
// 变异体。**全部按行号定位，一个 String.replace 都不用。**
//
// 这条规矩是被一次真实的红换来的（2026-08-14）。原来的变异体 C 写的是
// `rawWf.replace('"$n" -eq 8', '"$n" -eq 7')`,而那个字面量在 release.yml 里
// **出现三次**：发布前清点资产（publish job）、同步到公开仓建草稿那步、
// 以及转正那一块。**JS 的 String.prototype.replace 传字符串时只替换第一个**，
// 所以它改的是 publish job,转正那一块一个字没动，守卫当然返回空，
// 于是 `expectTrue(got.length >= 1)` 判红。闸门在 main 上第一次跑就红了。
//
// 更值得记的是**我为什么之前以为它是对的**：那个变异体在沙箱里量过，结果是
// 「判红」。但沙箱里没有 node（早就实测确认过），所以那次是用 **Python** 写的,
// 而 **Python 的 str.replace 默认替换全部**。同一行代码，两种语言两种语义：
// Python 那边连转正块里的 8 也一起改了，所以它真的判红。
//
//   **用一种语言的语义去验另一种语言的代码，等于没验。**
//   而它给出的是「验过了」的假象 —— 比没验更糟。
//
// 修法不是「记得 JS 只换第一个」，是**让这件事不再依赖 replace 的语义**：
// 所有变异体按行号改，并且额外断言**改动落在转正那一块里面**（见
// promotionSelfProofProblems 里那条 blockChanged）。文件变了不算，
// 要那一块自己变了才算 —— 又是「先把那段切出来」的同一条规矩。
// ============================================================================
export function promotionMutants(rawWf) {
  const lines = rawWf.split('\n');
  const from = lines.findIndex(l => l.trim() === 'ok=0');
  const to = lines.findIndex(l => l.trim().startsWith("echo '终态已断言"));
  const exitAt = lines.findIndex((l, i) => i > from && i < to && l.trim() === 'exit 1');
  const eqAt = lines.findIndex((l, i) => i > from && i < to && /-eq\s+[0-9]+/.test(l));
  if (from < 0 || to <= from || exitAt < 0 || eqAt < 0) {
    return { located: false, from, to, exitAt, eqAt, mutants: [] };
  }

  // A：块内那个 exit 1 换成 echo。**这是「静默跳过」的经典长相。**
  const mutA = lines.slice();
  mutA[exitAt] = ' '.repeat(12) + "echo '读回来不对，但我不失败'";

  // B：整段读回搬进注释，转正本身照做。
  const mutB = lines.slice(0, from)
    .concat(lines.slice(from, to + 1).map(l => `          # ${l.trim()}`))
    .concat(lines.slice(to + 1));

  // C：资产数悄悄改小一个。**按行号改那一行**，不做全文替换。
  const mutC = lines.slice();
  mutC[eqAt] = lines[eqAt].replace(/(-eq\s+)([0-9]+)/, (_, p, d) => `${p}${Number(d) - 1}`);

  return {
    located: true,
    from,
    to,
    exitAt,
    eqAt,
    mutants: [
      { name: 'A 块内 exit 1 换成 echo（静默跳过的经典长相）', text: mutA.join('\n'), oldWouldPass: true },
      { name: 'B 整段读回搬进注释（转正照做）', text: mutB.join('\n'), oldWouldPass: true },
      // C 测的是另一件事（两处资产数各自漂开）。「全文找 exit 1」那种旧写法
      // 压根没有这一条，所以 oldWouldPass 是 null = 不适用。**硬填一个值会让
      // 那句自证变成在比一件没意义的事。**
      { name: 'C 资产数悄悄改小一个', text: mutC.join('\n'), oldWouldPass: null }
    ]
  };
}

// 三个变异体的自证，**也只有一份实现**。第一版把这段循环在两个调用方各抄了
// 一遍,而它自己讲的就是「同一个形状别抄两遍」。
//
// 每个变异体要过四道：
//   1. 真的改动了文件（没匹配上会得到一份和原文相同的「变异体」,它当然活下来，
//      而你会以为断言是装饰。那时说谎的是夹具）。
//   2. **改动落在转正那一块里面** —— 这一条是 2026-08-14 那次红换来的：
//      变异体改到了 publish job，文件确实变了，而要测的那块一个字没动。
//   3. 转正本身还在做（把 --draft=false 也删了就不是这条断言要抓的坏）。
//   4. 守卫必须抓到它。
// 外加：oldWouldPass 不为 null 时，核对「全文找 exit 1」那种旧写法的结果 ——
// 把**为什么必须块内**也钉进断言，否则半年后有人图省事又改回全文搜索。
export function promotionSelfProofProblems(rawWf, expectTotal) {
  const out = [];
  const m = promotionMutants(rawWf);
  if (!m.located) {
    out.push(`在 release.yml 里定位不到读回来那一段（ok=0 第 ${m.from + 1} 行、收尾 echo 第 ${m.to + 1} 行、` +
      `块内 exit 1 第 ${m.exitAt + 1} 行、资产数比较第 ${m.eqAt + 1} 行）—— 变异体造不出来，这条自证就是空的`);
    return { problems: out, oldBlind: [], mutants: [] };
  }
  const baseLines = rawWf.split('\n');
  const baseBlock = promoteBlockBody(rawWf);
  if (baseBlock === null) {
    out.push('原文里找不到唯一的转正块 —— 自证无从谈起，先看守卫那条');
    return { problems: out, oldBlind: [], mutants: m.mutants };
  }
  const oldBlind = [];
  for (const mut of m.mutants) {
    if (mut.text === rawWf) { out.push(`变异体「${mut.name}」没有真的改动文件 —— 那它证明不了任何事`); continue; }
    if (!mut.text.includes(PROMOTE_MARK)) { out.push(`变异体「${mut.name}」把转正本身也删了 —— 那不是这条断言要抓的坏`); continue; }
    // **块级那一条。** 文件变了不算，要转正那一块自己变了才算。
    const mutBlock = promoteBlockBody(mut.text);
    if (mutBlock === baseBlock) {
      const changed = mut.text.split('\n').filter((l, i) => l !== baseLines[i]).length;
      out.push(`变异体「${mut.name}」改动了 ${changed} 行，但**转正那一块一个字没变** —— ` +
        `它改到别的地方去了（2026-08-14 真的发生过：那行字面量在文件里出现三次，JS 的 replace 只换第一个）`);
      continue;
    }
    const got = promotionGuardProblems(mut.text, expectTotal);
    if (got.length === 0) out.push(`变异体「${mut.name}」没被守卫抓到`);
    if (mut.oldWouldPass !== null) {
      const oldPasses = /(^|\s)exit 1(\s|$)/.test(mut.text);
      if (oldPasses !== mut.oldWouldPass) {
        out.push(`变异体「${mut.name}」在「全文找 exit 1」那种写法下的结果是 ${oldPasses}，期望 ${mut.oldWouldPass}`);
      }
      if (oldPasses) oldBlind.push(mut.name);
    }
  }
  // A 只许动一行，而且令牌守卫那个 exit 1 必须还在 —— 否则「按行号定位」
  // 那个教训就只是注释，没有断言在守。
  const aChanged = m.mutants[0].text.split('\n').filter((l, i) => l !== baseLines[i]).length;
  if (aChanged !== 1) out.push(`变异体 A 改动了 ${aChanged} 行，应当恰好 1 行`);
  if (!m.mutants[0].text.includes('未配置 MIRROR_TOKEN')) out.push('变异体 A 动到了令牌守卫那一段');
  return { problems: out, oldBlind, mutants: m.mutants, exitAt: m.exitAt, eqAt: m.eqAt };
}
