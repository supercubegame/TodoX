// 所有闸门共用的报告构造器。
//
// 铁律：失败的检查必须自带足以定位根因的证据 —— 期望值与实际值，或者子进程
// 输出的尾巴。只写「1 项失败」而没有细节，等于没有报告：读评论的人（和 agent）
// 打不开 CI 日志。
import fs from 'node:fs';
import path from 'node:path';

// 验证流水线（verify.yml）的闸门清单。composer 按它决定「该有哪几份报告」，
// 快闸门按它反查 workflow 里 tee 出来的 stdout-<slug>.log 和上传的
// report-<slug> 产物是否一一对应。两边引用同一个数组，所以「加了一条闸门但
// composer 不知道」不可能悄悄发生。
export const GATES = [
  { slug: 'fast', label: '快闸门（纯核心 + 静态断言）' },
  { slug: 'e2e', label: 'Electron 端到端闸门' },
  { slug: 'pack-linux', label: '打包闸门 · Linux' },
  { slug: 'pack-mac', label: '打包闸门 · macOS' },
  { slug: 'pack-win', label: '打包闸门 · Windows' }
];

// 发布流水线（release.yml）的闸门清单。同样被快闸门拿去和 release.yml 里的
// matrix、产物名、stdout 日志名对齐。
export const RELEASE_GATES = [
  { slug: 'dist-linux', label: '安装包闸门 · Linux' },
  { slug: 'dist-mac', label: '安装包闸门 · macOS' },
  { slug: 'dist-win', label: '安装包闸门 · Windows' },
  { slug: 'release-assets', label: '发布资产校验闸门' }
];

export class Report {
  constructor(name) {
    this.name = name;
    this.checks = [];
  }

  record(title, ok, detail, evidence, skipped = false) {
    const entry = {
      title,
      ok: Boolean(ok),
      skipped,
      detail: String(detail == null ? '' : detail),
      evidence: evidence == null ? null : String(evidence)
    };
    this.checks.push(entry);
    const icon = skipped ? 'SKIP' : (entry.ok ? 'PASS' : 'FAIL');
    process.stdout.write(`${icon}  ${title}\n      ${entry.detail.split('\n')[0]}\n`);
    if (!entry.ok && entry.evidence) {
      process.stdout.write(entry.evidence.split('\n').map(l => '      | ' + l).join('\n') + '\n');
    }
    return entry;
  }

  check(title, fn) {
    try {
      return this.record(title, true, fn());
    } catch (err) {
      return this.record(title, false, err && err.message ? err.message : String(err), err && err.evidence);
    }
  }

  async checkAsync(title, fn) {
    try {
      return this.record(title, true, await fn());
    } catch (err) {
      return this.record(title, false, err && err.message ? err.message : String(err), err && err.evidence);
    }
  }

  // 跳过算失败。给不出的结果不能读起来像干净的一遍。
  skip(title, reason) {
    return this.record(title, false, reason, null, true);
  }

  get total() { return this.checks.length; }
  get passed() { return this.checks.filter(c => c.ok).length; }
  get failed() { return this.checks.filter(c => !c.ok).length; }
  get ok() { return this.total > 0 && this.failed === 0; }

  toJSON() {
    return {
      name: this.name,
      total: this.total,
      passed: this.passed,
      failed: this.failed,
      ok: this.ok,
      generatedAt: new Date().toISOString(),
      checks: this.checks
    };
  }

  toMarkdown() { return renderMarkdown(this.toJSON()); }

  save(dir, slug) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `report-${slug}.json`), JSON.stringify(this.toJSON(), null, 2));
    fs.writeFileSync(path.join(dir, `report-${slug}.md`), this.toMarkdown());
  }
}

export function renderMarkdown(data) {
  const head = `### ${data.ok ? '✅' : '❌'} ${data.name} — ${data.passed}/${data.total} 项通过`;
  const rows = data.checks.map(c => `| ${c.skipped ? '⏭️' : (c.ok ? '✅' : '❌')} | ${cell(c.title)} | ${cell(oneLine(c.detail))} |`);
  const table = ['| | 检查 | 说明 |', '| --- | --- | --- |', ...rows].join('\n');
  const details = data.checks
    .filter(c => !c.ok && c.evidence)
    .map(c => `<details><summary>❌ ${cell(c.title)} — 证据</summary>\n\n\`\`\`\n${String(c.evidence).slice(-4000)}\n\`\`\`\n\n</details>`)
    .join('\n\n');
  return [head, '', table, '', details].join('\n').trim() + '\n';
}

function oneLine(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, 300); }
function cell(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|'); }
