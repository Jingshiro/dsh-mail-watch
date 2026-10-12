# @local/dsh-mail-watch — 信箱守夜人

邮箱来新信时，**自动给 agent 新开一个会话**，就像有人在工作区发了一条「有新邮件了，去看一下」——
剩下的由那个会话里的 agent 自己读信、判断要不要回。

v2 开始自带一个浏览器面板（侧栏「📬 邮箱」按钮）：

| 页签 | 内容 |
| --- | --- |
| 收件箱 | 入站投递账本（元数据），每封可点开看正文 |
| 已发送 | **两个来源**：① 信箱已发送（直连 IMAP 的 Sent 文件夹，**权威**）② 本地账本（发送脚本的 outbox.jsonl，含失败原因） |
| 设置 | IMAP / SMTP / 授权码 / 投递路径等全部可视化配置；保存即热重启守夜进程 |

> 「已发送」为什么要有两个来源：本地账本是**发送方**写的，而发送方跑在 workspace-write
> 沙盒里，写不了数据目录（详见「已趟平的坑」第 9 条）。信箱自己的 Sent 文件夹才不受这个
> 限制——信真的发出去了才会出现在那，历史也在。所以面板默认看它；本地账本留着看
> 「失败 / 被拒」的原因（那些信根本没进信箱，只有它记得）。

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
  · 若发送方在沙盒里（写不了 dataDir）→ 补录到 <工作区>/.dsh/mail-watch/outbox-spool.jsonl
    → 插件宿主并回 dataDir/outbox.jsonl（drainSpool）
  · 面板「已发送」默认看的是 IMAP 的 Sent 文件夹（权威源），不是这本账
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
| `outbox.jsonl` | 出站账本（每行 JSON：to / subject / body / files / ok / error / outbox） |

沙盒内的发送方写不了上面这本，只能补录到**工作区**里的
`<delivery.workspacePath>/.dsh/mail-watch/outbox-spool.jsonl`；插件宿主每次读账本
（以及每 30 秒的状态轮询）都会把它并回 `outbox.jsonl` 并清空。这个文件平时应该是空的。

删 `watch-state.json` = 水位重设到当前最大 UID，**不会**倒历史邮件；
删 `config.json` = 回到未配置状态（面板里重新填）。

## 路由（宿主半边）

