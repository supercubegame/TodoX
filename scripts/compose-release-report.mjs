#!/usr/bin/env node
// 发布流水线（release.yml）的报告入口。逻辑在 lib/compose.mjs，两条流水线共用。
import { RELEASE_GATES } from './lib/report.mjs';
import { runCompose } from './lib/compose.mjs';

runCompose('TodoX 发布', RELEASE_GATES, process.argv.slice(2));
