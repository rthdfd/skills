import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { capOutput, createOperations, extractFailures, mapGhError, GH_PATH, CA_PATH, MAX_BUFFER, COMMAND_TIMEOUT_MS, OUTPUT_LIMIT } from '../lib/index.js';

const repository = { owner: 'example', repo: 'repo' };
const run = { databaseId: 123, workflowName: 'CI', headBranch: 'main', event: 'push', status: 'completed', conclusion: 'failure', startedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:01:00Z', headSha: 'a'.repeat(40), jobs: [{ databaseId: 456, name: 'unit (linux)', status: 'completed', conclusion: 'failure', startedAt: '2026-11-01T00:00:00Z', completedAt: '2026-11-01T00:01:00Z', steps: [{ number: 1, name: 'Tests', status: 'completed', conclusion: 'failure', startedAt: '2026-11-01T00:00:10Z', completedAt: '2026-11-01T00:00:50Z' }] }] };
function fixture(responses = []) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    const call = { file, args, options, input: '' };
    calls.push(call);
    const stdin = new Writable({ write(chunk, _encoding, done) { call.input += chunk.toString(); done(); } });
    const response = responses.shift() ?? '';
    queueMicrotask(() => {
      if (response instanceof Error) callback(response, '', response.stderr ?? '');
      else callback(null, typeof response === 'string' || Buffer.isBuffer(response) ? response : JSON.stringify(response), '');
    });
    return { stdin };
  };
  const operations = createOperations({ execFile });
  return { calls, operations, call: (name, args) => operations.find((item) => item.name === name).execute(args) };
}

for (const [code, message] of [
  ['NOT_LOGGED_IN', 'To get started with GitHub CLI, please run: gh auth login'],
  ['FORBIDDEN', 'HTTP 403: Resource not accessible by integration'],
  ['NOT_FOUND', 'HTTP 404: Not Found'],
  ['RATE_LIMIT', 'HTTP 403: API rate limit exceeded'],
  ['NETWORK_UNREACHABLE', 'dial tcp: lookup api.github.com: no such host'],
]) test(`错误映射 ${code}`, async () => {
  const error = new Error(message); error.stderr = message;
  const api = fixture([error]);
  const result = await api.call('gh_run_list', repository);
  assert.equal(result.ok, false); assert.equal(result.error.code, code); assert.ok(result.error.message.length > 8);
});

test('写操作省略/false/字符串 true 一律拒绝，零子进程', async () => {
  const api = fixture();
  for (const value of [undefined, false, 'true', 1, null]) for (const name of ['gh_run_rerun', 'gh_run_cancel', 'gh_workflow_dispatch', 'gh_repo_file']) {
    const args = { ...repository, run_id: 123, workflow: 'ci.yml', ref: 'main', op: 'write', path: 'a.txt', content: 'new', message: 'update', ...(value === undefined ? {} : { confirm: value }) };
    const result = await api.call(name, args);
    assert.equal(result.error.code, 'CONFIRM_REQUIRED');
  }
  assert.equal(api.calls.length, 0);
});

test('固定入口/CA/execFile 数组/60s/10MiB/无 shell 与缓存映射', async () => {
  const api = fixture([[]]);
  assert.equal((await api.call('gh_run_list', { ...repository, branch: 'fix/a', workflow: 'Unit Tests', limit: 2 })).ok, true);
  const call = api.calls[0];
  assert.equal(call.file, GH_PATH); assert.equal(call.options.env.SSL_CERT_FILE, CA_PATH);
  assert.equal(call.options.timeout, COMMAND_TIMEOUT_MS); assert.equal(call.options.maxBuffer, MAX_BUFFER);
  assert.equal(call.options.shell, false); assert.ok(Array.isArray(call.args));
  assert.equal(call.args[call.args.indexOf('--workflow') + 1], 'Unit Tests');
  assert.ok(call.options.env.XDG_CACHE_HOME.endsWith('/tmp/dsh-gh-actions-cache'));
});

test('非法 repo/ref/limit/path 与未知参数无子进程', async () => {
  const api = fixture();
  for (const args of [{ ...repository, owner: 'x;echo pwn' }, { ...repository, repo: '../../x' }, { ...repository, branch: '-main' }, { ...repository, branch: 'a/../b' }, { ...repository, branch: 'a$(id)' }, { ...repository, limit: 101 }, { ...repository, extra: 'x' }, JSON.parse('{"owner":"example","repo":"repo","__proto__":{}}')]) {
    assert.equal((await api.call('gh_run_list', args)).error.code, 'INVALID_ARGS');
  }
  assert.equal((await api.call('gh_repo_file', { ...repository, op: 'read', path: '../secret' })).error.code, 'INVALID_ARGS');
  assert.equal(api.calls.length, 0);
});

test('jobs → steps 时间与耗时结构', async () => {
  const result = await fixture([run]).call('gh_run_view', { ...repository, run_id: 123 });
  assert.equal(result.run.duration_seconds, 60);
  assert.equal(result.run.jobs[0].steps[0].duration_seconds, 40);
  assert.equal(result.run.head_sha, 'a'.repeat(40));
});

test('失败规则、文件线索、ANSI清理、unknown步骤时间归因', () => {
  const lines = ['\u001b[31merror: src/a.ts:12:3 cannot assign\u001b[0m', '::error file=src/b.py,line=4::AssertionError', '##[error]build failed', 'FAILED tests/test_a.py::test_x', 'Process completed with exit code 2.', 'Expected: 1', 'Received: 2', 'E assert 1 == 2'];
  const raw = lines.map((line) => `unit (linux)\tUNKNOWN STEP\t2026-11-01T00:00:20.1234567Z ${line}`).join('\n');
  const result = extractFailures(run, raw);
  const failure = result.failures.find((item) => item.step === 'Tests');
  assert.equal(failure.error_lines.length, lines.length);
  assert.ok(failure.hint_files.includes('src/a.ts:12:3'));
  assert.ok(failure.hint_files.includes('tests/test_a.py'));
  assert.equal(failure.error_lines[0].includes('\u001b'), false);
});

