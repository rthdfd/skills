import assert from 'node:assert/strict';
import { createOperations } from '../lib/index.js';

const operations = createOperations();
const call = async (name, args) => {
  const result = await operations.find((item) => item.name === name).execute(args);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) + 1 <= 65536);
  return result;
};
const repo = { owner: 'cli', repo: 'cli' };
const runs = await call('gh_run_list', { ...repo, status: 'failure', limit: 3 });
assert.equal(runs.ok, true, JSON.stringify(runs));
assert.ok(runs.runs.length > 0);
const runId = process.argv[2] ? Number(process.argv[2]) : 41730497368;
const failures = await call('gh_run_failures', { ...repo, run_id: runId });
assert.equal(failures.ok, true, JSON.stringify(failures));
assert.ok(failures.failures.some((failure) => failure.error_lines.length > 0), '未获得结构化错误行；选择仍保留日志的失败run再试。');
const file = await call('gh_repo_file', { ...repo, op: 'read', path: 'README.md', ref: 'trunk' });
assert.equal(file.ok, true, JSON.stringify(file));
assert.ok(file.content.length > 0 && file.sha);
const artifacts = await call('gh_run_artifacts', { ...repo, run_id: runId, per_page: 2 });
assert.equal(artifacts.ok, true, JSON.stringify(artifacts));
const denied = await call('gh_run_rerun', { ...repo, run_id: runId });
assert.equal(denied.error.code, 'CONFIRM_REQUIRED');
const missing = await call('gh_run_view', { ...repo, run_id: 1 });
assert.equal(missing.error.code, 'NOT_FOUND', JSON.stringify(missing));
console.log(JSON.stringify({
  checked_at: new Date().toISOString(), repo: 'cli/cli', runs_listed: runs.runs.length,
  failure_run: runId, failures: failures.failures.map((failure) => ({ job: failure.job, step: failure.step, conclusion: failure.conclusion, error_lines: failure.error_lines.slice(0, 3), hint_files: failure.hint_files.slice(0, 5) })),
  readme_bytes: Buffer.byteLength(file.content), artifact_total: artifacts.total_count,
  unconfirmed_write: denied.error.code, missing_run: missing.error.code,
  remote_writes_performed: false,
}, null, 2));
