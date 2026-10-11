#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""信箱守夜人 — 常驻轮询 IMAP，有新信就往 stdout 打一行 JSON。

给 DSH 宿主插件 @local/dsh-mail-watch 当子进程用；也可以单独跑着玩。

用法:
  python mail_watch.py --once                      # 只查一次就退出（调试）
  python mail_watch.py --watch --interval 45       # 常驻，每 45 秒查一次
  python mail_watch.py --watch --state <路径>       # 指定水位文件
  python mail_watch.py --config <路径>             # 指定 config.json（默认 ~/.dsh-mail-watch/config.json）

stdout 每行一个 JSON（写完立即 flush，父进程按行读）:
  {"type":"ready","mailbox":"...","lastUid":N,"uidValidity":V}
  {"type":"mail","items":[{"uid":N,"from":"...","subject":"...","date":"...","self":false}]}
  {"type":"uidvalidity","old":V,"new":V,"lastUid":N}
  {"type":"error","message":"..."}
  {"type":"bye"}

水位(state 文件)里存 uidValidity + lastUid：只报「比上次见过的最大 UID 更新」的信。
第一次跑(没有 state 文件)会把水位设到当前最大值，**不**把历史邮件一次性倒出来。

IMAP 细节：
* UID 可能是十亿级大数(163 实测 17915529xx)，绝不能 range 枚举——用 `UID SEARCH UID n:*`
  并对结果再过滤一次 > last(`n` 大于全部 UID 时 RFC 语义会回最后一封)。
* 只 FETCH 头部(PEEK)，不改变信件的已读状态。
"""
import argparse
import email
import email.policy
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import mail_agent as M  # 连接/ID hack/搜头全部复用

MAX_ITEMS_PER_TICK = 20


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_state(path):
    """读水位。不存在 → 空；读不了 → 报一声再当空处理(宁可重设水位也不静默丢信)。
    utf-8-sig 容忍 BOM(PowerShell 写的 UTF8 带 BOM)。"""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception as e:
        emit({"type": "error", "message": "state file unreadable (%s: %s) — re-watermarking; "
             "mail that arrived in between may be missed" % (type(e).__name__, e)})
        return {}


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def uid_validity(mail):
    typ, data = mail.status("INBOX", "(UIDVALIDITY)")
    raw = data[0].decode("utf-8", "replace")
    return int(raw.split("UIDVALIDITY")[1].strip().split(")")[0].strip())


def new_uids(mail, last):
    return [u for u in M.uid_search(mail, "UID %d:*" % (last + 1)) if u > last]


def max_uid(mail):
    uids = M.uid_search(mail, "ALL")
    return uids[0] if uids else 0


class Watcher:
    def __init__(self, cfg, cfg_path, state_path, interval):
        self.cfg = cfg
        self.cfg_path = cfg_path
        self.state_path = state_path
        self.interval = interval
        self.mail = None
        self.state = load_state(state_path)
        self.mailbox = cfg["imap"]["user"]
        self.backoff = 5

    def connect(self):
        if self.mail is not None:
            try:
                self.mail.logout()
            except Exception:
                pass
            self.mail = None
        m = M.imap_connect(self.cfg)
        m.select("INBOX")
        self.mail = m
        self.backoff = 5

    def poll(self):
        """查一次；返回 True 表示这轮有新信。"""
        if self.mail is None:
            self.connect()
        mail = self.mail
        v = uid_validity(mail)
        if self.state.get("uidValidity") != v:
            old = self.state.get("uidValidity")
            top = max_uid(mail)
            self.state = {"uidValidity": v, "lastUid": top, "updatedAt": time.time()}
            save_state(self.state_path, self.state)
            emit({"type": "uidvalidity", "old": old, "new": v, "lastUid": top})
            return False
        last = int(self.state.get("lastUid") or 0)
        pending = new_uids(mail, last)
        if not pending:
            return False
        items = []
        for uid in pending[:MAX_ITEMS_PER_TICK]:
            h = M.fetch_header_fields(mail, uid)
            if h is not None:
                items.append(h)
        new_last = max([i["uid"] for i in items] or pending)
        self.state = {"uidValidity": v, "lastUid": new_last,
                      "updatedAt": time.time(), "lastMailAt": time.time()}
        save_state(self.state_path, self.state)
        if items:
            emit({"type": "mail", "items": items})
            return True
        return False

    def run(self, once=False):
        if self.state.get("uidValidity") is None:
            # 首次运行：水位设到当前最大 UID，不倒历史邮件
            self.connect()
            v = uid_validity(self.mail)
            top = max_uid(self.mail)
            self.state = {"uidValidity": v, "lastUid": top, "updatedAt": time.time()}
            save_state(self.state_path, self.state)
            emit({"type": "ready", "mailbox": self.mailbox, "lastUid": top,
                  "uidValidity": v, "note": "first run: watermark set to current max UID"})
        else:
            if self.mail is None:
                self.connect()
            emit({"type": "ready", "mailbox": self.mailbox,
                  "lastUid": int(self.state.get("lastUid") or 0),
                  "uidValidity": self.state.get("uidValidity")})
        if once:
            try:
                self.poll()
            except Exception as e:
                emit({"type": "error", "message": "%s: %s" % (type(e).__name__, e)})
            emit({"type": "bye"})
            return
        while True:
            try:
                self.poll()
                time.sleep(self.interval)
            except KeyboardInterrupt:
                break
            except Exception as e:
                emit({"type": "error", "message": "%s: %s" % (type(e).__name__, e)})
                try:
                    if self.mail is not None:
                        self.mail.logout()
                except Exception:
                    pass
                self.mail = None
                time.sleep(self.backoff)
                self.backoff = min(self.backoff * 2, 60)
        emit({"type": "bye"})


def main():
    import mail_agent as MA
    ap = argparse.ArgumentParser()
    ap.add_argument("--watch", action="store_true")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval", type=int, default=45)
    ap.add_argument("--state", default=os.path.join(MA.default_home(), "watch-state.json"))
    ap.add_argument("--config", default=None)
    args = ap.parse_args()
    if not (args.watch or args.once):
        ap.print_help()
        return 0
    try:
        cfg, cfg_path = MA.load_config(args.config)
    except Exception as e:
        # 结构化一行给父进程收（插件会把它显示成面板上的「最近错误」），
        # 而不是丢一坨 traceback 到 stderr。
        emit({"type": "error", "message": "config 读取失败：%s: %s" % (type(e).__name__, e)})
        return 2
    w = Watcher(cfg, cfg_path, args.state, max(10, args.interval))
    w.run(once=args.once)
    return 0


if __name__ == "__main__":
    sys.exit(main())
