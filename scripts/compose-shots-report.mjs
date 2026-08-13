#!/usr/bin/env node
// 截图流水线（screenshots.yml）的报告入口。逻辑在 lib/compose.mjs，三条流水线共用。
import { SHOTS_GATES } from './lib/report.mjs';
import { runCompose } from './lib/compose.mjs';

runCompose('TodoX 截图', SHOTS_GATES, process.argv.slice(2));
