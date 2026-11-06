# Skills

我的 AI 助手 skill 合集。每个 skill 独立存放，按需加载指南和资源，避免把全部说明常驻上下文。

## 目录

| Skill | 用途 | 环境 |
|---|---|---|
| [dsh-gh-actions](<skills/dsh-gh-actions/README.md>) | GitHub Actions 排障、结构化失败证据、免 clone 仓库文件读写 | DeepSeek Harness / DSHA，Android proot Ubuntu，Node 22+，已登录的 gh |

## 组织约定

```text
skills/
  <skill-name>/
    SKILL.md          # 名称、短描述、按需加载的操作指南
    README.md         # 安装、使用、环境与限制
    references/       # 按需查阅的操作参考
    scripts/          # 可选辅助脚本
    test/             # 可选离线自测
```

新增 skill 时建立独立目录，并更新上方目录表。只收录可复用的指南、源码和测试；不提交 token、认证配置、个人运行日志、缓存或本机验收记录。

## 在 DSH 中使用

下载本仓库 ZIP，解压后把需要的 skill 目录放到以下任一位置：

- 用户级：`~/.dsh/skills/<skill-name>/`，可在该 DSH_HOME 下的 profile 中使用。
- 项目级：`<project>/.agents/skills/<skill-name>/`，仅对应项目使用。

例如，在解压后的仓库根目录执行：

```bash
mkdir -p ~/.dsh/skills
cp -R skills/dsh-gh-actions ~/.dsh/skills/
```

若已有同名 skill，先检查内容和来源，不要直接覆盖。随后在 DSH 中说：

> 用 dsh-gh-actions 排查 OWNER/REPO 最近失败的 Actions，不要修改仓库。

各 skill 的依赖、授权要求与平台限制，以其[使用说明](<skills/dsh-gh-actions/README.md>)为准。仓库不会自动安装依赖、执行脚本或开启后台任务。

## 安全边界

Skill 是助手的可复用行为指南，不是系统权限防火墙。涉及远端修改时，必须先取得用户针对本次目标和内容的确认；不要把仓库示例当作授权。

本仓库代码采用 [MIT License](<LICENSE>)。
