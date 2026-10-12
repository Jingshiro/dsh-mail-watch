#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""带附件的发信 —— mail_agent.send 的附件版，落同一本 outbox 账本。

用法:
  python send_files.py <to> <subject> --body-file F --files A.pdf B.txt [--in-reply-to ID] [--references ID]
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import mail_agent as MA


def main():
    argv = sys.argv[1:]
    if not argv:
        print(__doc__)
        return 2
    # 约定：最前面两个位置参数是 <to> <subject>，其余全是选项(选项的值都以选项键定位)。
    to, subject = argv[0], argv[1]
    rest = argv[2:]

    opt = {}
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--files":
            vals = []
            i += 1
            while i < len(rest) and not rest[i].startswith("--"):
                vals.append(rest[i])
                i += 1
            opt["--files"] = vals
            continue
        if a in ("--body-file", "--in-reply-to", "--references", "--config"):
            if i + 1 >= len(rest):
                print("option %s needs a value" % a)
                return 2
            opt[a] = rest[i + 1]
            i += 2
            continue
        i += 1

    try:
        cfg, cfg_path = MA.load_config(opt.get("--config"))
    except Exception as e:
        print("ERROR: config 读取失败：%s: %s" % (type(e).__name__, e), file=sys.stderr)
        return 2

    body_path = opt.get("--body-file")
    if body_path:
        with open(body_path, "r", encoding="utf-8") as f:
            body = f.read()
    else:
        body = sys.stdin.read()

    files = opt.get("--files") or []
    rec = {"via": "send_files", "ok": False, "to": to, "subject": subject, "body": body,
           "files": [os.path.basename(p) for p in files], "error": None}
    try:
        msg, user = MA.build_message(cfg, to, subject, body, files=files,
                                     in_reply_to=opt.get("--in-reply-to"),
                                     references=opt.get("--references"),
                                     append_sig=False)
        refused = MA.smtp_send(cfg, msg, user, [to])
        if refused:
            rec["error"] = "refused: %s" % refused
            rec["outbox"] = MA.append_outbox(cfg_path, rec, cfg)
            print("REFUSED: %s" % refused)
            MA._report_ledger(rec["outbox"])
            return 1
        rec["ok"] = True
        rec["outbox"] = MA.append_outbox(cfg_path, rec, cfg)
        print("OK: sent to %s | subject=%r | files=%s" % (to, subject, rec["files"]))
        MA._report_ledger(rec["outbox"])
        return 0
    except Exception as e:
        rec["error"] = "%s: %s" % (type(e).__name__, e)
        rec["outbox"] = MA.append_outbox(cfg_path, rec, cfg)
        print("ERROR: %s" % rec["error"])
        MA._report_ledger(rec["outbox"])
        return 1


if __name__ == "__main__":
    # 必须把返回码交出去：旧版直接 `main()`，发信失败也 exit 0，
    # 调用方（会话里的 agent）据此以为成功了——和 outbox 那事同一个病根。
    sys.exit(main())
