// 密钥扫描，2 条。**标题与判据逐字未改。**
//
// 写成工厂函数是因为第一条要读 `report` 本体 —— 哨兵不仅不许出现在源码里，
// 也不许泄进那份会被原样贴到 PR 评论里的报告 JSON。
import { ROOT, SENTINEL, walk, isTextFile, expectEq, expectTrue } from './verify-kit.mjs';
import fs from 'node:fs';
import path from 'node:path';

export function makeSecretChecks(report) {
  return [
    ['密钥：哨兵在源码与报告里出现 0 次（负向）', () => {
      const files = walk(ROOT).filter(isTextFile);
      const hits = files.filter(f => {
        try { return fs.readFileSync(f, 'utf8').includes(SENTINEL); } catch { return false; }
      }).map(f => path.relative(ROOT, f));
      expectEq(hits, [], '哨兵泄漏的文件');
      const inReport = JSON.stringify(report.toJSON()).includes(SENTINEL);
      expectTrue(!inReport, '哨兵密钥泄漏进了报告本体', '报告会被原样贴到 PR 评论里');
      return `哨兵（每次运行随机生成）在 ${files.length} 个文本文件与报告 JSON 中出现 0 次`;
    }],

    ['密钥：仓库里没有密钥形状的字面量', () => {
      // 模式由拼接构造，否则扫描会抓到自己 —— 而那时说谎的是夹具不是扫描。
      const patterns = [
        ['GitHub token', new RegExp(['gh', 'p_[A-Za-z0-9]{20,}'].join(''))],
        ['AWS key', new RegExp(['AK', 'IA[0-9A-Z]{16}'].join(''))],
        ['私钥块', new RegExp(['-----BEGIN', ' [A-Z ]*PRIVATE KEY-----'].join(''))],
        ['Slack token', new RegExp(['xox', '[abpr]-[A-Za-z0-9-]{12,}'].join(''))]
      ];
      const hits = [];
      let scanned = 0;
      for (const f of walk(ROOT).filter(isTextFile)) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        scanned += 1;
        for (const [name, re] of patterns) if (re.test(text)) hits.push(`${path.relative(ROOT, f)}: ${name}`);
      }
      expectEq(hits, [], '密钥形状的字面量');
      return `${scanned} 个文本文件、4 类密钥形状全部 0 命中（模式由拼接构造，扫描不会抓到自己）`;
    }]
  ];
}
