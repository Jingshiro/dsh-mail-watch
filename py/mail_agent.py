#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通用 IMAP/SMTP 收发爪子 — 给 @local/dsh-mail-watch 当子模块，也能单独跑。

用法:
  python mail_agent.py check [--all] [--json] [--limit N]   # 从最新往前列信(默认只列 15 封)
  python mail_agent.py read <seq_or_uid> [--json]           # 读一封信的头部+正文
  python mail_agent.py send <to> <subject> [--body-file F] [--no-sig] [--json]
  python mail_agent.py selftest                              # 发一封闭环自测信(带 loop 头,守夜进程认得并拦截)

配置: `$MAILWATCH_HOME/config.json`，默认 `~/.dsh-mail-watch/config.json`，也可 `--config <路径>`。
格式(JSON):
  {
    "imap":     {"host": "imap.example.com", "port": 993, "user": "you@example.com", "password": "..."},
    "smtp":     {"host": "smtp.example.com", "port": 465},
    "identity": {"displayName": "", "signature": ""}
  }
兼容旧版顶层拍平格式(user / password / imap_host / smtp_host …)，读入时自动折叠成上面的结构。

所有出站信(成功与失败)都会 append 到所在目录的 `outbox.jsonl`，一行一条 JSON ——
给邮件面板当「已发送」账本，也方便人工验收。
"""
import os
import sys
import json
import time
import email
import email.policy
import imaplib
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr, make_msgid, parseaddr

# 中文 Windows 上 python 往管道写 stdout 默认 cp936，父进程(Node)按 UTF-8 读会乱码；
# 这里钉死 UTF-8，不依赖父进程给不给 PYTHONIOENCODING。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

LOOP_HEADERS = ("X-Mailwatch-Loop",)  # 自认的回环标记：守夜进程认得它，不为自测信开新会话


def default_home():
    env = os.environ.get("MAILWATCH_HOME")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), ".dsh-mail-watch")


def home_for(cfg_path):
    return os.path.dirname(os.path.abspath(cfg_path))


def outbox_path(cfg_path):
    return os.path.join(home_for(cfg_path), "outbox.jsonl")


def load_config(path=None):
    path = path or os.path.join(default_home(), "config.json")
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    # 兼容旧版顶层拍平格式 → 折叠成嵌套结构（字段名通用，只是形状不同）
    if "imap" not in cfg and "user" in cfg:
        cfg["imap"] = {
            "host": cfg.get("imap_host") or "",
            "port": int(cfg.get("imap_port") or 993),
            "user": cfg["user"],
            "password": cfg["password"],
        }
        cfg["smtp"] = {
            "host": cfg.get("smtp_host") or "",
            "port": int(cfg.get("smtp_port") or 465),
        }
        cfg.setdefault("identity", {})
    imap = cfg.get("imap") or {}
    if not imap.get("host") or not imap.get("user") or not imap.get("password"):
        raise RuntimeError("config.json 还没有配置完整：需要 imap.host + imap.user + imap.password")
    cfg.setdefault("smtp", {"host": str(imap.get("host") or "").replace("imap.", "smtp.", 1), "port": 465})
    cfg.setdefault("identity", {})
    return cfg, path


def append_outbox(cfg_path, rec):
    """出站账本：成功与失败都落一行，一行一条 JSON。"""
    rec = dict(rec)
    rec.setdefault("at", time.strftime("%Y-%m-%dT%H:%M:%S"))
    for attempt in range(3):
        try:
            with open(outbox_path(cfg_path), "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            return
        except Exception as e:
            sys.stderr.write("[outbox] append failed (attempt %s): %s\n" % (attempt + 1, e))
            time.sleep(0.2)


def netease_style_id_hack(m):
    """部分国内服务商(163/126/yeah)要求客户端先发 IMAP ID，否则报 Unsafe Login 或断连。"""
    imaplib.Commands["ID"] = ("AUTH", "NONAUTH", "SELECT", "LOGIN")
    try:
        m._simple_command(
            "ID", '("name" "dsh-mail-watch" "version" "1.0" "vendor" "dsh")'
        )
    except Exception as e:
        print("[note] ID command not accepted: %s" % e)


def needs_id_hack(host):
    h = str(host or "").lower()
    return any(dom in h for dom in ("163.com", "126.com", "yeah.net"))


def imap_connect(cfg):
    im = cfg["imap"]
    m = imaplib.IMAP4_SSL(im["host"], int(im.get("port") or 993))
    if needs_id_hack(im["host"]):
        netease_style_id_hack(m)
    m.login(im["user"], im["password"])
    return m


def is_self_mail(msg, own_user=None):
    """自测/回环信判定。

    v2.1 修正：loop 头在 ≠ 自己的信。X-Mailwatch-Loop 是「同款插件发出」的标记，
    但别的机器跑着同一个插件给咱们发对接信时，头里也带着它——那不是回环，是正经来信，
    静默滤掉它就是漏信（2026-10-11 candyliujx 初次见面那封就是这么被吞的）。

    所以 self 必须同时满足：带 loop 头 AND 发件人 == 本机账号。
    own_user 给不出时退回旧行为（只认头），仅当兜底。
    """
    if str(msg.get("X-Mailwatch-Loop") or "").strip() != "1":
        return False
    if own_user:
        try:
            from_addr = parseaddr(str(msg.get("From") or ""))[1].lower()
        except Exception:
            from_addr = ""
        return from_addr == str(own_user).strip().lower()
    return True


def read_message(mail, selector):
    """selector 为纯数字：>= 1000000 视作 UID(163 的 UID 是十亿级大数)，
    否则视作 IMAP 序号。很多教程会踩「拿大 UID 当序号 fetch」的坑——静默空结果。"""
    n = int(str(selector).strip())
    if n >= 1000000:
        raw = _fetch_raw(mail, uid=n)
    else:
        raw = _fetch_raw(mail, seq=n)
    if raw is None:
        raise RuntimeError("mailbox 里找不到信 %s" % n)
    return email.message_from_bytes(raw, policy=email.policy.default)


def _fetch_raw(mail, uid=None, seq=None):
    if uid is not None:
        typ, data = mail.uid("FETCH", str(uid), "(BODY.PEEK[])")
    else:
        typ, data = mail.fetch(str(seq), "(BODY.PEEK[])")
    for part in data:
        if isinstance(part, tuple):
            return part[1]
    return None


def _decode_part(part):
    try:
        return part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b""
        try:
            return payload.decode(part.get_content_charset() or "utf-8", "replace")
        except Exception:
            return payload.decode("utf-8", "replace")


def find_text(msg):
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                return _decode_part(part)
    else:
        if msg.get_content_type().startswith("text/"):
            return _decode_part(msg)
    return None


def header_summary(msg, uid=None, own_user=None):
    return {
        "uid": uid,
        "from": str(msg.get("From") or "").strip(),
        "to": str(msg.get("To") or "").strip(),
        "subject": str(msg.get("Subject") or "").strip(),
        "date": str(msg.get("Date") or "").strip(),
        "self": is_self_mail(msg, own_user),
    }


def uid_search(mail, criteria="ALL"):
    typ, data = mail.uid("SEARCH", criteria)
    return sorted([int(t) for t in data[0].split() if t.isdigit()], reverse=True)


def fetch_header_fields(mail, uid, own_user=None):
    typ, data = mail.uid(
        "FETCH", str(uid),
        "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE X-Mailwatch-Loop)])")
    raw = None
    for part in data:
        if isinstance(part, tuple):
            raw = part[1]
    if raw is None:
        return None
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    return {
        "uid": uid,
        "from": str(msg.get("From") or "").strip()[:200],
        "subject": str(msg.get("Subject") or "").strip()[:200],
        "date": str(msg.get("Date") or "").strip()[:80],
        "self": is_self_mail(msg, own_user),
    }


# ──────────────────────────────── 命令 ────────────────────────────────

def fail(msg, as_json=False, code=1):
    """统一的失败出口：给面板/父进程一个结构化 JSON，而不是一坨 traceback。"""
    if as_json:
        print(json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False))
    else:
        print("ERROR: %s" % msg, file=sys.stderr)
    return code


def cmd_check(cfg, cfg_path, show_all=False, as_json=False, limit=None):
    try:
        mail = imap_connect(cfg)
        try:
            mail.select("INBOX")
            uids = uid_search(mail)
            cap = limit or (30 if show_all else 15)
            items = []
            for uid in uids[:cap]:
                h = fetch_header_fields(mail, uid, own_user=cfg["imap"]["user"])
                if h is not None:
                    items.append(h)
        finally:
            try:
                mail.logout()
            except Exception:
                pass
    except Exception as e:
        return fail("%s: %s" % (type(e).__name__, e), as_json)
    if as_json:
        print(json.dumps({"ok": True, "mailbox": cfg["imap"]["user"], "items": items},
                         ensure_ascii=False))
    else:
        for it in items:
            marker = "  <self>" if it["self"] else ""
            print("[%s] %s%s" % (it["uid"], it["date"], marker))
            print("  From: %s" % it["from"])
            print("  Subject: %s" % it["subject"])
        print("--- listed %d (most recent first)" % len(items))
    return 0


def cmd_read(cfg, cfg_path, selector, as_json=False):
    try:
        mail = imap_connect(cfg)
        try:
            mail.select("INBOX")
            msg = read_message(mail, selector)
        finally:
            try:
                mail.logout()
            except Exception:
                pass
    except Exception as e:
        return fail("%s: %s" % (type(e).__name__, e), as_json)
    try:
        n = int(str(selector).strip())
    except ValueError:
        n = None
    item = header_summary(msg, uid=n if n is not None and n >= 1000000 else None,
                          own_user=cfg["imap"]["user"])
    item["body"] = find_text(msg)
    if as_json:
        print(json.dumps({"ok": True, "item": item}, ensure_ascii=False))
    else:
        print("From: %s" % msg.get("From"))
        print("To: %s" % msg.get("To"))
        print("Subject: %s" % msg.get("Subject"))
        print("Date: %s" % msg.get("Date"))
        print("---")
        print(item["body"] if item["body"] is not None else "(no text body; attachments only)")
    return 0


def build_message(cfg, to, subject, body, files=None, in_reply_to=None, references=None,
                  append_sig=True):
    ident = cfg.get("identity") or {}
    user = cfg["imap"]["user"]
    domain = user.split("@")[-1] if "@" in user else "localhost"
    from_name = ident.get("displayName") or ""
    sig = (ident.get("signature") or "").strip("\n")

    if files:
        from email.message import EmailMessage
        msg = EmailMessage()
    else:
        msg = MIMEMultipart()

    msg["From"] = formataddr((from_name, user))
    msg["To"] = formataddr((parseaddr(to)[0] or to, to))
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=domain)
    msg["X-Mailwatch-Loop"] = "1"  # 自己发出的信带此头；守夜进程据此不惊动会话
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = references

    text = body.rstrip("\n")
    if append_sig and sig:
        text = text + "\n" + sig
    if files:
        mimes = {
            ".docx": ("application", "vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ".doc": ("application", "msword"),
            ".xlsx": ("application", "vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            ".xls": ("application", "vnd.ms-excel"),
            ".pptx": ("application", "vnd.openxmlformats-officedocument.presentationml.presentation"),
            ".pdf": ("application", "pdf"),
            ".zip": ("application", "zip"),
            ".csv": ("text", "csv"),
        }
        msg.set_content(text)
        for p in files:
            fn = os.path.basename(p)
            ext = os.path.splitext(fn)[1].lower()
            maintype, subtype = mimes.get(ext, ("application", "octet-stream"))
            with open(p, "rb") as f:
                msg.add_attachment(f.read(), maintype=maintype, subtype=subtype, filename=fn)
    else:
        msg.attach(MIMEText(text, "plain", "utf-8"))
    return msg, user


def smtp_send(cfg, message, from_user, recipients):
    smtp_cfg = cfg.get("smtp") or {}
    host = smtp_cfg.get("host")
    port = int(smtp_cfg.get("port") or 465)
    if str(smtp_cfg.get("tls") or "ssl").lower() == "starttls":
        s = smtplib.SMTP(host, port, timeout=30)
        s.ehlo()
        s.starttls()
        s.ehlo()
    else:
        s = smtplib.SMTP_SSL(host, port, timeout=30)
    s.login(cfg["imap"]["user"], cfg["imap"]["password"])
    refused = s.sendmail(from_user, recipients, message.as_string())
    s.quit()
    return refused


def cmd_send(cfg, cfg_path, to, subject, body, append_sig=True, as_json=False):
    rec = {"via": "send", "ok": False, "to": to, "subject": subject, "body": body,
           "files": [], "error": None}
    try:
        msg, user = build_message(cfg, to, subject, body, append_sig=append_sig)
        refused = smtp_send(cfg, msg, user, [to])
        if refused:
            rec["error"] = "refused: %s" % refused
            append_outbox(cfg_path, rec)
            if as_json:
                print(json.dumps({"ok": False, "error": rec["error"]}, ensure_ascii=False))
            else:
                print("REFUSED: %s" % refused)
            return 1
        rec["ok"] = True
        append_outbox(cfg_path, rec)
        if as_json:
            print(json.dumps({"ok": True}, ensure_ascii=False))
        else:
            print("OK: sent to %s, subject=%r" % (to, subject))
        return 0
    except Exception as e:
        rec["error"] = "%s: %s" % (type(e).__name__, e)
        append_outbox(cfg_path, rec)
        if as_json:
            print(json.dumps({"ok": False, "error": rec["error"]}, ensure_ascii=False))
        else:
            print("ERROR: %s" % rec["error"], file=sys.stderr)
        return 1


def cmd_selftest(cfg, cfg_path, as_json=False):
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    user = cfg["imap"]["user"]
    subject = "【自测】邮件链路闭环 " + stamp
    body = ("闭环自测信\n时间: %s\n\n"
            "这是 dsh-mail-watch 发给自己的信，验证 SMTP 发送 + IMAP 回收。\n"
            "信里带 loop 头，守夜进程认得它，不会为它惊动新会话。\n" % stamp)
    rec = {"via": "selftest", "ok": False, "to": user, "subject": subject, "body": body,
           "files": [], "error": None}
    try:
        msg, from_user = build_message(cfg, user, subject, body, append_sig=False)
        refused = smtp_send(cfg, msg, from_user, [user])
        if refused:
            rec["error"] = "refused: %s" % refused
            append_outbox(cfg_path, rec)
            if as_json:
                print(json.dumps({"ok": False, "error": rec["error"]}, ensure_ascii=False))
            else:
                print("REFUSED: %s" % refused)
            return 1
        rec["ok"] = True
        append_outbox(cfg_path, rec)
    except Exception as e:
        rec["error"] = "%s: %s" % (type(e).__name__, e)
        append_outbox(cfg_path, rec)
        if as_json:
            print(json.dumps({"ok": False, "error": rec["error"]}, ensure_ascii=False))
        else:
            print("ERROR: %s" % rec["error"])
        return 1

    sys.stdout.write("OK: selftest sent; waiting 8s for delivery...\n")
    sys.stdout.flush()
    time.sleep(8)
    try:
        mail = imap_connect(cfg)
    except Exception as e:
        return fail("信已发出，但回收时连不上信箱：%s: %s" % (type(e).__name__, e), as_json)
    try:
        mail.select("INBOX")
        uids = uid_search(mail)
        head = uids[:50]
        for uid in head:
            h = fetch_header_fields(mail, uid, own_user=cfg["imap"]["user"])
            if h is None:
                continue
            if stamp in (h["subject"] or ""):
                if as_json:
                    print(json.dumps({"ok": True, "loop": True, "uid": uid, "subject": h["subject"]},
                                     ensure_ascii=False))
                else:
                    print("LOOP CLOSED: found self-test mail at uid %s (%s)" % (uid, h["subject"]))
                return 0
        note = "not found in last %d mails — retry check later" % len(head)
        if as_json:
            print(json.dumps({"ok": True, "loop": False, "note": note}, ensure_ascii=False))
        else:
            print("LOOP NOT CLOSED yet: %s" % note)
        return 2
    finally:
        try:
            mail.logout()
        except Exception:
            pass


def parse_argv(argv):
    """手写小解析：位置参数收进 list，--config/--limit/--body-file 吃一个值，
    --json/--all/--no-sig 是布尔。argparse 的 known/unknown 拆分会把这些全拆散，
    手写反而最稳。"""
    flags = {}
    positional = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--config", "--limit", "--body-file"):
            if i + 1 >= len(argv):
                raise SystemExit("option %s needs a value" % a)
            flags[a] = argv[i + 1]
            i += 2
        elif a in ("--json", "--all", "--no-sig"):
            flags[a] = True
            i += 1
        else:
            positional.append(a)
            i += 1
    return flags, positional


def main():
    argv = sys.argv[1:]
    if not argv or any(a in ("-h", "--help") for a in argv):
        print(__doc__)
        return 0
    # 先剥选项再取命令：这样 `--config X check --json` 和 `check --json --config X`
    # 都能跑（旧写法把命令钉在 argv[0]，选项放前面会静默打印帮助、exit 0）。
    flags, positional = parse_argv(argv)
    cmd = positional[0] if positional else ""
    rest = positional[1:]
    as_json = bool(flags.get("--json"))

    try:
        cfg, cfg_path = load_config(flags.get("--config"))
    except Exception as e:
        return fail("config 读取失败：%s: %s" % (type(e).__name__, e), as_json, 2)

    if cmd == "check":
        limit = int(flags["--limit"]) if "--limit" in flags else None
        return cmd_check(cfg, cfg_path, show_all=bool(flags.get("--all")), as_json=as_json, limit=limit)
    if cmd == "read":
        if not rest:
            return fail("read 需要 <seq_or_uid>", as_json, 2)
        return cmd_read(cfg, cfg_path, rest[0], as_json=as_json)
    if cmd == "send":
        if len(rest) < 2:
            return fail("send 需要 <to> <subject>", as_json, 2)
        if "--body-file" in flags:
            with open(flags["--body-file"], "r", encoding="utf-8") as f:
                body = f.read()
        else:
            body = sys.stdin.read()
        return cmd_send(cfg, cfg_path, rest[0], rest[1], body,
                        append_sig=bool(flags.get("--no-sig")) is False, as_json=as_json)
    if cmd == "selftest":
        return cmd_selftest(cfg, cfg_path, as_json=as_json)
    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
