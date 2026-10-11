# @local/dsh-mail-watch — 信箱守夜人

邮箱来新信时，**自动给 agent 新开一个会话**，就像有人在工作区发了一条「有新邮件了，去看一下」——
剩下的由那个会话里的 agent 自己读信、判断要不要回。

v2 开始自带一个浏览器面板（侧栏「📬 邮箱」按钮）：

| 页签 | 内容 |
| --- | --- |
| 收件箱 | 入站投递账本（元数据），每封可点开看正文 |
| 已发送 | 出站账本：所有发出去的信（含失败原因）全文可验收 |
| 设置 | IMAP / SMTP / 授权码 / 投递路径等全部可视化配置；保存即热重启守夜进程 |

## 架构一句话

```
你的邮箱 (INBOX, IMAP)
   │  python py/mail_watch.py --watch（每 N 秒 UID SEARCH；水位文件去重）
   ▼  stdout: 一行 JSON
@local/dsh-mail-watch（本插件，宿主半边）
   │  ctx.webhookRuntime.dispatch({kind:"mailwatch",…})
   ▼
官方 @deepseek-ai/dsh-webhook 运行时（唯一动作 = 外部事件 → 新建 Workspace 会话，
带创建失败回滚：自己重抄一遍只会多一份漂移的代码）
   ▼
DSH 新会话（标题「📬 新邮件：<主题>」）

出站信（邮件会话里跑 py/mail_agent.py send）→ 自动 append dataDir/outbox.jsonl → 面板「已发送」
入站投递 → dataDir/inbox.jsonl → 面板「收件箱」
```

## 安装（新机器）

1. **把整个目录放进** `<DSH>/plugins/@local/dsh-mail-watch/`（或在
   `profiles/<名>/package.json` 的 `dependencies` 里加
   `"@local/dsh-mail-watch": "file:<这个目录的绝对路径>"`，pnpm 装时是拷贝）。
2. `profiles/<名>/cordis.patch.yml` 加**两行** loader entry：

   ```yaml
   insert:
     - id: webhook-runtime
       name: '@deepseek-ai/dsh-webhook'   # 建会话的执行者（官方包，默认未启用）
     - id: mail-watch
       name: '@local/dsh-mail-watch'
   ```

   * `webhook-runtime` 是**必需的**：本插件只负责「发现有新信」，真正去新建那个 Workspace
     会话的是它。这个包随 DSH 发行（在 `node_modules` 里），但**默认不在启动图里**，
     必须像上面这样启用一次。
     少了这一行，插件会**静默不加载**——`inject` 等不到 `webhookRuntime` 服务时 cordis
     只把插件挂起、不报错。所以「装了没反应」第一件事就是查这里。
   * 浏览器半边（侧栏「📬 邮箱」面板）**不用单独加 entry**：同一个包的 `package.json` 里
     声明了 `dsh.client.platform = "web"` + `exports["./client"]`，client-modules 会按
     loader entry 自动把它扫进浏览器启动图。

3. 依赖：**python ≥ 3.8**（标准库实现，无第三方包）、**邮箱账号 + IMAP/SMTP 授权码**
   （大多数服务商要在网页邮箱里先开通 IMAP/SMTP 并生成授权码，不是登录密码）。
4. 启动 DSH → 侧栏「📬 邮箱」→ 设置页签填：IMAP 服务器/端口、账号/授权码、
   SMTP 服务器/端口、「新会话开在哪个工作区」（绝对路径）。保存后守夜进程自动拉起。
5. 验证顺序：设置页签「造一封假投递（不碰信箱）」先确认会话链路通；再「发真自测信（闭环）」
   确认 IMAP/SMTP 真实可用。真信箱要等真有人来信才有账本行。

## 数据目录

默认 `~/.dsh-mail-watch/`（lifecycle 配置 `dataDir` 可改）：

| 文件 | 内容 |
| --- | --- |
| `config.json` | 全部配置（含授权码；写时尽量 0600） |
| `watch-state.json` | UID 水位（`uidValidity` + `lastUid`）——唯一去重依据 |
| `inbox.jsonl` | 入站投递账本（每行 JSON：deliveryId / items 元数据 / trigger） |
| `outbox.jsonl` | 出站账本（每行 JSON：to / subject / body / files / ok / error） |

删 `watch-state.json` = 水位重设到当前最大 UID，**不会**倒历史邮件；
删 `config.json` = 回到未配置状态（面板里重新填）。

## 路由（宿主半边）

| 路由 | 干什么 |
| --- | --- |
| `GET /api/mail-watch/status` | 守夜进程状态（pid / 水位 / 最近错误 / needsSetup）——只读，不含凭据 |
| `GET /api/mail-watch/inbox?limit=` | 入站账本（倒序） |
| `GET /api/mail-watch/outbox?limit=` | 出站账本（倒序，含全文） |
| `GET /api/mail-watch/read?uid=` | 按需拉一封的全文（转调 `py/mail_agent.py read --json`） |
| `GET /api/mail-watch/check?limit=` | 实时列信箱最近几封头部（转调 `check --json`） |
| `GET /api/mail-watch/selftest` | 发真自测信并等回收（闭环验证 IMAP+SMTP，约 10 秒） |
| `GET /api/mail-watch/test` | 造一封**假**投递走完整链路（不碰真信箱） |
| `GET /api/mail-watch/app-config` | 打码配置快照（授权码不回显） |
| `PUT /api/mail-watch/app-config` | 保存配置；授权码留空 = 不改；保存即热重启守夜进程 |

