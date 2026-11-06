import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFailures } from '../lib/index.js';

test('忽略 runner 回显脚本和成功步骤的错误字样，保留真正超时', () => {
  const run = { jobs: [{ name: 'agent', conclusion: 'failure', steps: [
    { name: 'Execute', conclusion: 'failure', startedAt: '2026-11-01T00:00:00Z', completedAt: '2026-11-01T00:10:00Z' },
    { name: 'Summarize', conclusion: 'success', startedAt: '2026-11-01T00:10:01Z', completedAt: '2026-11-01T00:11:00Z' },
  ] }] };
  const logs = [
    'agent\tUNKNOWN STEP\t2026-11-01T00:00:01Z ^[[36;1mecho "::error::possible error"; exit 1^[[0m',
    'agent\tUNKNOWN STEP\t2026-11-01T00:00:02Z \u001b[36;1mexit 127\u001b[0m',
    'agent\tUNKNOWN STEP\t2026-11-01T00:00:03Z [entrypoint] Executing command: bash -c "exit 127"',
    'agent\tUNKNOWN STEP\t2026-11-01T00:10:00.3608245Z ##[error]The action has timed out after 10 minutes.',
    'agent\tUNKNOWN STEP\t2026-11-01T00:10:20Z Error: replayed earlier tool error',
  ].join('\n');
  const result = extractFailures(run, logs);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].step, 'Execute');
  assert.deepEqual(result.failures[0].error_lines, ['##[error]The action has timed out after 10 minutes.']);
});

test('文件扩展名不把json误截成js', () => {
  const run = { jobs: [{ name: 'test', conclusion: 'failure', steps: [{ name: 'Test', conclusion: 'failure' }] }] };
  const result = extractFailures(run, 'test\tTest\t2026-11-01T00:00:00Z error: .github/settings.json:12 parse failed');
  assert.ok(result.failures[0].hint_files.includes('.github/settings.json:12'));
  assert.equal(result.failures[0].hint_files.includes('.github/settings.js'), false);
});
