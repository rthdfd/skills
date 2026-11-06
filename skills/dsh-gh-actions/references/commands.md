# 操作参考

公共参数：`owner`、`repo` 必填；IDs 为正安全整数。所有示例从 skill 目录执行，或改用脚本绝对路径。

| 操作 | 参数（公共参数外） | 返回/限制 |
|---|---|---|
| `run-list` | `branch?`、`status?`、`workflow?`、`limit?`（1–100，默认20） | id/workflow/branch/event/status/conclusion/duration_seconds/head_sha；耗时按 startedAt→updatedAt 估算 |
| `run-view` | `run_id` | run → jobs → steps，含名称、结论、起止、耗时 |
| `failures` | `run_id` | 失败步骤、最多60条 error_lines、hint_files、短 log_excerpt |
| `rerun` | `run_id`、`failed_only?`、`confirm:true` | 全部或仅失败 jobs 重跑 |
| `cancel` | `run_id`、`confirm:true` | 请求取消，然后只读核对 |
| `artifacts` | `run_id`、`page?`（默认1）、`per_page?`（1–100，默认100） | ID/名称/大小/过期时间、next_page；不自动遍历全部页 |
| `download` | `artifact_id`、`directory`（容器绝对路径） | 指定 ID 的原始 ZIP；上限10MiB，不解压，不覆盖 |
| `file` | `op:read/list/write`、`path`、`ref?` | list 根目录 path=""；read 返回 SHA 和截断文本 |
| `file` 写入额外参数 | `content`（UTF-8字符串）、`message`、`sha?`、`confirm:true` | PUT contents；更新要传读出的 SHA，创建时省略；ref 为目标 branch |
| `dispatch` | `workflow`（文件名或ID）、`ref`、`inputs?`（字符串映射）、`confirm:true` | workflow_dispatch；不承诺或伪造 run ID |

## 查询与排障

```bash
node scripts/gh.mjs run-list '{"owner":"cli","repo":"cli","status":"failure","limit":5}'
node scripts/gh.mjs run-view '{"owner":"cli","repo":"cli","run_id":41730497368}'
node scripts/gh.mjs failures '{"owner":"cli","repo":"cli","run_id":41730497368}'
node scripts/gh.mjs file '{"owner":"cli","repo":"cli","op":"list","path":".github/workflows"}'
node scripts/gh.mjs file '{"owner":"cli","repo":"cli","op":"read","path":"README.md","ref":"trunk"}'
node scripts/gh.mjs artifacts '{"owner":"cli","repo":"cli","run_id":41730497368}'
```

示例 run 可能随时间过期，应优先选当前可读的失败 run；零 jobs 的失败不一定有日志。

失败规则：`error:`、`::error::`（含带 file/line 的 annotation 格式）、`##[error]`、`FAILED/FAIL`、非零退出码、AssertionError、pytest assert、Expected/Received/Actual 等。规则会有假阳性；必须读上下文确认。错误行累计上限60，每行最多2KiB，每组 excerpt 最多6KiB。ANSI 被清理，文件线索最多30个。日志过期/超缓冲保留步骤结构，并返回 `log_error`。

## 写操作

以下仅示例；必须先取得用户针对该目标和内容的确认，不能把示例视作授权。

```bash
node scripts/gh.mjs rerun '{"owner":"OWNER","repo":"REPO","run_id":123,"failed_only":true,"confirm":true}'
node scripts/gh.mjs cancel '{"owner":"OWNER","repo":"REPO","run_id":123,"confirm":true}'
node scripts/gh.mjs dispatch '{"owner":"OWNER","repo":"REPO","workflow":"ci.yml","ref":"main","inputs":{"mode":"test"},"confirm":true}'
node scripts/gh.mjs file --args-file /absolute/prepared-request.json
```

请求文件示例（用写工具创建，不把不可信 content 拼进 shell）：

```json
{
  "owner": "OWNER",
  "repo": "REPO",
  "op": "write",
  "path": ".github/workflows/ci.yml",
  "ref": "fix-ci",
  "sha": "此前 read 返回的真实 blob SHA",
  "message": "Fix CI configuration",
  "content": "用户已审阅的完整新内容\n",
  "confirm": true
}
```

内容会编码为 base64，用 gh api `--input -` 的 JSON stdin 提交。不会解释 `@file`，不会 clone，不自动创建分支，SHA 冲突时先重新读取，禁止盲重试。

## 宿主缓存说明

本宿主的 gh 是 Go 程序，不能按容器路径访问缓存。辅助脚本创建容器内 `/tmp/dsh-gh-actions-cache`，并在存在 `DSHA_GH_HOST_ROOT` 时，把 `XDG_CACHE_HOME` 指向其宿主可见映射。认证不变，CA 显式传入，缓存由 gh 自己管理；skill 不读取认证配置。

若必须手工使用原生 `--log-failed`，先创建该容器缓存目录，并把 XDG_CACHE_HOME 映射到宿主对应路径；不改系统 HOME，不把缓存写到 Android 共享存储。一般直接用 `failures` 辅助命令即可。

CLI 成功 exit 0，业务错误 exit 1，缺确认 exit 2；stdout 为一行有效 JSON，大小含末尾换行不超过64KiB。单次操作可能包含多个 gh 命令，每个独立限时60s。