test('超长日志：1000条错误累计最多60，JSON有效且总字节<=64KiB', () => {
  const raw = Array.from({ length: 1000 }, (_, i) => `unit (linux)\tTests\t2026-11-01T00:00:20Z error: src/long.ts:${i + 1} ${'故障'.repeat(1500)}`).join('\n');
  const result = capOutput({ ok: true, ...extractFailures(run, raw) });
  assert.ok(result.failures.reduce((sum, failure) => sum + failure.error_lines.length, 0) <= 60);
  assert.equal(result.failures[0].error_lines_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) + 1 <= 64 * 1024);
  assert.ok(result.output_truncated);
  assert.ok(JSON.parse(JSON.stringify(result)));
});

test('失败 helper 真正使用原生 gh --log-failed', async () => {
  const api = fixture([run, 'unit (linux)\tTests\t2026-11-01T00:00:20Z error: test failed']);
  const result = await api.call('gh_run_failures', { ...repository, run_id: 123 });
  assert.ok(api.calls[1].args.includes('--log-failed'));
  assert.equal(result.failures[0].error_lines.length, 1);
});

test('日志过期保留结构，零 jobs 不伪装成功诊断', async () => {
  const result = await fixture([run, new Error('HTTP 404: log not found')]).call('gh_run_failures', { ...repository, run_id: 123 });
  assert.equal(result.failures[0].log_unavailable, true); assert.equal(result.log_error.code, 'NOT_FOUND');
  const empty = await fixture([{ ...run, jobs: [] }]).call('gh_run_failures', { ...repository, run_id: 123 });
  assert.ok(empty.notice); assert.deepEqual(empty.failures, []);
});

test('免clone文件读取与200KiB/64KiB双重截断', async () => {
  const text = '中文内容\n'.repeat(30000);
  const result = await fixture([{ type: 'file', path: 'big.txt', size: Buffer.byteLength(text), sha: 'b'.repeat(40), encoding: 'base64', content: Buffer.from(text).toString('base64') }]).call('gh_repo_file', { ...repository, op: 'read', path: 'big.txt', ref: 'main' });
  assert.equal(result.file_truncated, true); assert.equal(result.output_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= OUTPUT_LIMIT);
  assert.equal(result.content.includes('\ufffd'), false);
});

test('PUT contents只用stdin JSON，不解释@file或shell字符', async () => {
  const api = fixture([{ content: { path: 'a.txt', sha: 'c'.repeat(40) }, commit: { sha: 'd'.repeat(40) } }]);
  const content = '@file\n$(id); "quoted" 中文';
  const result = await api.call('gh_repo_file', { ...repository, op: 'write', path: 'dir/a file.txt', ref: 'fix/a', content, message: 'update', sha: 'b'.repeat(40), confirm: true });
  assert.equal(result.ok, true);
  const call = api.calls[0]; assert.ok(call.args.includes('PUT')); assert.ok(call.args.includes('--input'));
  const body = JSON.parse(call.input); assert.equal(Buffer.from(body.content, 'base64').toString(), content);
  assert.equal(body.branch, 'fix/a'); assert.ok(call.args.some((arg) => arg.includes('dir/a%20file.txt')));
});

test('dispatch inputs类型验证，合法参数通过stdin', async () => {
  const bad = fixture();
  assert.equal((await bad.call('gh_workflow_dispatch', { ...repository, workflow: 'ci.yml', ref: 'main', inputs: { mode: true }, confirm: true })).error.code, 'INVALID_ARGS');
  assert.equal(bad.calls.length, 0);
  const api = fixture(['']);
  assert.equal((await api.call('gh_workflow_dispatch', { ...repository, workflow: 'ci.yml', ref: 'main', inputs: { mode: '@anything' }, confirm: true })).ok, true);
  assert.equal(JSON.parse(api.calls[0].input).inputs.mode, '@anything');
});

test('写请求超时必须unknown/no_replay，禁止自动重试', async () => {
  const error = new Error('timeout'); error.killed = true;
  const api = fixture([error]);
  const result = await api.call('gh_run_cancel', { ...repository, run_id: 123, confirm: true });
  assert.equal(result.error.execution_unknown, true); assert.equal(result.error.no_replay, true); assert.equal(api.calls.length, 1);
  assert.equal(mapGhError(new Error('[POLICY_BLOCKED]'), true).code, 'POLICY_BLOCKED');
});

test('artifact分页与expired及设备目录拒绝', async () => {
  const listed = await fixture([{ total_count: 102, artifacts: [{ id: 1, name: 'build', size_in_bytes: 12, expires_at: '2026-12-01', expired: false }] }]).call('gh_run_artifacts', { ...repository, run_id: 123 });
  assert.equal(listed.next_page, 2); assert.equal(listed.artifacts[0].size_bytes, 12);
  const api = fixture([{ expired: true }]);
  assert.equal((await api.call('gh_artifact_download', { ...repository, artifact_id: 1, directory: '/tmp/skill-artifacts' })).error.code, 'ARTIFACT_EXPIRED');
  const rejected = fixture();
  assert.equal((await rejected.call('gh_artifact_download', { ...repository, artifact_id: 1, directory: '/storage/emulated/0/Download' })).error.code, 'INVALID_ARGS');
  assert.equal(rejected.calls.length, 0);
});