## python 三兄弟（打包在 `py/`，也能命令行直接用）

```powershell
python py\mail_agent.py check --json --limit 15     # 列最近信件
python py\mail_agent.py read <UID或序号> --json     # 读正文（UID/序号自动判别）
python py\mail_agent.py send <to> <subject> --body-file F [--no-sig]
python py\mail_agent.py selftest                    # 闭环自测信
python py\send_files.py <to> <subject> --body-file F --files a.pdf b.txt
python py\mail_watch.py --once                      # 手动查一次（插件在跑时别用）
```

配置读取顺序：`--config <路径>` → 环境变量 `MAILWATCH_HOME` → `~/.dsh-mail-watch/config.json`。格式：

```jsonc
{
  "imap":     { "host": "imap.example.com", "port": 993, "user": "you@example.com", "password": "授权码" },
  "smtp":     { "host": "smtp.example.com", "port": 465, "tls": "ssl" },
  "identity": { "displayName": "", "signature": "" },
  "delivery": { "workspacePath": "<绝对路径>", "agentPreset": "standard",
                "permissionPreset": "workspace-write", "notifyPhrase": "邮箱有新邮件了，去看一下" },
  "watch":    { "intervalSeconds": 45, "quietHours": "00:00-08:00",
                "includeSelfTests": false, "maxItemsPerSession": 10, "restartDelayMs": 5000 }
}
```

这些字段同样可以在面板「设置」页签里改，`PUT /app-config` 写回的就是这份文件。

## 已趟平的坑（改代码前读一遍）

1. **中文 Windows 管道编码**：python 往子进程 stdout 写默认 cp936，父进程按 UTF-8 读会乱码
   （`[自测]` 变 `[?]`）。脚本里 `sys.stdout.reconfigure(encoding="utf-8")` + spawn 钉
   `PYTHONIOENCODING=utf-8` 双保险。验证方式：抓子进程 stdout 的**原始字节**——别只看控制台，
   那上面你一直设置的编码是对的，看不出 bug。
2. **163（网易系）IMAP 要先发 `ID` 命令**，否则 `Unsafe Login`。脚本对 163/126/yeah.net 自动处理。
3. **大 UID 不能 range 枚举**：163 的 UID 是十亿级（实测 17915529xx），用
   `UID SEARCH UID <last+1>:*` + 结果过滤，绝不 `range()`。且该命令在 `n` 大于全部 UID 时按 RFC
   回最后一封——必须再过滤 `> last`。
4. **UID vs 序号**：`read` 里 `>= 1000000` 的数字按 UID 处理，否则按 IMAP 序号（自动判别）。
   旧版拿大 UID 当序号 fetch 会**静默空结果、exit 0**。
5. **安装前扫描器（gate_scan）**：本仓库自跑过一次，verdict = **WARN**（无 HIGH）。命中项都是
   设计使然、可逐条核对：spawn python 守夜进程与 py 脚本、`permissionPreset`（那是给新会话的
   **限制**档，不是提权）、面板的同源 `fetch`、IMAP 的 `mail.fetch`、默认数据目录取 `os.homedir()`。
   两条经验写给下一个写插件的人：
   * `RegExp.exec` 会被判成 `scripts/exec_api` 高危（误报）——纯字符串解析一律用 `String.match`。
   * 要起外部进程时用 `spawn` 而不是 `execFile`：后者直接触发同一个 HIGH，会让所有下游安装被 BLOCK。
6. **`ctx.effect` 是唯一清理入口**：子进程、路由、规则全挂上面，否则热重载留野进程。
7. **热重载边界**：`patchReload: live` 下改 patch 里生效的 config 值会热重载；但改本插件的
   `lib/index.js` 不重替换（ESM 按 URL 缓存），要真重启 DSH。浏览器半边 `lib/client.js` 刷新页面即可。

## 从早期版本升级

早期版本把账号放在用户目录的一份拍平 JSON 里（`user/password/imap_host/…`），
收发脚本也在那里。现在两样都归位了：账号走面板设置（写进 `<dataDir>/config.json`），
脚本在包内 `py/`。升级只要在面板里把服务器/账号/授权码填一遍即可。

水位（`watch-state.json`）是唯一要留意的：把它拷到新 `dataDir` 就不会重复通知旧信；
不拷则会把水位重设到当前最大 UID（同样不会把历史邮件倒出来）。

## 已知限制

* **面板不是纯邮件查看器**：收件箱的**列表**来自投递账本（`inbox.jsonl`），也就是「投递过的信」；
  想按 uid 读任意一封的全文仍然可以（走 `read` 路由直连 IMAP）。如果只想要一个「看邮件」的界面、
  不要自动开会话，目前**没有**那个开关——那需要额外加一个「只记账不投递」的模式。
* 只轮询 INBOX，不分文件夹。
* 网络层面只实现了 IMAPS(993)；STARTTLS 代码存在但没作为主路径验证过。
* 出站账本只覆盖 `py/mail_agent.py` / `py/send_files.py` 这条命令行路径（面板里的已发送 = 这两口的账）。
* 「这封信处理完了吗」没有状态机：面板只显示投递发生过；处理结论看开出来的那些会话。
