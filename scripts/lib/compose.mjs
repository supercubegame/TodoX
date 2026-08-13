// 把每条闸门的报告合成一条回写到 GitHub 的评论。验证流水线和发布流水线
// 共用这一份 —— 复制一份出去是「各自长歪」的标准起手式：两边都绿而结构
// 已经分叉，而且没有任何一条断言看得见。
//
// 报告缺失一律算失败：在写出报告之前就崩掉的 job 永远不能看起来像通过 ——
// 一个会静默失效的监控比没有监控更糟。
//
// 而且报告缺失也必须带证据：「没有产出报告」只说明监控坏了，不说明为什么，而
// CI 日志从评论里是打不开的。每条闸门都把 stdout tee 成
// test/artifacts/stdout-<slug>.log 就是为了这一刻。
import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdown } from './report.mjs';

const LOG_TAIL_LINES = 80;

function findFile(dir, name) {
  const hits = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === name) hits.push(p);
    }
  };
  walk(dir);
  return hits[0] || null;
}

function tail(text, lines = LOG_TAIL_LINES) {
  const all = String(text || '').replace(/\s+$/, '').split('\n');
  return all.slice(-lines).join('\n');
}

function missingSection(dir, gate) {
  const logFile = findFile(dir, `stdout-${gate.slug}.log`);
  const log = logFile ? tail(fs.readFileSync(logFile, 'utf8')) : '';
  const evidence = log
    ? `<details><summary>该闸门自己输出的最后 ${log.split('\n').length} 行</summary>\n\n\`\`\`\n${log.slice(-8000)}\n\`\`\`\n\n</details>`
    : '连 stdout 日志都没有，说明这次在闸门产出任何东西之前就断了 —— 去看 workflow，不是看闸门。';
  return [
    `### ❌ ${gate.label} — 没有产出报告`,
    '',
    '闸门在写出报告之前就崩了，或者产物根本没上传。这里**故意**算作失败。',
    '',
    evidence,
    ''
  ].join('\n');
}

// 契约：`node <entry> reports` 写出 comment.md；加 --check 时不写文件，
// 只用退出码表示成败。
export function runCompose(title, gates, argv) {
  const dir = argv.find(a => !a.startsWith('--')) || 'reports';
  const checkOnly = argv.includes('--check');

  let failed = false;
  let passedCount = 0;
  let totalCount = 0;
  const sections = [];

  for (const gate of gates) {
    const file = findFile(dir, `report-${gate.slug}.json`);
    if (!file) {
      failed = true;
      sections.push(missingSection(dir, gate));
      continue;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data.ok) failed = true;
    passedCount += data.passed;
    totalCount += data.total;
    sections.push(renderMarkdown(data));
  }

  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const repo = process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.GITHUB_RUN_ID || '';
  const sha = (process.env.GITHUB_SHA || 'local').slice(0, 7);
  const runLink = runId ? ` · [完整日志](${server}/${repo}/actions/runs/${runId})` : '';
  const header = `${failed ? `❌ **${title}失败**` : `✅ **${title}通过**`} — ${passedCount}/${totalCount} 项检查通过 · 提交 \`${sha}\`${runLink}`;
  const body = [header, '', ...sections].join('\n');

  if (checkOnly) {
    process.stdout.write(`${failed ? 'FAILED' : 'PASSED'}: ${passedCount}/${totalCount} 项检查\n`);
    process.exit(failed ? 1 : 0);
  }

  fs.writeFileSync('comment.md', body.slice(0, 60000));
  process.stdout.write(body + '\n');
}