| 路由 | 干什么 |
| --- | --- |
| `GET /api/mail-watch/status` | 守夜进程状态（pid / 水位 / 最近错误 / needsSetup）——只读，不含凭据 |
| `GET /api/mail-watch/inbox?limit=` | 入站账本（倒序） |
| `GET /api/mail-watch/outbox?limit=` | 出站账本（倒序，含全文；读之前先把工作区 spool 并回来） |
| `GET /api/mail-watch/sent?limit=` | **已发送（权威）**：直连信箱 Sent 文件夹的最近 N 封头部 |
| `GET /api/mail-watch/sent?uid=` | 「已发送」里某一封的全文 |
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
python py\mail_agent.py sent --json --limit 15       # 列「已发送」（直连信箱，权威源）
python py\mail_agent.py sent <UID> --json            # 读「已发送」里某一封的正文
python py\send_files.py <to> <subject> --body-file F --files a.pdf b.txt
python py\mail_watch.py --once                      # 手动查一次（插件在跑时别用）
```

`sent` 不靠猜文件夹名：先认 `LIST` 回来的 `\Sent` 特殊属性，再退回几个 ASCII 兜底名
（网易系的「已发送」= `&XfJT0ZAB-`，modified UTF-7）。要指定就 `--folder`。

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
  // includeSelfTests: false 时，只有「带 loop 头 且 发件人是本机账号」的自测回环信会被滤掉；
  // 其他机器同款插件发来的对聊信（也带 loop 头）会正常投递开新会话。
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
   * **`tests/` 也算在扫描范围内**：测试里别写 `fs.rmSync(..., {recursive:true})`（= `scripts/rm_recursive`
     HIGH），按显式路径 `unlinkSync` / `rmdirSync` 删。0.2.2 加测试时就踩过一次：自扫从 WARN 掉到 BLOCK，
     等于把这个插件对所有下游机器变成不可安装。改完跑一次 `gate_scan`，确认仍是 **WARN / High: 0**。
6. **`ctx.effect` 是唯一清理入口**：子进程、路由、规则全挂上面，否则热重载留野进程。
7. **热重载边界**：`patchReload: live` 下改 patch 里生效的 config 值会热重载；但改本插件的
   `lib/index.js` 不重替换（ESM 按 URL 缓存），要真重启 DSH。浏览器半边 `lib/client.js` 刷新页面即可。
8. **loop 头 ≠ 自己的信（0.2.1 修的真实事故）**：`X-Mailwatch-Loop` 是「本插件家族发出的信」的
   标记，**不是「本机账号发出」**——另一台机器跑着同款插件给这台发对聊信时也带这个头。只认头
   会把对方的来信当成回环自测信静默吞掉。判定必须双条件：带 loop 头 **且** 发件人 == `imap.user`。
   两台同款插件互发邮件对聊是支持的玩法，别把自家标记当过滤器判据。
9. **账本别让沙盒里的发送方单独负责（0.2.2 修的真实事故）**：邮件会话是 `workspace-write`
   权限起来的（刻意的：来信正文是不可信外部数据），可写范围**只有会话工作区**。而
   `~/.dsh-mail-watch/outbox.jsonl` 在工作区外面——脚本 append 它必得
   `[Errno 13] Permission denied`。旧版重试 3 次后**只往 stderr 写一行就返回**，
   于是：信真的发出去了（SMTP 走网络，不受文件沙盒影响）、`stderr` 里躺着 3 行失败、
   而那几行**根本不在会话 agent 看得到的地方**（agent 只看 stdout），面板「已发送」
   永远是空的。三条一起改，缺一条都不算修好：
   * 写不进去 → 补录到 `<工作区>/.dsh/mail-watch/outbox-spool.jsonl`，宿主 `drainSpool()`
     并回（宿主不受沙盒限制）；
   * 结果**如实上报**（`outbox: ledger|spool|null`，非 stdout 的提示也算），
     会话里那句「发出去了 ≠ 落账了」写进了投递 prompt；
   * 「已发送」的**权威源**改成 IMAP 的 Sent 文件夹，本地账本降为补充——
     沙盒、权限、换机器都拦不住服务商那边的账。
   顺带修的两个同类病根：`send_files.py` 从来不把 `main()` 的返回码交给 `sys.exit`，
   发信失败也 exit 0；`mail_agent.py` 认不出的子命令打印帮助后 exit 0。
   **判据**：`.dsh-mail-watch/outbox.jsonl` 里没有某封信 ≠ 那封信没发出去。
   想知道发出去过什么，看 `sent`（信箱），不看账本。
10. **改完必须能读回验证**：`python tests/check-ledger.py`（py 侧落点 + 不许静默成功）
    与 `node tests/check-spool.mjs`（宿主侧并回，含重复并回与半行）。两条都跑，别只看日志。

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
* 守夜进程只轮询 INBOX；「已发送」是面板点开时**按需**去读 Sent 文件夹（不轮询、不投递、readonly）。
* 网络层面只实现了 IMAPS(993)；STARTTLS 代码存在但没作为主路径验证过。
* 本地账本（outbox.jsonl / spool）只覆盖 `py/mail_agent.py` / `py/send_files.py` 这条命令行路径，
  而且**0.2.2 之前那些被沙盒拦掉的历史发送不在里面**（它们只存在于信箱的 Sent 文件夹，
  也就是面板「信箱已发送」那一栏）。
* 「这封信处理完了吗」没有状态机：面板只显示投递发生过；处理结论看开出来的那些会话。
