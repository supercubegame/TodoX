#!/usr/bin/env node
// 镜像流水线（mirror.yml）的报告入口。逻辑在 lib/compose.mjs，四条流水线共用。
import { MIRROR_GATES } from './lib/report.mjs';
import { runCompose } from './lib/compose.mjs';

runCompose('TodoX 镜像', MIRROR_GATES, process.argv.slice(2));
