# Agent task evaluation

`tasks.json` defines scored workflows from the comparative analysis. Use an isolated fixture workspace and fixed Provider, model, checkout and settings. Preserve full traces. Run each task several times in baseline and experiment variants; change one mechanism at a time. State quality gates before collecting results.

Score every criterion with a trace reference. Each JSON run needs `runId`, `taskId`, `variant`, `provider`, `model`, `checkout`, `settingsHash`, `tracePath`, `status` (`passed`, `failed`, `infrastructure_error`), `criteria` (`id`, `passed`, `evidence`), and nonnegative metrics `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `modelCalls`, `toolCalls`, `userTurns`, `elapsedMs`, `costUsd`. Failed and infrastructure runs also need `failureCategory`. A successful exit code alone does not establish workflow correctness.

Run `node scripts/evaluate-agent-tasks.mjs scored-runs.json`. Task failures remain in the success-rate denominator; infrastructure errors are counted separately. Totals include all resource usage. Different settings and checkouts remain separate. Missing measurements are rejected instead of silently counted as zero.

No real-model scores have been collected by this change. Unit tests establish implementation behavior, not model success rates or cost savings.
