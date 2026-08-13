#!/usr/bin/env node
// 验证流水线（verify.yml）的报告入口。逻辑在 lib/compose.mjs，两条流水线共用。
import { GATES } from './lib/report.mjs';
import { runCompose } from './lib/compose.mjs';

runCompose('TodoX 验证', GATES, process.argv.slice(2));
