// 回归检查：宿主侧把沙盒会话补录的出站账并回主账本（drainSpool）。
//
// 跑法（在插件根目录）：
//     node tests/check-spool.mjs
//
// 覆盖：没有 spool / 正常并回并清空 / 重复并回不产生重复行（模拟「append 完但
// 清空前崩了」）/ 半行丢弃 / 主账本写不进去时留在 spool 等下次。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drainSpool, spoolFileFor } from "../lib/index.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mailwatch-spool-"));
const dataDir = path.join(root, "data");
const ws = path.join(root, "ws");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
const ledger = path.join(dataDir, "outbox.jsonl");
const spool = spoolFileFor(ws);

const fails = [];
const check = (name, cond, extra) => {
  console.log((cond ? "ok   " : "FAIL ") + name + (extra ? "  " + extra : ""));
  if (!cond) fails.push(name);
};
const lines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf-8").split("\n").filter(Boolean) : []);

// spool 路径必须和 py 侧 SPOOL_RELATIVE 一致——两边对不上就等于账丢了
check("spool 路径 = <工作区>/.dsh/mail-watch/outbox-spool.jsonl",
  spool === path.join(ws, ".dsh", "mail-watch", "outbox-spool.jsonl"), spool);

let r = drainSpool(dataDir, ws);
check("没有 spool → moved 0", r.moved === 0 && r.pending === 0, JSON.stringify(r));

const a = JSON.stringify({ via: "send", ok: true, to: "a@x", subject: "A", body: "aa", at: "2026-10-12T15:49:46" });
const b = JSON.stringify({ via: "send_files", ok: false, to: "b@x", subject: "B", body: "bb", error: "refused" });
fs.mkdirSync(path.dirname(spool), { recursive: true });
fs.writeFileSync(spool, a + "\n" + b + "\n", "utf-8");
r = drainSpool(dataDir, ws);
check("并回 2 行", r.moved === 2 && r.pending === 0, JSON.stringify(r));
check("主账本有 2 行", lines(ledger).length === 2, String(lines(ledger).length));
check("spool 被清空", fs.readFileSync(spool, "utf-8") === "");

fs.writeFileSync(spool, a + "\n" + b + "\n", "utf-8");
r = drainSpool(dataDir, ws);
check("重复并回不落重复行", lines(ledger).length === 2 && r.moved === 0,
  JSON.stringify(r) + " lines=" + lines(ledger).length);

const c = JSON.stringify({ via: "send", ok: true, to: "c@x", subject: "C", body: "cc" });
fs.writeFileSync(spool, '{"broken": \n' + c + "\n", "utf-8");
r = drainSpool(dataDir, ws);
check("半行丢弃、正常行并回", r.moved === 1 && r.dropped === 1 && lines(ledger).length === 3, JSON.stringify(r));

const dataDir2 = path.join(root, "data2");
fs.mkdirSync(dataDir2, { recursive: true });
fs.mkdirSync(path.join(dataDir2, "outbox.jsonl")); // 目录占位：append 必失败
fs.writeFileSync(spool, c + "\n", "utf-8");
r = drainSpool(dataDir2, ws);
check("主账本写不进去 → 留在 spool 等下次", r.moved === 0 && r.pending === 1 && lines(spool).length === 1,
  JSON.stringify(r));

// 清理：**显式按路径删**，不用递归删除——安装前扫描器把 fs.rmSync({recursive:true})
// 判成 HIGH，而本仓库自扫必须保持无 HIGH（否则下游所有安装都会被 BLOCK）。
const dispose = (p) => {
  try { fs.unlinkSync(p); return; } catch { /* 可能是目录 */ }
  try { fs.rmdirSync(p); } catch { /* 已经没了 */ }
};
[
  path.join(dataDir, "outbox.jsonl"),
  path.join(dataDir2, "outbox.jsonl"),
  spool,
  path.join(ws, ".dsh", "mail-watch"),
  path.join(ws, ".dsh"),
  ws,
  dataDir2,
  dataDir,
  root,
].forEach(dispose);
console.log("\n== " + (fails.length ? fails.length + " 项失败: " + fails.join(", ") : "全部通过") + " ==");
process.exit(fails.length ? 1 : 0);
