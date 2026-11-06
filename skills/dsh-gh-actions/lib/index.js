import { execFile as nodeExecFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

// Standalone skill helper. No Cordis registration, token handling or runtime dependencies.
export const GH_PATH = '/root/dsh-bin/gh';
export const CA_PATH = '/storage/emulated/0/gh-ca.pem';
export const COMMAND_TIMEOUT_MS = 60_000;
export const MAX_BUFFER = 10 * 1024 * 1024;
export const OUTPUT_LIMIT = 64 * 1024 - 1; // Reserve one byte for the CLI newline.
export const FILE_READ_LIMIT = 200 * 1024;

// Schemas validate the standalone CLI's JSON input only; nothing is added to
// the DSH tool catalog. Native gh remains available for simple read queries.
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const id = (description) => ({ type: 'integer', description });
const repository = {
  owner: str('仓库 owner；仅 A-Z、a-z、0-9、点、下划线、连字符。'),
  repo: str('仓库名；仅 A-Z、a-z、0-9、点、下划线、连字符。'),
};
const runId = { run_id: id('GitHub Actions run ID，正安全整数。') };
const confirm = { confirm: { type: 'boolean', description: '远端写操作仅在严格等于 true 时执行；省略或 false 一律拒绝。' } };
const ref = str('分支、tag 或 SHA；仅 A-Z、a-z、0-9、._/-，禁止 .. 和 - 开头。');
const workflow = str('Workflow 数字 ID、文件名或名称；dispatch 使用 ID 或文件名。');
const objectSchema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const specifications = [
  ['gh_run_list', '按仓库、分支、状态和 workflow 列最近 Actions runs，含结论、耗时与 head_sha。',
    objectSchema({ ...repository, branch: ref, status: str('运行状态或结论。', { enum: ['queued', 'completed', 'in_progress', 'requested', 'waiting', 'pending', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'startup_failure', 'success', 'timed_out'] }), workflow, limit: id('最近 runs 数量，1–100，默认 20。') }, ['owner', 'repo'])],
  ['gh_run_view', '读取单个 Actions run，返回 jobs → steps 的名称、结论、起止和耗时。',
    objectSchema({ ...repository, ...runId }, ['owner', 'repo', 'run_id'])],
  ['gh_run_failures', '关联失败 jobs/steps，提取最多 60 条错误行、文件线索和短日志上下文。',
    objectSchema({ ...repository, ...runId }, ['owner', 'repo', 'run_id'])],
  ['gh_run_rerun', '重新运行 Actions run；必须 confirm:true，可仅重跑失败 jobs。',
    objectSchema({ ...repository, ...runId, failed_only: { type: 'boolean', description: '只重跑失败 jobs，默认 false。' }, ...confirm }, ['owner', 'repo', 'run_id'])],
  ['gh_run_cancel', '取消 Actions run；必须 confirm:true，否则不调用 gh。',
    objectSchema({ ...repository, ...runId, ...confirm }, ['owner', 'repo', 'run_id'])],
  ['gh_run_artifacts', '列出 run 的 artifacts，含 ID、名称、大小和过期时间，支持分页。',
    objectSchema({ ...repository, ...runId, page: id('页码，1–10000，默认 1。'), per_page: id('每页 1–100，默认 100。') }, ['owner', 'repo', 'run_id'])],
  ['gh_artifact_download', '按 artifact ID 将原始 ZIP 下载到容器指定目录；不解压、不覆盖已有文件。',
    objectSchema({ ...repository, artifact_id: id('Artifact ID，正安全整数。'), directory: str('容器目录的绝对路径，不可使用 Android 共享存储；保存 artifact-ID.zip。') }, ['owner', 'repo', 'artifact_id', 'directory'])],
  ['gh_repo_file', '免 clone 读取文件或列目录；write 通过 PUT contents 提交，必须 confirm:true。',
    objectSchema({ ...repository, op: str('文件操作。', { enum: ['read', 'write', 'list'] }), path: str('仓库相对路径；list 可用空串表示根目录，禁止 . 或 .. 路径段。'), ref, content: str('write 的 UTF-8 内容，空串合法；不会解释 @file。'), message: str('write 的提交说明。'), sha: str('更新已有文件时的 blob SHA；创建新文件时省略。'), ...confirm }, ['owner', 'repo', 'op', 'path'])],
  ['gh_workflow_dispatch', '触发 workflow_dispatch；必须 confirm:true，inputs 为字符串键值映射。',
    objectSchema({ ...repository, workflow, ref, inputs: { type: 'object', description: 'Workflow inputs，最多 25 项、每项字符串。', additionalProperties: { type: 'string' } }, ...confirm }, ['owner', 'repo', 'workflow', 'ref'])],
];
export const parameterSchemas = Object.fromEntries(specifications.map(([tool, , parameters]) => [tool, parameters]));

function invalid(message) { const error = new Error(message); error.code = 'INVALID_ARGS'; throw error; }
function boundedInteger(value, label, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} 必须是 ${minimum}–${maximum} 的整数。`);
}
function validate(schema, value, label = 'args') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} 必须是对象。`);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) invalid(`缺少 ${label}.${key}。`);
    for (const [key, item] of Object.entries(value)) {
      const child = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : undefined;
      if (child) validate(child, item, `${label}.${key}`);
      else if (schema.additionalProperties === false) invalid(`不支持参数 ${label}.${key}。`);
      else if (typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, item, `${label}.${key}`);
    }
  } else if (schema.type === 'integer') boundedInteger(value, label);
  else if (typeof value !== schema.type) invalid(`${label} 必须是 ${schema.type}。`);
  if (schema.enum && !schema.enum.includes(value)) invalid(`${label} 不在允许值中。`);
}
function validateRepo(args) {
  for (const key of ['owner', 'repo']) {
    if (!/^[A-Za-z0-9._-]+$/.test(args[key]) || ['.', '..'].includes(args[key])) invalid(`${key} 只能包含 A-Z、a-z、0-9、._-，且不可为 . 或 ..。`);
  }
}
function validateRef(value, label = 'ref') {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('-') || value.includes('..')) invalid(`${label} 不合法：只允许 A-Z、a-z、0-9、._/-，禁止 .. 和 - 开头。`);
}
function validateWorkflow(value) {
  if (!value.trim() || value.startsWith('-') || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 512) invalid('workflow 必须为非空 ID、文件名或名称，不能以 - 开头或含控制字符。');
}
function repoPath(args) { return `repos/${args.owner}/${args.repo}`; }
function encodedPath(path) {
  if (path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) || path.split('/').some((part) => part === '.' || part === '..')) invalid('path 必须为安全的仓库相对路径。');
  return path.split('/').map(encodeURIComponent).join('/');
}
function utf8Prefix(text, bytes) {
  const data = Buffer.from(text);
  if (data.length <= bytes) return text;
  let end = Math.max(0, bytes);
  while (end > 0 && (data[end] & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8');
}
function clip(text, bytes) {
  return Buffer.byteLength(text) <= bytes ? text : `${utf8Prefix(text, Math.max(0, bytes - 40))}\n[truncated / 已截断]`;
}
// Keep valid JSON and useful structure; cap the actual compact model payload,
// not just a particular stdout field. No spill files containing remote logs.
export function capOutput(value) {
  const size = (item) => Buffer.byteLength(JSON.stringify(item));
  const originalBytes = size(value);
  if (originalBytes <= OUTPUT_LIMIT) return value;
  const result = structuredClone(value);
  result.output_truncated = true;
  result.truncation_notice = `输出超过 64 KiB，已在代码内截断（原始 ${originalBytes} bytes）。`;
  while (size(result) > OUTPUT_LIMIT) {
    const candidates = [];
    function walk(item) {
      if (!item || typeof item !== 'object') return;
      for (const [key, entry] of Object.entries(item)) {
        if (typeof entry === 'string' && Buffer.byteLength(entry) > 256) candidates.push({ parent: item, key, bytes: Buffer.byteLength(entry), kind: 'string' });
        else if (Array.isArray(entry) && entry.length > 1) {
          candidates.push({ parent: item, key, bytes: size(entry), kind: 'array' });
          for (const child of entry) walk(child);
        } else walk(entry);
      }
    }
    walk(result);
    candidates.sort((a, b) => b.bytes - a.bytes);
    const largest = candidates[0];
    if (!largest) return { ok: result.ok, output_truncated: true, truncation_notice: result.truncation_notice, error: { code: 'OUTPUT_TOO_LARGE', message: '无法保留完整结构；请缩小查询范围。' } };
    if (largest.kind === 'string') largest.parent[largest.key] = clip(largest.parent[largest.key], Math.max(128, Math.floor(largest.bytes / 2)));
    else largest.parent[largest.key] = largest.parent[largest.key].slice(0, Math.max(1, Math.floor(largest.parent[largest.key].length / 2)));
  }
  return result;
}

export function mapGhError(error, mutating = false) {
  const detail = `${error.stderr ? String(error.stderr) : ''}\n${error.message ?? String(error)}`;
  let code = 'GH_ERROR';
  let message = 'gh 命令失败；检查仓库参数并在同一托管环境中复现。';
  if (/\[POLICY_BLOCKED\]|\bDISABLED\b|\bNO_PERMISSION\b/.test(detail)) { code = 'POLICY_BLOCKED'; message = '操作被 DSHA 策略或授权拒绝；按原生提示处理，不改用其他入口绕过。'; }
  else if (/rate limit|secondary rate|abuse detection|HTTP 429|status(?: code)? 429/i.test(detail)) { code = 'RATE_LIMIT'; message = 'GitHub 限流；等待限流窗口重置后再试，不要自动重试。'; }
  else if (/not logged|not authenticated|authentication required|gh auth login|HTTP 401|bad credentials/i.test(detail)) { code = 'NOT_LOGGED_IN'; message = `请在本环境运行 SSL_CERT_FILE=${CA_PATH} ${GH_PATH} auth login 完成登录或重新认证。`; }
  else if (/HTTP 403|status(?: code)? 403|forbidden|resource not accessible|permission denied/i.test(detail)) { code = 'FORBIDDEN'; message = '检查账号的仓库访问权、Actions 写权限、workflow scope 与组织 SSO 授权。'; }
  else if (/HTTP 404|status(?: code)? 404|not found/i.test(detail)) { code = 'NOT_FOUND'; message = '核对仓库、run/artifact/workflow ID 或文件 ref；私有仓库无权限也可能返回 404。'; }
  else if (/certificate signed by unknown authority|x509/i.test(detail)) { code = 'TLS_CERTIFICATE'; message = `核对 ${CA_PATH} 的可读性与有效 CA；不要禁用 TLS 校验。`; }
  else if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|no such host|network is unreachable|network.*unreachable|dial tcp|TLS handshake timeout|i\/o timeout|unable to connect/i.test(detail)) { code = 'NETWORK_UNREACHABLE'; message = `检查手机网络与 DSHA CONNECT 代理，必须通过 ${GH_PATH} 访问 GitHub。`; }
  else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { code = 'BUFFER_LIMIT'; message = '单次 gh 输出超过 10 MiB；缩小运行/文件范围或选择较小 artifact。'; }
  else if (error.code === 'ABORT_ERR' || error.killed || error.signal) { code = 'INTERRUPTED'; message = 'gh 已取消或超过 60 秒；先查询实际状态，不自动重放。'; }
  else if (error.code === 'INVALID_ARGS' || error.code === 'INVALID_RESPONSE') { code = error.code; message = error.message; }
  else if (error.code === 'EEXIST') { code = 'DESTINATION_EXISTS'; message = '目标 ZIP 已存在；选择其他目录，不会覆盖已有文件。'; }
  // Do not repeat arbitrary stderr: it can contain signed URLs or credentials.
  return { code, message, ...(mutating && !['INVALID_ARGS', 'POLICY_BLOCKED'].includes(code) ? { execution_unknown: true, no_replay: true, next_action: '先核对 GitHub 实际状态；确认后另行决定，切勿自动重试写操作。' } : {}) };
}

function createRunner(execFileImpl) {
  return async (args, { body, binary = false, signal } = {}) => {
    // Go sees host paths, unlike Node inside proot. Keep gh's own log cache
    // inside the container, but pass its host-visible spelling to gh.
    const cache = '/tmp/dsh-gh-actions-cache';
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const hostRoot = process.env.DSHA_GH_HOST_ROOT;
    const cachePath = hostRoot ? `${hostRoot.replace(/\/$/, '')}${cache}` : cache;
    return new Promise((resolveCommand, reject) => {
    if (signal?.aborted) { const error = new Error('取消'); error.code = 'ABORT_ERR'; reject(error); return; }
    const child = execFileImpl(GH_PATH, args, {
      env: { ...process.env, SSL_CERT_FILE: CA_PATH, XDG_CACHE_HOME: cachePath, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: '', PAGER: '' },
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: binary ? 'buffer' : 'utf8',
      shell: false,
      signal,
    }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); }
      else resolveCommand(stdout);
    });
    // --input - uses stdin JSON: no @file expansion, shell interpolation,
    // token reads, or request-body temporary files.
    if (child?.stdin) {
      child.stdin.on('error', () => {}); // EPIPE is represented by command failure.
      child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
    } else if (body !== undefined) reject(new Error('gh stdin 不可用；请求未发送。'));
    });
  };
}
function parseJson(text) {
  try { return JSON.parse(text); }
  catch { const error = new Error('gh 返回的内容不是有效 JSON；检查托管 gh 版本及代理响应。'); error.code = 'INVALID_RESPONSE'; throw error; }
}
function seconds(start, end) {
  const a = Date.parse(start), b = Date.parse(end);
  return Number.isFinite(a) && Number.isFinite(b) && a > 0 && b >= a ? Math.round((b - a) / 1000) : null;
}
function normalizeRun(run) {
  return {
    id: run.databaseId, workflow: run.workflowName, branch: run.headBranch,
    event: run.event, status: run.status, conclusion: run.conclusion || null,
    duration_seconds: run.status === 'completed' ? seconds(run.startedAt, run.updatedAt) : null,
    duration_source: 'startedAt → updatedAt (approximate)', head_sha: run.headSha,
    started_at: run.startedAt, updated_at: run.updatedAt,
  };
}
function normalizeJob(job) {
  return { id: job.databaseId, name: job.name, status: job.status, conclusion: job.conclusion || null,
    started_at: job.startedAt, completed_at: job.completedAt, duration_seconds: seconds(job.startedAt, job.completedAt),
    steps: (job.steps ?? []).map((step) => ({ number: step.number, name: step.name, status: step.status,
      conclusion: step.conclusion || null, started_at: step.startedAt, completed_at: step.completedAt,
      duration_seconds: seconds(step.startedAt, step.completedAt) })) };
}
const RUN_FIELDS = 'databaseId,workflowName,headBranch,event,conclusion,status,startedAt,updatedAt,headSha';
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
// Conservative rule extraction; these are clues, not an automatic diagnosis.
const ERROR_RULE = /(?:\berror\s*:|::error(?:\s|::)|##\[error\]|\bFAILED\b|\bFAIL(?:\s|:)|exit(?:ed)?(?:\s+with)?(?:\s+status|\s+code|\s+exit\s+code)?\s*[:=]?\s*[1-9]\d*\b|non[- ]zero(?:\s+exit)?|AssertionError|assert(?:ion)?\s+(?:failed|failure)|\b(?:Expected|Received|Actual)\s*:|\bexpected\b.*\b(?:to (?:equal|be|match)|but (?:got|was))\b|^\s*E\s+(?:assert|AssertionError)|\bassert\s+.+(?:==|!=|<=|>=))/i;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
function cleanLine(line) { return line.replace(/^\uFEFF/, '').replace(ANSI, '').replace(/^\d{4}-\d{2}-\d{2}T\S+\s*/, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); }
function hintFiles(lines) {
  const files = new Set();
  const pattern = /(?:[A-Za-z]:[\\/])?(?:\.?\.?[\\/])?(?:[\w@.+-]+[\\/])*[\w@.+-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|sh|yml|yaml|json|toml|xml|md|vue|svelte|feature)(?![\w.])(?::\d+(?::\d+)?)?/g;
  for (const line of lines) for (const match of line.matchAll(pattern)) {
    const file = match[0];
    const index = match.index;
    if (line.slice(Math.max(0, index - 8), index).includes('://') || /^\d{4}-/.test(file)) continue;
    files.add(file);
    if (files.size >= 30) return [...files];
  }
  return [...files];
}
export function extractFailures(run, rawLog) {
  const groups = new Map();
  const keyOf = (job, step) => JSON.stringify([job, step]);
  const getGroup = (job, step, conclusion = 'failure') => {
    const key = keyOf(job, step);
    if (!groups.has(key)) groups.set(key, { job, step, conclusion, lines: [], error_indexes: [], errors_seen: 0 });
    return groups.get(key);
  };
  for (const job of run.jobs ?? []) {
    const failedSteps = (job.steps ?? []).filter((step) => FAILURE_CONCLUSIONS.has(step.conclusion));
    for (const step of failedSteps) getGroup(job.name, step.name, step.conclusion);
    if (!failedSteps.length && FAILURE_CONCLUSIONS.has(job.conclusion)) getGroup(job.name, '(job-level)', job.conclusion);
  }
  const seeded = [...groups.values()];
  let unmatched = 0;
  for (const raw of rawLog.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // Runner prints the shell script itself in cyan before executing it.
    // Those echo/exit statements are not observed failures.
    if (/(?:\x1b|\^\[)\[36;1m/.test(raw) || /\bExecuting command:|\[command\]/.test(raw)) continue;
    const first = raw.indexOf('\t'), second = first < 0 ? -1 : raw.indexOf('\t', first + 1);
    let group, line;
    if (first >= 0 && second >= 0) {
      const job = raw.slice(0, first), step = raw.slice(first + 1, second);
      line = cleanLine(raw.slice(second + 1));
      group = groups.get(keyOf(job, step));
      if (!group) {
        // gh may label a step UNKNOWN STEP; preserve real names from metadata
        // when the timestamp uniquely maps to a failed step in this job.
        const stamp = /^\d{4}-\d{2}-\d{2}T\S+/.exec(raw.slice(second + 1))?.[0];
        const time = Date.parse(stamp);
        const match = (run.jobs ?? []).find((item) => item.name === job)?.steps?.filter((item) => FAILURE_CONCLUSIONS.has(item.conclusion) && time >= Date.parse(item.startedAt) && time < Date.parse(item.completedAt) + 1000);
        if (match?.length === 1) group = getGroup(job, match[0].name, match[0].conclusion);
        else if ((run.jobs ?? []).find((item) => item.name === job)?.steps?.some((item) => !FAILURE_CONCLUSIONS.has(item.conclusion) && time >= Date.parse(item.startedAt) && time < Date.parse(item.completedAt) + 1000)) { unmatched++; continue; }
        else if (ERROR_RULE.test(line)) group = getGroup(job, step || '(unknown step)');
        else { unmatched++; continue; }
      }
    } else {
      line = cleanLine(raw);
      group = seeded.length === 1 ? seeded[0] : getGroup('(unattributed)', '(unknown step)');
    }
    group.lines.push(clip(line, 2048));
    if (ERROR_RULE.test(line)) { group.error_indexes.push(group.lines.length - 1); group.errors_seen++; }
  }
  let remaining = 60;
  const failures = [...groups.values()].map((group) => {
    const priority = (index) => /^(?:##\[error\]|::error)/i.test(group.lines[index]) ? 0 : /\berror\s*:|AssertionError|exit(?:ed)?(?:\s+with)?(?:\s+status|\s+code|\s+exit\s+code)?\s*[:=]?\s*[1-9]/i.test(group.lines[index]) ? 1 : 2;
    const selected = [...group.error_indexes].sort((a, b) => priority(a) - priority(b) || a - b).slice(0, remaining);
    remaining -= selected.length;
    const context = new Set();
    for (const index of selected.slice(0, 8)) for (let i = Math.max(0, index - 2); i <= Math.min(group.lines.length - 1, index + 2); i++) context.add(i);
    if (!context.size) for (let i = Math.max(0, group.lines.length - 12); i < group.lines.length; i++) context.add(i);
    const errorLines = selected.map((index) => group.lines[index]);
    const excerptLines = [...context].sort((a, b) => a - b).map((index) => group.lines[index]);
    return { job: group.job, step: group.step, conclusion: group.conclusion,
      error_lines: errorLines, hint_files: hintFiles([...errorLines, ...excerptLines]),
      log_excerpt: clip(excerptLines.join('\n'), 6144), error_lines_total: group.errors_seen,
      error_lines_truncated: selected.length < group.errors_seen,
      ...(group.lines.length === 0 ? { log_unavailable: true } : {}) };
  });
  return { failures, error_lines_limit: 60, unmatched_log_lines: unmatched };
}

function denyWrite(tool) { return { ok: false, error: { code: 'CONFIRM_REQUIRED', message: `${tool} 是远端写操作；必须明确传入 confirm:true，未执行任何 gh 命令。` } }; }
function artifactView(artifact) { return { id: artifact.id, name: artifact.name, size_bytes: artifact.size_in_bytes, expired: artifact.expired, expires_at: artifact.expires_at, created_at: artifact.created_at }; }
const SHARED_STORAGE = /^\/(?:storage|sdcard|mnt|data|system|vendor|proc|sys|dev)(?:\/|$)/;
async function containerDirectory(directory) {
  if (!isAbsolute(directory) || directory.includes('\0')) invalid('directory 必须为容器目录绝对路径。');
  const absolute = resolve(directory);
  if (absolute === '/' || SHARED_STORAGE.test(absolute)) invalid('禁止写入根目录或 Android 共享存储；请使用容器工作目录。');
  // Resolve the closest existing parent before mkdir, catching symlink aliases.
  let parent = absolute;
  for (;;) {
    try {
      const actual = await realpath(parent);
      if (SHARED_STORAGE.test(actual)) invalid('目标目录解析到 Android 共享存储；只能写入容器目录。');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = resolve(parent, '..');
      if (next === parent) throw error;
      parent = next;
    }
  }
  await mkdir(absolute, { recursive: true });
  const actual = await realpath(absolute);
  if (SHARED_STORAGE.test(actual)) invalid('目标目录解析到 Android 共享存储。');
  return actual;
}

export function createOperations({ execFile: execFileImpl = nodeExecFile } = {}) {
  const command = createRunner(execFileImpl);
  const api = async (endpoint, { method = 'GET', body, signal, binary = false } = {}) => {
    const args = ['api', '--hostname', 'github.com', '--method', method, endpoint];
    if (body !== undefined) args.push('--input', '-');
    const response = await command(args, { body, signal, binary });
    return binary ? response : response.trim() ? parseJson(response) : null;
  };
  const view = async (args, signal) => parseJson(await command(['run', 'view', String(args.run_id), '--repo', `${args.owner}/${args.repo}`, '--json', `${RUN_FIELDS},jobs`], { signal }));
  const handlers = {
    async gh_run_list(args, signal) {
      const limit = args.limit ?? 20;
      boundedInteger(limit, 'limit', 1, 100);
      const argv = ['run', 'list', '--repo', `${args.owner}/${args.repo}`, '--limit', String(limit), '--json', RUN_FIELDS];
      for (const key of ['branch', 'status', 'workflow']) if (args[key] !== undefined) argv.push(`--${key}`, args[key]);
      const runs = parseJson(await command(argv, { signal }));
      return { ok: true, runs: runs.map(normalizeRun), count: runs.length };
    },
    async gh_run_view(args, signal) {
      const run = await view(args, signal);
      return { ok: true, run: { ...normalizeRun(run), jobs: (run.jobs ?? []).map(normalizeJob) } };
    },
    async gh_run_failures(args, signal) {
      const run = await view(args, signal);
      let logs = '', logError;
      if ((run.jobs ?? []).some((job) => FAILURE_CONCLUSIONS.has(job.conclusion) || (job.steps ?? []).some((step) => FAILURE_CONCLUSIONS.has(step.conclusion)))) {
        try { logs = await command(['run', 'view', String(args.run_id), '--repo', `${args.owner}/${args.repo}`, '--log-failed'], { signal }); }
        catch (error) { logError = mapGhError(error); }
      }
      return { ok: true, run_id: args.run_id, head_sha: run.headSha, workflow: run.workflowName, branch: run.headBranch, conclusion: run.conclusion || null, ...extractFailures(run, logs),
        ...(!run.jobs?.length ? { notice: '该 run 尚无 jobs，可能在调度、权限或 workflow 校验阶段失败；不是“没有错误”。' } : {}),
        ...(logError ? { log_error: logError, notice: '步骤元数据已返回，但日志不可用、已过期或超过限制；未自动重试。' } : {}) };
    },
    async gh_run_rerun(args, signal) {
      const argv = ['run', 'rerun', String(args.run_id), '--repo', `${args.owner}/${args.repo}`];
      if (args.failed_only === true) argv.push('--failed');
      await command(argv, { signal });
      return { ok: true, run_id: args.run_id, action: 'rerun', failed_only: args.failed_only === true, notice: '重跑请求已接受；用 gh_run_view 查询后续状态。' };
    },
    async gh_run_cancel(args, signal) {
      await command(['run', 'cancel', String(args.run_id), '--repo', `${args.owner}/${args.repo}`], { signal });
      return { ok: true, run_id: args.run_id, action: 'cancel', notice: '取消请求已接受；用 gh_run_view 核对状态。' };
    },
    async gh_run_artifacts(args, signal) {
      const page = args.page ?? 1, perPage = args.per_page ?? 100;
      boundedInteger(page, 'page', 1, 10000); boundedInteger(perPage, 'per_page', 1, 100);
      const result = await api(`${repoPath(args)}/actions/runs/${args.run_id}/artifacts?${new URLSearchParams({ page: String(page), per_page: String(perPage) })}`, { signal });
      return { ok: true, total_count: result.total_count, page, per_page: perPage,
        artifacts: result.artifacts.map(artifactView), next_page: page * perPage < result.total_count ? page + 1 : null };
    },
    async gh_artifact_download(args, signal) {
      // Validate destination before any network request. No automatic extraction
      // avoids zip-slip, symlinks and decompression bombs without dependencies.
      if (!isAbsolute(args.directory) || args.directory.includes('\0') || SHARED_STORAGE.test(resolve(args.directory)) || resolve(args.directory) === '/') invalid('directory 必须是容器目录绝对路径，不能是根目录或 Android 共享存储。');
      const artifact = await api(`${repoPath(args)}/actions/artifacts/${args.artifact_id}`, { signal });
      if (artifact.expired) return { ok: false, error: { code: 'ARTIFACT_EXPIRED', message: 'Artifact 已过期；重新运行 workflow 生成新的 artifact。' } };
      if (artifact.size_in_bytes > MAX_BUFFER) return { ok: false, error: { code: 'BUFFER_LIMIT', message: 'Artifact 超过单命令 10 MiB 上限；选择较小 artifact。' } };
      const data = await api(`${repoPath(args)}/actions/artifacts/${args.artifact_id}/zip`, { signal, binary: true });
      if (!Buffer.isBuffer(data) || data.length < 4 || ![0x04034b50, 0x06054b50].includes(data.readUInt32LE(0))) { const error = new Error('Artifact 响应不是 ZIP；未写入文件。'); error.code = 'INVALID_RESPONSE'; throw error; }
      const directory = await containerDirectory(args.directory);
      const path = join(directory, `artifact-${args.artifact_id}.zip`);
      await writeFile(path, data, { flag: 'wx', mode: 0o600 });
      return { ok: true, artifact: artifactView(artifact), path, downloaded_bytes: data.length, format: 'zip', extracted: false };
    },
    async gh_repo_file(args, signal) {
      const encoded = encodedPath(args.path);
      if (args.op !== 'list' && !args.path) invalid('read/write 必须指定文件 path。');
      const endpoint = `${repoPath(args)}/contents${encoded ? `/${encoded}` : ''}`;
      if (args.op === 'write') {
        if (typeof args.content !== 'string' || typeof args.message !== 'string' || !args.message.trim()) invalid('write 需要字符串 content 和非空 message。');
        if (Buffer.byteLength(args.content) > 5 * 1024 * 1024) invalid('write content 不可超过 5 MiB。');
        if (args.sha !== undefined && !/^[a-fA-F0-9]{40,64}$/.test(args.sha)) invalid('sha 必须是 40–64 位十六进制 blob SHA。');
        const body = { message: args.message, content: Buffer.from(args.content, 'utf8').toString('base64'),
          ...(args.sha !== undefined ? { sha: args.sha } : {}), ...(args.ref !== undefined ? { branch: args.ref } : {}) };
        const result = await api(endpoint, { method: 'PUT', body, signal });
        return { ok: true, path: result.content?.path ?? args.path, sha: result.content?.sha, commit_sha: result.commit?.sha, html_url: result.content?.html_url };
      }
      const suffix = args.ref === undefined ? '' : `?${new URLSearchParams({ ref: args.ref })}`;
      const result = await api(`${endpoint}${suffix}`, { signal });
      if (args.op === 'list') {
        if (!Array.isArray(result)) invalid('该 path 不是目录；文件请用 op:read。');
        return { ok: true, entries: result.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type, size_bytes: entry.size, sha: entry.sha })), count: result.length,
          ...(result.length >= 1000 ? { notice: 'GitHub Contents API 每目录最多 1000 项；列表可能不完整。' } : {}) };
      }
      if (Array.isArray(result) || result.type !== 'file') invalid('该 path 不是普通文件；目录请用 op:list，符号链接或子模块不跟随。');
      let bytes;
      if (result.encoding === 'base64') bytes = Buffer.from(result.content ?? '', 'base64');
      else if (result.encoding === 'none' && result.size <= MAX_BUFFER) {
        const raw = await command(['api', '--hostname', 'github.com', '--method', 'GET', `${endpoint}${suffix}`, '--header', 'Accept: application/vnd.github.raw+json'], { signal, binary: true });
        bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      } else return { ok: false, path: result.path, size_bytes: result.size, error: { code: 'FILE_TOO_LARGE', message: 'GitHub 未提供文件内容或文件超过 10 MiB 命令缓冲限制；请选择更小文件。' } };
      const text = bytes.toString('utf8');
      const truncated = bytes.length > FILE_READ_LIMIT;
      return { ok: true, path: result.path, sha: result.sha, size_bytes: result.size, encoding: 'utf8',
        content: truncated ? utf8Prefix(text, FILE_READ_LIMIT) : text,
        file_truncated: truncated, ...(truncated ? { file_truncation_notice: '文件超过 200 KiB，只读取内容前 200 KiB；最终脚本输出另受 64 KiB 总上限约束。' } : {}),
        ...(bytes.includes(0) ? { notice: '内容包含 NUL，可能是二进制；此脚本仅提供 UTF-8 文本视图。' } : {}) };
    },
    async gh_workflow_dispatch(args, signal) {
      if (args.inputs !== undefined && Object.keys(args.inputs).length > 25) invalid('inputs 最多 25 项。');
      if (Buffer.byteLength(JSON.stringify(args.inputs ?? {})) > 65535) invalid('inputs 的 JSON 不可超过 65535 bytes。');
      await api(`${repoPath(args)}/actions/workflows/${encodeURIComponent(args.workflow)}/dispatches`, { method: 'POST', signal, body: { ref: args.ref, inputs: args.inputs ?? {} } });
      return { ok: true, workflow: args.workflow, ref: args.ref, notice: 'dispatch 请求已接受；GitHub 不返回 run ID，用 gh_run_list 查询后续运行。' };
    },
  };
  return specifications.map(([toolName, description, parameters]) => ({
    name: toolName, description, parameters,
    async execute(args, exec = {}) {
      const mutating = ['gh_run_rerun', 'gh_run_cancel', 'gh_workflow_dispatch'].includes(toolName) || (toolName === 'gh_repo_file' && args?.op === 'write');
      // This gate precedes schema validation, command creation and even reads.
      if (mutating && args?.confirm !== true) return denyWrite(toolName);
      let commandStarted = false;
      try {
        validate(parameters, args);
        validateRepo(args);
        if (args.branch !== undefined) validateRef(args.branch, 'branch');
        if (args.ref !== undefined) validateRef(args.ref);
        if (args.workflow !== undefined) validateWorkflow(args.workflow);
        // Validate operation-specific values in the handler; only a command
        // failure may be uncertain, validation errors are definitely not writes.
        commandStarted = true;
        return capOutput(await handlers[toolName](args, exec.signal));
      } catch (error) {
        return capOutput({ ok: false, error: mapGhError(error, mutating && commandStarted) });
      }
    },
  }));
}
