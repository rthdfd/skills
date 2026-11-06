# dsh-gh-actions

**DSH skill + 原生 gh**，只解决 GitHub Actions 排障与免 clone 仓库文件操作。不是 Cordis 插件，不注册常驻工具；纯 ESM、Node 内置模块、零运行时依赖、无需构建。

## 能力

- 最近 runs 的分支/workflow/状态筛选与结构化 jobs → steps。
- 失败分析：错误、断言、非零退出码、文件线索和短日志上下文；过滤命令回显，优先呈现 GitHub error annotations。
- 重跑、取消、workflow_dispatch，辅助脚本严格要求 `confirm:true`。
- artifact 分页列表和按 ID 下载 ZIP。
- 免 clone 的文件 read/list/write，更新时使用 blob SHA。

[Skill 指南](<SKILL.md>) · [参数和示例](<references/commands.md>) · [辅助 CLI](<scripts/gh.mjs>)

## 环境

当前实现面向 **Android DSHA 的 proot Ubuntu**，Node 22+、已登录 GitHub CLI：

- 使用 DSHA 托管入口 `/root/dsh-bin/gh`，由它负责代理和认证；不运行裸 gh 二进制。
- 子进程显式带 `SSL_CERT_FILE=/storage/emulated/0/gh-ca.pem`；该 CA 文件需在本机准备好，本仓库不包含证书或凭据。
- Go 的缓存路径需使用宿主可见路径。辅助脚本创建容器内临时缓存，并依据 `DSHA_GH_HOST_ROOT` 设置 `XDG_CACHE_HOME`，使原生 `gh run view --log-failed` 能正常工作。

其他宿主需要先适配入口、CA 和路径映射；不要直接假设这些 Android 路径可用。认证始终交给 gh，不自建 OAuth，不读取或打印 token。

## 安装

下载合集仓库 ZIP，把当前 skill 目录复制到 `~/.dsh/skills/dsh-gh-actions` 或项目的 `.agents/skills/dsh-gh-actions`。已有同名条目时，先检查再更新。

DSH 可按名称 `dsh-gh-actions` 加载。无需 npm install、插件安装或 Web 构建。

## 使用

直接对助手说：

> 用 dsh-gh-actions 帮我排查 OWNER/REPO 最近失败的 Actions，不要修改仓库。

从当前 skill 目录也可直接运行：

```bash
node scripts/gh.mjs run-list '{"owner":"cli","repo":"cli","status":"failure","limit":5}'
node scripts/gh.mjs failures '{"owner":"OWNER","repo":"REPO","run_id":123}'
node scripts/gh.mjs file '{"owner":"OWNER","repo":"REPO","op":"read","path":".github/workflows/ci.yml","ref":"main"}'
```

复杂内容用普通 JSON 请求文件，通过 `--args-file` 输入。所有远端写操作必须先取得用户针对目标和内容的确认，再传严格布尔 `confirm:true`；省略、false、字符串"true"都会在任何 gh 调用之前拒绝。

## 限制与安全

- Skill 是行为指南，不能全局阻止用户手动运行原生 gh；辅助脚本本身有代码确认门，助手不得绕过。
- 子进程只用 execFile 参数数组，单命令60s、缓冲10MiB。输出是有效JSON，含末尾换行不超过64KiB，并标注截断。
- 错误行累计最多60；文件文本先限200KiB，再受整体输出上限约束。无法唯一归因时保留 unknown，日志缺失不代表成功。
- Artifact 下载保存原始 ZIP，不自动解压、不覆盖、不写 Android 共享存储；超过10MiB的 artifact 不下载。
- 超时/取消/写请求错误不自动重试，先只读核对实际状态。错误详情不任意回显 stderr，避免泄漏签名URL。
- 不 clone、不做 GitHub 全家桶、不启动自己的后台轮询、不保存 token。

## 自测

```bash
node --test test/*.test.js
```

20项离线测试涵盖未登录、403、404、限流、网络、超长日志、输入校验、确认门、文件读取和 PUT JSON stdin、dispatch inputs、超时unknown/no_replay、artifact过期与目录拒绝，以及日志误报回归。

```bash
node scripts/verify.mjs CURRENT_FAILURE_RUN_ID
```

只读验证脚本使用公开仓库 `cli/cli`。默认示例run可能随时间过期，应传该仓库当前仍保留日志的失败run ID。脚本验证 runs、失败证据、README、artifacts、404和缺确认的写操作拒绝；不会实际重跑、取消、dispatch或提交文件。

开发时已通过20项离线测试及上述真实只读验证；远端写请求仅模拟测试，ZIP下载网络路径尚未端到端验收。个人日志、本机路径验收记录、缓存和证书不随此skill发布。
