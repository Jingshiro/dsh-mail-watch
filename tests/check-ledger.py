#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回归检查：出站账本的落点与「写不进去也不许静默」这两条。

跑法（在插件根目录）：
    python tests/check-ledger.py

覆盖：
  1. 主账本可写        → outbox=ledger，且**不碰**工作区 spool
  2. 主账本写不进去    → outbox=spool，记录落在工作区 spool 里，stdout 有提示
  3. --json 模式       → 落点如实上报，不许只回 {"ok": true}
  4. 发信失败（SMTP 连不上）→ 退出码非 0，且失败记录同样要落账
  5. 未知子命令        → 退出码非 0（打错命令不能算成功）

「主账本写不进去」用**把 outbox.jsonl 占成目录**来模拟：Windows 上
open(path, "a") 会 Errno 13，与 workspace-write 沙盒拦下时的现象一致。
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(os.path.dirname(HERE), "py")
ENV = dict(os.environ)
ENV["PYTHONIOENCODING"] = "utf-8"
ENV.pop("MAILWATCH_HOME", None)

FAILS = []


def check(name, cond, extra=""):
    print(("ok   " if cond else "FAIL ") + name + (("  " + str(extra)) if extra else ""))
    if not cond:
        FAILS.append(name)


def make_cfg(root, workspace):
    cfg = {
        "imap": {"host": "imap.example.com", "port": 993, "user": "nobody@example.com", "password": "x"},
        "smtp": {"host": "127.0.0.1", "port": 1, "tls": "ssl"},  # 必然连不上：顺便测失败路径
        "identity": {"displayName": "", "signature": ""},
        "delivery": {"workspacePath": workspace},
    }
    path = os.path.join(root, "config.json")
    io.open(path, "w", encoding="utf-8").write(json.dumps(cfg, ensure_ascii=False, indent=2))
    return path


def run(args):
    p = subprocess.run([sys.executable] + args, capture_output=True, env=ENV)
    return p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")


def last_json(text):
    rows = [l for l in text.split("\n") if l.strip().startswith("{")]
    return json.loads(rows[-1]) if rows else None


def main():
    root = tempfile.mkdtemp(prefix="mailwatch-ledger-")
    ws = os.path.join(root, "ws")
    os.makedirs(ws)
    cfg_path = make_cfg(root, ws)
    body = os.path.join(root, "body.txt")
    io.open(body, "w", encoding="utf-8").write("账本回归检查正文\n")
    spool = os.path.join(ws, ".dsh", "mail-watch", "outbox-spool.jsonl")
    ledger = os.path.join(root, "outbox.jsonl")
    lines = lambda p: len([l for l in io.open(p, encoding="utf-8").read().split("\n") if l.strip()])

    try:
        # 1) 主账本可写：必须落 ledger，且不许顺手写 spool
        rc, out, _err = run([os.path.join(PY, "mail_agent.py"), "send", "a@example.invalid", "正常落账",
                             "--body-file", body, "--json", "--config", cfg_path])
        j = last_json(out)
        check("主账本可写 → outbox=ledger", j and j.get("outbox") == "ledger", out.strip()[-120:])
        check("主账本可写 → 不碰 spool", not os.path.exists(spool))
        check("主账本可写 → 账本有 1 行", os.path.exists(ledger) and lines(ledger) == 1)

        # 2) 主账本写不进去（占成目录）：补录 spool + 大声提示 + 退出码非 0
        os.remove(ledger)
        os.makedirs(ledger)
        for script in ("mail_agent.py", "send_files.py"):
            if os.path.exists(spool):
                os.remove(spool)
            args = [os.path.join(PY, script)]
            if script == "mail_agent.py":
                args.append("send")
            args += ["a@example.invalid", "补录 " + script, "--body-file", body, "--config", cfg_path]
            rc, out, _err = run(args)
            check(script + " 发送失败 → 退出码非 0", rc != 0, rc)
            check(script + " 主账本写不进去 → stdout 有 [outbox] 提示", "[outbox]" in out)
            check(script + " 补录 spool 恰好 1 行", os.path.exists(spool) and lines(spool) == 1)
            if os.path.exists(spool):
                rec = json.loads(io.open(spool, encoding="utf-8").read().split("\n")[0])
                check(script + " 补录行保留了失败原因", bool(rec.get("error")), rec.get("error"))

        # 3) --json 模式如实上报落点
        if os.path.exists(spool):
            os.remove(spool)
        rc, out, _err = run([os.path.join(PY, "mail_agent.py"), "send", "a@example.invalid", "json 落点",
                             "--body-file", body, "--json", "--config", cfg_path])
        j = last_json(out)
        check("--json 上报 outbox=spool", j and j.get("outbox") == "spool", out.strip()[-120:])

        # 4) 未知子命令必须非 0（打错命令却回「成功」= 静默成功）
        rc, _out, _err = run([os.path.join(PY, "mail_agent.py"), "no-such-command", "--config", cfg_path])
        check("未知子命令 → 退出码非 0", rc != 0, rc)
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print("\n== " + (("%d 项失败: " % len(FAILS)) + ", ".join(FAILS) if FAILS else "全部通过") + " ==")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
