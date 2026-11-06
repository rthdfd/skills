#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capOutput, createOperations } from '../lib/index.js';

export const aliases = {
  'run-list': 'gh_run_list', 'run-view': 'gh_run_view', failures: 'gh_run_failures',
  rerun: 'gh_run_rerun', cancel: 'gh_run_cancel', artifacts: 'gh_run_artifacts',
  download: 'gh_artifact_download', file: 'gh_repo_file', dispatch: 'gh_workflow_dispatch',
};
const help = '用法：node scripts/gh.mjs <run-list|run-view|failures|rerun|cancel|artifacts|download|file|dispatch> \'{"owner":"cli","repo":"cli",...}\'\n或：node scripts/gh.mjs <操作> --args-file /absolute/request.json\n写操作必须取得用户针对本次操作的确认，并传 confirm:true。';

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--help' || !argv.length) { console.log(help); return 0; }
  const operation = aliases[argv[0]];
  let result;
  try {
    if (!operation) throw new Error('不支持该操作；用 --help 查看范围。');
    let input;
    if (argv.length === 3 && argv[1] === '--args-file') {
      const path = resolve(argv[2]);
      if (!path.endsWith('.json') || /(?:^|\/)(?:\.config|\.ssh|credentials|hosts\.yml)(?:\/|$)/.test(path) || path.startsWith('/root/.dsh/')) throw new Error('参数文件必须是普通 .json 文件，不读取凭据或 DSH 配置目录。');
      input = await readFile(path, 'utf8');
    } else if (argv.length === 2) input = argv[1];
    else throw new Error('必须提供一个 JSON 对象或 --args-file 参数。');
    if (Buffer.byteLength(input) > 6 * 1024 * 1024) throw new Error('参数 JSON 不可超过 6 MiB。');
    const args = JSON.parse(input);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try { result = await createOperations().find((item) => item.name === operation).execute(args, { signal: controller.signal }); }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  } catch (error) { result = { ok: false, error: { code: 'INVALID_ARGS', message: error.message } }; }
  const payload = JSON.stringify(capOutput(result));
  process.stdout.write(payload + '\n');
  return result.ok ? 0 : result.error?.code === 'CONFIRM_REQUIRED' ? 2 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) process.exitCode = await main();
