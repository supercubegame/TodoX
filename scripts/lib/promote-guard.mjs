// 「镜像转正那一步真的会返回退出码吗」的**唯一一份实现**。
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
  const wf = stripYamlComments(rawWf);
  const blocks = runBlocks(wf).filter(b => b.body.includes(PROMOTE_MARK));
  if (blocks.length !== 1) {
    out.push(`把镜像转正（${PROMOTE_MARK}）的 run 块有 ${blocks.length} 个，应当恰好 1 个`);
    return out;
  }
  const body = blocks[0].body;
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

// 变异体也放在这里，两个调用方共用。**变异体按行号定位，不用字符串替换** ——
// `            exit 1` 这一行在 release.yml 里出现两次（令牌守卫里也有一个
// 同缩进的，而且在前面），而 JS 的 String.replace 传字符串时只替换第一个。
// 第一版就是这么写的：结果「变异体」改到了令牌守卫上，要测的那一块压根没动，
// 守卫返回空，而我差点以为是守卫失灵。**构造变异体时，说谎的往往是夹具。**
//
// 返回 { name, text, oldWouldPass, changedLines } 的数组。oldWouldPass 是
// 「在『全文找 exit 1』那种旧写法下会不会被放过」—— 把**为什么必须块内**也
// 钉进断言，否则半年后有人图省事又改回全文搜索。null 表示这一条不适用。
export function promotionMutants(rawWf) {
  const lines = rawWf.split('\n');
  const from = lines.findIndex(l => l.trim() === 'ok=0');
  const to = lines.findIndex(l => l.trim().startsWith("echo '终态已断言"));
  const exitAt = lines.findIndex((l, i) => i > from && i < to && l.trim() === 'exit 1');
  if (from < 0 || to <= from || exitAt < 0) {
    return { located: false, from, to, exitAt, mutants: [] };
  }
  const mutA = lines.slice();
  mutA[exitAt] = ' '.repeat(12) + "echo '读回来不对，但我不失败'";
  const mutB = lines.slice(0, from)
    .concat(lines.slice(from, to + 1).map(l => `          # ${l.trim()}`))
    .concat(lines.slice(to + 1));
  return {
    located: true,
    from,
    to,
    exitAt,
    mutants: [
      // A 是「静默跳过」的经典长相：读回来了，判断也在，就是不失败。
      { name: 'A 块内 exit 1 换成 echo（静默跳过的经典长相）', text: mutA.join('\n'), oldWouldPass: true, changedLines: 1 },
      { name: 'B 整段读回搬进注释（转正照做）', text: mutB.join('\n'), oldWouldPass: true, changedLines: null },
      // C 测的是另一件事（两处资产数各自漂开）。旧写法压根没有这一条，
      // 所以 oldWouldPass 是 null = 不适用。**硬填一个值会让那句自证变成在比
      // 一件没意义的事** —— 沙箱里第一版填了 false 而实际是 true。
      { name: 'C 资产数悄悄改成 7', text: rawWf.replace('"$n" -eq 8', '"$n" -eq 7'), oldWouldPass: null, changedLines: null }
    ]
  };
}
