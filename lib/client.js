// @local/dsh-mail-watch 的 client 侧 — 信箱面板（浏览器半边，window.__ModuleLoader__ 打包格式）。
//
// 侧栏「📬 邮箱」按钮 → 原生 overlay 面板，三个页签：
//   收件箱   入站账本（每次投递的元数据）+ 点开看正文（按需走宿主 read 路由）
//   已发送   两个来源：信箱已发送（直连 IMAP 的 Sent 文件夹，权威）/ 本地账本
//            （发送脚本的 outbox.jsonl，含失败原因）
//   设置     IMAP/SMTP/授权码/投递路径等全部可视化配置；保存即热重启守夜进程
//
// 数据全走宿主桥 /api/mail-watch/*（@local/dsh-mail-watch），授权码只在服务端
// config.json 里，浏览器永远拿不到（GET 打码；PUT 留空=不改）。
// 骨架照抄 @local/dsh-ui-ombre——组件一律 h(Comp, props)，别直接调 Comp({...})。
window.__ModuleLoader__.load({
	id: "@local/dsh-mail-watch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { createElement: h, useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } = react;

		// ───────────── 主题 token（与 dsh-ui-ombre 同一清单） ─────────────
		const T = {
			layer1: "var(--dsw-alias-bg-layer-1, #ffffff)",
			layer2: "var(--dsw-alias-bg-layer-2, #f6f7f9)",
			layer3: "var(--dsw-alias-bg-layer-3, #eceef1)",
			mask: "var(--dsw-alias-bg-mask-1, rgba(17,20,24,0.45))",
			bd1: "var(--dsw-alias-border-l1, #e8eaed)",
			bd2: "var(--dsw-alias-border-l2, #dcdfe3)",
			bd3: "var(--dsw-alias-border-l3, #cdd2d8)",
			fg: "var(--dsw-alias-label-primary, #1b1e21)",
			fg2: "var(--dsw-alias-label-secondary, #5b636b)",
			fg3: "var(--dsw-alias-label-tertiary, #8b939b)",
			biz: "var(--dsw-alias-state-business-primary, #3b82f6)",
			ok: "var(--dsw-alias-state-success-primary, #16a34a)",
			warn: "var(--dsw-alias-state-warn-primary, #d97706)",
			err: "var(--dsw-alias-state-error-primary, #dc2626)",
			hover: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04))",
			font: "var(--ds-font-family, system-ui, -apple-system, 'Segoe UI', sans-serif)",
			mono: "var(--ds-font-family-code, ui-monospace, Menlo, Consolas, monospace)"
		};

		// ───────────── 面板开关 ─────────────
		let mailOpen = false;
		const listeners = new Set();
		function subscribe(fn) {
			listeners.add(fn);
			return () => { listeners.delete(fn); };
		}
		function getSnapshot() { return mailOpen; }
		function setOpen(v) { if (mailOpen !== v) { mailOpen = v; listeners.forEach((fn) => fn()); } }

		// ───────────── 图标（Lucide 内联，ISC） ─────────────
		const LUCIDE = {
			// lucide: mail
			mail: [
				["rect", {"width":"20","height":"16","x":"2","y":"4","rx":"2"}],
				["path", {"d":"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"}]
			],
			// lucide: inbox
			inbox: [
				["polyline", {"points":"22 12 16 12 14 15 10 15 8 12 2 12"}],
				["path", {"d":"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}]
			],
			// lucide: send
			send: [
				["path", {"d":"m22 2-7 20-4-9-9-4Z"}],
				["path", {"d":"M22 2 11 13"}]
			],
			// lucide: settings
			settings: [
				["path", {"d":"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"}],
				["circle", {"cx":"12","cy":"12","r":"3"}]
			],
			// lucide: x
			x: [
				["path", {"d":"M18 6 6 18"}],
				["path", {"d":"m6 6 12 12"}]
			],
			// lucide: rotate-cw
			rotate: [
				["path", {"d":"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"}],
				["path", {"d":"M21 3v5h-5"}]
			],
			// lucide: chevron-down
			chevronDown: [
				["path", {"d":"m6 9 6 6 6-6"}]
			],
			// lucide: chevron-right
			chevronRight: [
				["path", {"d":"m9 18 6-6-6-6"}]
			],
			// lucide: flask-conical（自测）
			flask: [
				["path", {"d":"M10 2v7.31"}],
				["path", {"d":"M14 9.3V1.99"}],
				["path", {"d":"M8.5 2h7"}],
				["path", {"d":"M14 9.3a6.5 6.5 0 1 1-4 0"}],
				["path", {"d":"M5.52 16h12.96"}]
			],
			// lucide: zap（假投递）
			zap: [
				["path", {"d":"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"}]
			],
			// lucide: alert-triangle
			alert: [
				["path", {"d":"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"}],
				["path", {"d":"M12 9v4"}],
				["path", {"d":"M12 17h.01"}]
			]
		};

		function Icon(props) {
			const nodes = LUCIDE[props.name] || [];
			return h("svg", {
				width: props.size || 16,
				height: props.size || 16,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: props.strokeWidth || 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false",
				style: Object.assign({ display: "block", flex: "0 0 auto" }, props.style || {})
			}, nodes.map((node, i) => h(node[0], Object.assign({ key: i }, node[1]))));
		}

		// ───────────── 宿主桥访问 ─────────────
		const API = "/api/mail-watch";
		async function apiGet(path) {
			const res = await fetch(API + path, { headers: { accept: "application/json" } });
			let json = null;
			try { json = await res.json(); } catch { /* 非 JSON */ }
			if (!json) throw new Error("HTTP " + res.status + "（宿主桥没有响应）");
			if (json.ok === false) throw new Error(json.error || ("HTTP " + res.status));
			return json;
		}
		async function apiPut(path, body) {
			const res = await fetch(API + path, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			let json = null;
			try { json = await res.json(); } catch { /* 非 JSON */ }
			if (!json) throw new Error("HTTP " + res.status + "（宿主桥没有响应）");
			if (json.ok === false) throw new Error(json.error || ("HTTP " + res.status));
			return json;
		}

		function pad(n) { return String(n).padStart(2, "0"); }
		function fmtD(d) {
			if (!d) return "";
			try {
				const x = d instanceof Date ? d : new Date(d);
				if (isNaN(x.getTime())) return String(d);
				return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
			} catch {
				return String(d);
			}
		}

		// ───────────── 基础组件 ─────────────
		function Button(props) {
			const kind = props.kind || "default";
			const base = {
				cursor: props.disabled ? "default" : "pointer",
				border: "1px solid " + (kind === "primary" ? T.biz : kind === "danger" ? T.err : T.bd2),
				borderRadius: 8,
				padding: "5px 12px",
				font: "500 12.5px/18px " + T.font,
				color: kind === "primary" ? T.biz : kind === "danger" ? T.err : T.fg,
				background: kind === "primary" ? "color-mix(in srgb, " + T.biz + " 10%, transparent)" : T.layer1,
				opacity: props.disabled ? 0.5 : 1
			};
			return h("button", {
				style: Object.assign(base, props.style || {}),
				onClick: props.onClick,
				disabled: props.disabled,
				title: props.title,
				children: props.children
			});
		}

		function Empty(props) {
			return h("div", { style: { textAlign: "center", color: T.fg3, padding: "34px 0", font: "400 12.5px/20px " + T.font } },
				props.children || "暂无数据");
		}

		function Field(props) {
			const labelStyle = { font: "500 12px/18px " + T.font, color: T.fg2, display: "block", marginBottom: 4 };
			const inputStyle = {
				width: "100%", boxSizing: "border-box", border: "1px solid " + T.bd2,
				borderRadius: 8, padding: "6px 10px", font: "400 12.5px/18px " + T.font,
				color: T.fg, background: T.layer1, outline: "none"
			};
			return h("label", { style: { display: "block", flex: props.wide ? "1 1 100%" : "1 1 180px", minWidth: props.wide ? 0 : 150 } },
				h("span", { style: labelStyle }, props.label),
				props.textarea
					? h("textarea", {
						value: props.value, rows: props.rows || 4,
						onChange: (e) => props.onChange(e.target.value),
						placeholder: props.placeholder,
						style: Object.assign({}, inputStyle, { resize: "vertical", font: "400 12px/18px " + T.mono })
					})
					: h("input", {
						type: props.type || "text",
						value: props.value,
						onChange: (e) => props.onChange(e.target.value),
						placeholder: props.placeholder,
						style: inputStyle
					})
			);
		}

		function Notice(props) {
			const tone = props.tone || "warn";
			const color = tone === "err" ? T.err : tone === "ok" ? T.ok : T.warn;
			return h("div", { style: { border: "1px solid " + T.bd2, background: T.layer2, borderRadius: 10, padding: "10px 12px", marginBottom: 12 } },
				h("div", { style: { font: "600 12.5px/19px " + T.font, color, display: "flex", gap: 7, alignItems: "flex-start" } },
					props.icon ? h(Icon, { name: props.icon, size: 14, style: { marginTop: 2, color } }) : null,
					h("span", null, props.title)),
				props.detail ? h("div", { style: { font: "400 11.5px/18px " + T.font, color: T.fg2, marginTop: 4, whiteSpace: "pre-wrap" } }, props.detail) : null,
				props.children ? h("div", { style: { marginTop: 8, display: "flex", gap: 8 } }, props.children) : null
			);
		}

		function SectionTitle(props) {
			return h("div", { style: { font: "600 13px/20px " + T.font, color: T.fg, margin: "16px 0 8px", display: "flex", gap: 7, alignItems: "center" } },
				h(Icon, { name: props.icon, size: 14, style: { color: T.biz } }), props.children);
		}

		// ───────────── 收件箱页签 ─────────────
		function ReadBox(props) {
			if (props.syntheticNote) {
				return h("div", { style: { font: "400 11.5px/18px " + T.font, color: T.fg3, marginTop: 4 } },
					"假投递：信箱里没有这封信（合成 uid），没有正文可读");
			}
			if (props.loading) return h("div", { style: { font: "400 12px/18px " + T.font, color: T.fg3, padding: "6px 0" } }, "正在读取正文…");
			if (props.error) {
				return h("div", { style: { display: "flex", gap: 10, alignItems: "center", marginTop: 4 } },
					h("span", { style: { font: "400 12px/18px " + T.font, color: T.err, whiteSpace: "pre-wrap" } }, props.error),
					props.onRetry ? h(Button, { onClick: props.onRetry, children: "重试" }) : null);
			}
			const item = props.item;
			if (!item) return null;
			return h("div", { style: { border: "1px solid " + T.bd2, borderRadius: 10, padding: "10px 12px", background: T.layer2, marginTop: 6 } },
				h("div", { style: { font: "500 12px/18px " + T.font, color: T.fg2, display: "flex", gap: 10, flexWrap: "wrap" } },
					h("span", null, "From: " + (item.from || "?")),
					h("span", null, item.date || ""),
					item.self ? h("span", { style: { color: T.warn } }, "自测/回环信") : null),
				h("pre", {
					style: {
						margin: "8px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word",
						font: "400 12.5px/19px " + T.font, color: T.fg,
						maxHeight: 340, overflow: "auto"
					}
				}, item.body == null ? "（没有文本正文——可能只有附件）" : item.body));
		}

		function DeliveryRow(props) {
			const d = props.item;
			const [open, setOpen] = useState(false);
			const [readState, setReadState] = useState({}); // uid -> {loading|item|error}
			const reachUid = useCallback((uid) => {
				if (!/^\d+$/.test(String(uid))) return; // 合成 uid（假投递）信箱里没有这封信，读不了
				setReadState((s) => (s[uid]?.loading ? s : { ...s, [uid]: { loading: true } }));
				apiGet("/read?uid=" + encodeURIComponent(uid))
					.then((j) => setReadState((s) => ({ ...s, [uid]: { item: j.item } })))
					.catch((e) => setReadState((s) => ({ ...s, [uid]: { error: String(e.message || e) } })));
			}, []);
			// 展开即自动拉全文：收件箱是给人验收看的，不该再要点一下才出正文。
			useEffect(() => {
				if (!open) return;
				for (const it of d.items || []) {
					if (!readState[it.uid]) reachUid(it.uid);
				}
			}, [open]); // eslint-disable-line react-hooks/exhaustive-deps
			return h("div", { style: { border: "1px solid " + T.bd1, borderRadius: 10, marginBottom: 8, background: T.layer1, overflow: "hidden" } },
				h("div", {
					onClick: () => setOpen(!open),
					style: { display: "flex", gap: 9, alignItems: "center", padding: "9px 12px", cursor: "pointer", userSelect: "none" }
				},
					h(Icon, { name: open ? "chevronDown" : "chevronRight", size: 14, style: { color: T.fg3 } }),
					h("span", { style: { font: "500 12.5px/18px " + T.font, color: T.fg } },
						fmtD(d.at) + " · " + (d.items?.length || 0) + " 封" + (d.trigger === "selftest" ? " · 假投递" : "")),
					h("span", { style: { font: "400 11.5px/18px " + T.font, color: T.fg3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } },
						(d.items || []).map((it) => it.subject || "(无主题)").join(" / ")),
					d.quiet ? h("span", { style: { font: "400 10.5px/16px " + T.font, color: T.warn, border: "1px solid " + T.bd2, borderRadius: 6, padding: "1px 6px" } }, "静默时段") : null
				),
				open ? h("div", { style: { borderTop: "1px solid " + T.bd1, padding: "8px 12px 12px" } },
					(d.items || []).map((it) => h("div", { key: String(it.uid), style: { padding: "6px 0", borderBottom: "1px dashed " + T.bd1 } },
						h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" } },
							h("span", { style: { font: "600 12.5px/18px " + T.font, color: T.fg } }, it.subject || "(无主题)"),
							h("span", { style: { font: "400 11.5px/18px " + T.font, color: T.fg2 } }, it.from || ""),
							h("span", { style: { font: "400 11px/16px " + T.mono, color: T.fg3 } }, "uid=" + it.uid)),
						/^\d+$/.test(String(it.uid)) ? readState[it.uid]
							? h(ReadBox, Object.assign({}, readState[it.uid], {
								onRetry: () => reachUid(it.uid)
							}))
							: h("div", { style: { font: "400 12px/18px " + T.font, color: T.fg3, marginTop: 2 } }, "正在读取正文…")
							: h(ReadBox, { item: null, syntheticNote: true })
					)))
					: null
			);
		}

		function InboxTab(props) {
			const { status, statusErr, inbox, inboxErr, loading, onReload } = props;
			const st = status?.state;
			return h("div", null,
				props.notice,
				h("div", {
					style: { display: "flex", gap: 14, flexWrap: "wrap", font: "400 11.5px/18px " + T.font, color: T.fg2, background: T.layer2, border: "1px solid " + T.bd1, borderRadius: 10, padding: "8px 12px", marginBottom: 12 }
				},
					h("span", null, st?.childPid ? "🟢 守夜进程 pid " + st.childPid : "⚪ 守夜进程未启动"),
					st?.restarts ? h("span", null, "重启 " + st.restarts + " 次") : null,
					status?.quietNow ? h("span", { style: { color: T.warn } }, "静默时段中") : null,
					status?.config?.mailbox ? h("span", null, status.config.mailbox) : null,
					st?.lastError ? h("span", { style: { color: T.err } }, "最近错误: " + st.lastError) : null
				),
				inboxErr ? h(Notice, { tone: "err", title: "取不到账本：" + inboxErr }) : null,
				loading && !inbox ? h(Empty, null, "正在读取投递账本…") :
					(inbox || []).length === 0 ? h(Empty, null, "还没有投递记录（插件装好后来过信才会有）") :
						inbox.map((d, i) => h(DeliveryRow, { key: d.deliveryId || i, item: d }))
			);
		}

		// ───────────── 已发送页签 ─────────────
		// 两个来源，别混着看（2026-10-12 修的事故）：
		//   信箱已发送 = 直连 IMAP 的 Sent 文件夹 —— **权威**：信真的出去了才会在这，
		//                历史也在，跟本机有没有跑插件无关。默认看这个。
		//   本地账本   = 发送脚本写的 outbox.jsonl —— 价值在「失败/被拒」的原因
		//                （那些信根本没进信箱，只有账本记得）。沙盒里发送时脚本写不了
		//                数据目录，会补录到工作区 spool，由插件并回。
		function SentRow(props) {
			const it = props.item;
			const [open, setOpen] = useState(false);
			const [body, setBody] = useState(null); // {loading|item|error}
			const reach = useCallback(() => {
				if (!/^\d+$/.test(String(it.uid))) return;
				setBody((s) => (s?.loading || s?.item ? s : { loading: true }));
				apiGet("/sent?uid=" + encodeURIComponent(it.uid))
					.then((j) => setBody({ item: j.item }))
					.catch((e) => setBody({ error: String(e.message || e) }));
			}, [it.uid]);
			// 展开即自动拉全文（和收件箱一个规矩：验收界面不该再要点一下才出正文）
			useEffect(() => { if (open) reach(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
			return h("div", { style: { border: "1px solid " + T.bd1, borderRadius: 10, marginBottom: 8, background: T.layer1, overflow: "hidden" } },
				h("div", {
					onClick: () => setOpen(!open),
					style: { display: "flex", gap: 9, alignItems: "center", padding: "9px 12px", cursor: "pointer", userSelect: "none" }
				},
					h(Icon, { name: open ? "chevronDown" : "chevronRight", size: 14, style: { color: T.fg3 } }),
					h("span", { style: { font: "500 12.5px/18px " + T.font, color: T.fg, whiteSpace: "nowrap" } }, fmtD(it.date)),
					h("span", { style: { font: "400 11.5px/18px " + T.font, color: T.fg2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } },
						(it.to || "?") + " · " + (it.subject || "(无主题)")),
					h("span", { style: { font: "400 10.5px/16px " + T.mono, color: T.fg3 } }, "uid=" + it.uid)
				),
				open ? h("div", { style: { borderTop: "1px solid " + T.bd1, padding: "10px 14px" } },
					h("div", { style: { font: "400 11.5px/18px " + T.font, color: T.fg2 } }, "收件人: " + (it.to || "")),
					!body ? h("div", { style: { font: "400 12px/18px " + T.font, color: T.fg3, marginTop: 6 } }, "正在读取正文…")
						: body.error ? h("div", { style: { display: "flex", gap: 10, alignItems: "center", marginTop: 6 } },
							h("span", { style: { font: "400 12px/18px " + T.font, color: T.err, whiteSpace: "pre-wrap" } }, body.error),
							h(Button, { onClick: reach, children: "重试" }))
							: h("pre", { style: { margin: "8px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "400 12.5px/19px " + T.font, color: T.fg, maxHeight: 340, overflow: "auto" } },
								body.item?.body == null ? "（没有文本正文——可能只有附件）" : body.item.body)
				) : null
			);
		}

		function OutboxRow(props) {
			const o = props.item;
			const [open, setOpen] = useState(false);
			return h("div", { style: { border: "1px solid " + T.bd1, borderRadius: 10, marginBottom: 8, background: T.layer1, overflow: "hidden" } },
				h("div", {
					onClick: () => setOpen(!open),
					style: { display: "flex", gap: 9, alignItems: "center", padding: "9px 12px", cursor: "pointer", userSelect: "none" }
				},
					h(Icon, { name: open ? "chevronDown" : "chevronRight", size: 14, style: { color: T.fg3 } }),
					h("span", {
						style: {
							width: 8, height: 8, borderRadius: "50%", flex: "0 0 auto",
							background: o.ok ? T.ok : T.err, display: "inline-block"
						},
						title: o.ok ? "发送成功" : ("失败：" + (o.error || ""))
					}),
					h("span", { style: { font: "500 12.5px/18px " + T.font, color: T.fg } }, fmtD(o.at || o.time)),
					h("span", { style: { font: "400 11.5px/18px " + T.font, color: T.fg2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } },
						(o.to || "?") + " · " + (o.subject || "(无主题)") + (o.files && o.files.length ? " · 附件×" + o.files.length : "")),
					h("span", { style: { font: "400 10.5px/16px " + T.font, color: T.fg3 } }, o.via || "send")
				),
				open ? h("div", { style: { borderTop: "1px solid " + T.bd1, padding: "10px 14px" } },
					h("div", { style: { font: "400 11.5px/18px " + T.font, color: T.fg2 } }, "收件人: " + (o.to || "")),
					o.error ? h("div", { style: { font: "400 11.5px/18px " + T.font, color: T.err, marginTop: 4 } }, "失败原因: " + o.error) : null,
					o.outbox && o.outbox !== "ledger" ? h("div", { style: { font: "400 11.5px/18px " + T.font, color: T.warn, marginTop: 4 } },
						"落账点: " + (o.outbox === "spool" ? "工作区 spool（沙盒拦了主账本，插件会并回）" : "没落上（两处都写不进去）")) : null,
					h("pre", { style: { margin: "8px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "400 12.5px/19px " + T.font, color: T.fg } },
						o.body || "(空)")
				) : null
			);
		}

		function OutboxTab(props) {
			const { sent, sentErr, sentFolder, outbox, outboxErr, loading, query, setQuery } = props;
			const [source, setSource] = useState("sent");
			// 宿主半边还没重启（/sent 路由还没上线）时别把人晾在一个报错页上：落到本地账本
			useEffect(() => { if (sentErr && !sent) setSource("ledger"); }, [sentErr, sent]);
			const q = (query || "").trim().toLowerCase();
			const hit = (o) => !q || [o.subject, o.to, o.from, o.body].some((s) => String(s || "").toLowerCase().includes(q));
			const sentList = useMemo(() => (sent || []).filter(hit), [sent, query]);
			const ledgerList = useMemo(() => (outbox || []).filter(hit), [outbox, query]);
			const failed = (outbox || []).filter((o) => !o.ok).length;
			const seg = (id, label) => h("button", {
				onClick: () => setSource(id),
				style: {
					cursor: "pointer", border: "1px solid " + (source === id ? T.biz : T.bd2),
					background: source === id ? "color-mix(in srgb, " + T.biz + " 10%, transparent)" : T.layer1,
					color: source === id ? T.biz : T.fg2, borderRadius: 8, padding: "4px 10px",
					font: "500 12px/18px " + T.font
				}
			}, label);
			return h("div", null,
				props.notice,
				h("div", { style: { display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" } },
					seg("sent", "信箱已发送（权威）" + ((sent || []).length ? " " + sent.length : "")),
					seg("ledger", "本地账本" + ((outbox || []).length ? " " + outbox.length : ""))
				),
				h("div", { style: { font: "400 11px/17px " + T.font, color: T.fg3, marginBottom: 10 } },
					source === "sent"
						? "直连 IMAP 的已发送文件夹" + (sentFolder ? "（" + sentFolder + "）" : "") +
							"：信真的发出去了才会出现在这，历史也在，跟本机插件有没有跑过无关。"
						: "发送脚本写的本地账本：含「失败 / 被拒」的原因（那些信根本没进信箱，只有它记得）。"),
				h("div", { style: { display: "flex", gap: 10, alignItems: "center", marginBottom: 10 } },
					h("input", {
						value: query,
						onChange: (e) => setQuery(e.target.value),
						placeholder: "在已发送里搜（主题 / 收件人 / 正文）",
						style: { flex: 1, border: "1px solid " + T.bd2, borderRadius: 8, padding: "6px 10px", font: "400 12.5px/18px " + T.font, color: T.fg, background: T.layer1, outline: "none" }
					}),
					failed ? h("span", { style: { font: "400 11.5px/18px " + T.font, color: T.err } }, failed + " 条失败") : null
				),
				source === "sent"
					? (sentErr ? h(Notice, { tone: "err", title: "取不到信箱已发送：" + sentErr })
						: loading && !sent ? h(Empty, null, "正在读取信箱已发送…")
							: sentList.length === 0 ? h(Empty, null, q ? "没有匹配的信" : "信箱的已发送是空的")
								: sentList.slice(0, 100).map((m, i) => h(SentRow, { key: String(m.uid || i), item: m })))
					: (outboxErr ? h(Notice, { tone: "err", title: "取不到账本：" + outboxErr })
						: loading && !outbox ? h(Empty, null, "正在读取出站账本…")
							: ledgerList.length === 0 ? h(Empty, null, "本地账本还是空的（只有用 py 发送脚本发的信才会记在这；信箱已发送那栏才是权威）")
								: ledgerList.slice(0, 100).map((o, i) => h(OutboxRow, { key: (o.at || "") + "-" + i, item: o })))
			);
		}

		// ───────────── 设置页签 ─────────────
		function SettingsTab(props) {
			const { cfg, cfgErr, onSaved, onSelftest, onFake, busy } = props;
			const [d, setD] = useState(null); // draft
			const [saving, setSaving] = useState(false);
			const [note, setNote] = useState(null);
			useEffect(() => {
				if (cfg) setD({ ...cfg, imap: { ...cfg.imap }, smtp: { ...cfg.smtp }, identity: { ...cfg.identity }, delivery: { ...cfg.delivery }, watch: { ...cfg.watch } });
			}, [cfg]);
			const upd = (path, v) => setD((s) => {
				const n = { ...s };
				if (path.length === 2) n[path[0]] = { ...n[path[0]], [path[1]]: v };
				else n[path[0]] = v;
				return n;
			});
			if (cfgErr) return h(Notice, { tone: "err", title: "取不到配置：" + cfgErr });
			if (!d) return h(Empty, null, "正在读取配置…");
			const f = (path, label, o = {}) => h(Field, Object.assign({
				label, value: path.reduce((s, k) => (s ? s[k] : ""), d) ?? "",
				onChange: (v) => upd(path, v)
			}, o));
			const save = () => {
				setSaving(true);
				setNote(null);
				apiPut("/app-config", { config: d })
					.then(() => {
						setNote({ ok: true, text: "已保存，守夜进程正在按新配置重启。" });
						onSaved();
					})
					.catch((e) => setNote({ ok: false, text: String(e.message || e) }))
					.finally(() => setSaving(false));
			};
			return h("div", null,
				note ? h(Notice, { tone: note.ok ? "ok" : "err", title: note.text }) : null,
				h(SectionTitle, { icon: "mail" }, "邮箱账号（IMAP）"),
				h("div", { style: { display: "flex", flexWrap: "wrap", gap: 12 } },
					f(["imap", "host"], "IMAP 服务器", { placeholder: "例：imap.gmail.com / imap.163.com" }),
					f(["imap", "port"], "端口（SSL 一般 993）", { type: "number" }),
					f(["imap", "user"], "邮箱账号", { placeholder: "you@example.com" }),
					h(Field, {
						label: props.passwordSet ? "授权码 / 密码（已设置；留空=不改）" : "授权码 / 密码",
						value: d.imap.password || "",
						onChange: (v) => upd(["imap", "password"], v),
						type: "password",
						placeholder: props.passwordSet ? "••••••••" : "IMAP/SMTP 服务授权码",
						wide: true
					})
				),
				h(SectionTitle, { icon: "send" }, "发信（SMTP）"),
				h("div", { style: { display: "flex", flexWrap: "wrap", gap: 12 } },
					f(["smtp", "host"], "SMTP 服务器", { placeholder: "例：smtp.gmail.com / smtp.163.com" }),
					f(["smtp", "port"], "端口（SSL 一般 465）", { type: "number" }),
					f(["smtp", "tls"], "加密方式：ssl / starttls", { placeholder: "ssl" })
				),
				h(SectionTitle, { icon: "settings" }, "身份（发信人显示）"),
				h("div", { style: { display: "flex", flexWrap: "wrap", gap: 12 } },
					f(["identity", "displayName"], "发件人显示名"),
					h(Field, {
						label: "签名（可选，每封信末尾追加）",
						value: d.identity.signature || "",
						onChange: (v) => upd(["identity", "signature"], v),
						rows: 3, textarea: true, wide: true
					})
				),
				h(SectionTitle, { icon: "inbox" }, "新邮件 → 新会话"),
				h("div", { style: { display: "flex", flexWrap: "wrap", gap: 12 } },
					f(["delivery", "workspacePath"], "新会话开在哪个工作区（绝对路径）", { wide: true }),
					f(["delivery", "agentPreset"], "agent preset"),
					f(["delivery", "permissionPreset"], "权限 preset"),
					f(["delivery", "notifyPhrase"], "投递时的口信")
				),
				h(Notice, {
					tone: "warn",
					title: "新会话收到的邮件正文是**不可信外部数据**：权限 preset 只给到「工作区内可写」是刻意的，别在后端把它的上限放开。"
				}),
				h(SectionTitle, { icon: "zap" }, "轮询与静默"),
				h("div", { style: { display: "flex", flexWrap: "wrap", gap: 12 } },
					f(["watch", "intervalSeconds"], "轮询间隔（秒）", { type: "number" }),
					f(["watch", "quietHours"], "静默时段 HH:MM-HH:MM"),
					f(["watch", "maxItemsPerSession"], "每次投递最多几封", { type: "number" }),
					h(Field, {
						label: "投递间隔保留（毫秒）",
						value: d.watch.restartDelayMs,
						onChange: (v) => upd(["watch", "restartDelayMs"], Number(v) || 5000),
						type: "number",
						wide: true
					}),
					h("label", { style: { flex: "1 1 100%", display: "flex", gap: 8, alignItems: "center", font: "400 12.5px/18px " + T.font, color: T.fg2 } },
						h("input", {
							type: "checkbox",
							checked: !!d.watch.includeSelfTests,
							onChange: (e) => upd(["watch", "includeSelfTests"], e.target.checked)
						}),
						"让自测/回环信也走完整链路（平时关着：零食自测信不惊动会话）")
				),
				h("div", { style: { display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" } },
					h(Button, { kind: "primary", onClick: save, disabled: saving, children: saving ? "保存中…" : "保存配置（守夜进程热重启）" }),
					h(Button, { onClick: onSelftest, disabled: busy || !d.imap.user, title: "发一封真实的闭环自测信，验证 IMAP/SMTP 配置", children: busy ? "自测中…" : "发真自测信（闭环）" }),
					h(Button, { onClick: onFake, title: "造一封假信走投递链路，不碰真信箱", children: "造一封假投递（不碰信箱）" })
				),
				h("div", { style: { marginTop: 10, font: "400 11.5px/18px " + T.font, color: T.fg3 } },
					"授权码只存在服务端 config.json（打码显示）；面板每次保存都会重启守夜进程，改完等 ~10 秒再刷新状态。")
			);
		}

		// ───────────── 主面板 ─────────────
		const TABS = [
			{ id: "inbox", label: "收件箱", icon: "inbox" },
			{ id: "outbox", label: "已发送", icon: "send" },
			{ id: "settings", label: "设置", icon: "settings" }
		];

		function MailPanel() {
			const open = useSyncExternalStore(subscribe, getSnapshot);
			const [tab, setTab] = useState("inbox");
			const [status, setStatus] = useState(null);
			const [statusErr, setStatusErr] = useState(null);
			const [inbox, setInbox] = useState(null);
			const [inboxErr, setInboxErr] = useState(null);
			const [outbox, setOutbox] = useState(null);
			const [outboxErr, setOutboxErr] = useState(null);
			const [sent, setSent] = useState(null);
			const [sentErr, setSentErr] = useState(null);
			const [sentFolder, setSentFolder] = useState(null);
			const [cfg, setCfg] = useState(null);
			const [cfgErr, setCfgErr] = useState(null);
			const [query, setQuery] = useState("");
			const [busy, setBusy] = useState(false);
			const [flash, setFlash] = useState(null);

			const loadStatus = useCallback(() => {
				apiGet("/status")
					.then((j) => { setStatus(j); setStatusErr(null); })
					.catch((e) => setStatusErr(String(e.message || e)));
			}, []);
			const loadInbox = useCallback(() => {
				apiGet("/inbox?limit=120")
					.then((j) => { setInbox(j.items); setInboxErr(null); })
					.catch((e) => setInboxErr(String(e.message || e)));
			}, []);
			const loadOutbox = useCallback(() => {
				apiGet("/outbox?limit=200")
					.then((j) => { setOutbox(j.items); setOutboxErr(null); })
					.catch((e) => setOutboxErr(String(e.message || e)));
			}, []);
			// 已发送的权威源：直连 IMAP 的 Sent 文件夹（本地账本另有 loadOutbox）
			const loadSent = useCallback(() => {
				apiGet("/sent?limit=60")
					.then((j) => { setSent(j.items); setSentFolder(j.folder); setSentErr(null); })
					.catch((e) => setSentErr(String(e.message || e)));
			}, []);
			const loadCfg = useCallback(() => {
				apiGet("/app-config")
					.then((j) => { setCfg(j.config); setCfgErr(null); })
					.catch((e) => setCfgErr(String(e.message || e)));
			}, []);

			useEffect(() => {
				if (!open) return undefined;
				loadStatus();
				const t = setInterval(loadStatus, 30000);
				return () => clearInterval(t);
			}, [open, loadStatus]);

			useEffect(() => {
				if (!open) return;
				if (tab === "inbox") loadInbox();
				else if (tab === "outbox") { loadSent(); loadOutbox(); }
				else loadCfg();
			}, [open, tab, loadInbox, loadOutbox, loadSent, loadCfg]);

			useEffect(() => {
				if (!open) return undefined;
				const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [open]);

			if (!open) return null;

			const needsSetup = status?.needsSetup === true;
			const notice = [
				needsSetup ? h(Notice, {
					tone: "warn", icon: "alert",
					title: "还没配置邮箱账号：切到「设置」页签填 IMAP 服务器 / 账号 / 授权码，保存后守夜进程自动拉起。",
					children: [h(Button, { kind: "primary", onClick: () => setTab("settings"), children: "去设置" })]
				}) : null,
				statusErr ? h(Notice, { tone: "err", title: "取不到守夜状态：" + statusErr, children: [h(Button, { onClick: loadStatus, children: "重试" })] }) : null,
				flash ? h(Notice, { tone: flash.ok ? "ok" : "err", title: flash.text }) : null
			];

			let body = null;
			if (tab === "inbox") {
				body = h(InboxTab, { status, statusErr, inbox, inboxErr, loading: true, notice, onReload: () => { loadStatus(); loadInbox(); } });
			} else if (tab === "outbox") {
				body = h(OutboxTab, {
					sent, sentErr, sentFolder, outbox, outboxErr,
					loading: true, query, setQuery, notice
				});
			} else {
				body = h(SettingsTab, {
					cfg, cfgErr,
					passwordSet: !!cfg?.imap?.passwordSet,
					onSaved: () => { loadStatus(); loadCfg(); },
					busy,
					onSelftest: () => {
						setBusy(true);
						setFlash(null);
						apiGet("/selftest")
							.then((j) => {
								const r = j.result || {};
								setFlash(r.ok && r.loop
									? { ok: true, text: "闭环成功：自测信已发出并已回收（uid " + r.uid + "）。" }
									: { ok: false, text: "自测发出但没等到回收：" + (r.note || r.error || "稍后用 check 再看") });
							})
							.catch((e) => setFlash({ ok: false, text: String(e.message || e) }))
							.finally(() => setBusy(false));
					},
					onFake: () => {
						setBusy(true);
						setFlash(null);
						apiGet("/test")
							.then((j) => setFlash({ ok: true, text: "假投递已完成：" + JSON.stringify(j.delivery || {}), }))
							.catch((e) => setFlash({ ok: false, text: String(e.message || e) }))
							.finally(() => setBusy(false));
					}
				});
			}

			return h("div", {
				onClick: (e) => { if (e.target === e.currentTarget) setOpen(false); },
				style: {
					position: "absolute", inset: 0, zIndex: 30, display: "flex",
					alignItems: "center", justifyContent: "center", padding: 20,
					background: T.mask
				}
			},
				h("div", {
					style: {
						background: T.layer1, color: T.fg,
						border: "1px solid " + T.bd2, borderRadius: 14,
						width: "min(980px, 96vw)", height: "min(760px, 92vh)",
						display: "flex", flexDirection: "column", overflow: "hidden",
						boxShadow: "0 20px 60px rgba(0,0,0,0.32)", font: T.font
					}
				},
					h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: "1px solid " + T.bd1 } },
						h("span", { style: { display: "inline-flex", alignItems: "center", gap: 7, color: T.fg } },
							h(Icon, { name: "mail", size: 18, style: { color: T.biz } }),
							h("span", { style: { font: "600 14px/20px " + T.font } }, "信箱")
						),
						status?.config?.mailbox
							? h("span", { style: { font: "400 11.5px/18px " + T.font, color: T.fg3 } }, status.config.mailbox)
							: null,
						h("div", { style: { flex: 1 } }),
						h(Button, {
							onClick: () => {
								loadStatus();
								if (tab === "inbox") loadInbox();
								else if (tab === "outbox") { loadSent(); loadOutbox(); }
								else loadCfg();
							},
							title: "刷新当前页", children: "刷新"
						}),
						h("button", {
							onClick: () => setOpen(false),
							title: "关闭（Esc）",
							style: {
								cursor: "pointer", border: 0, background: "transparent", color: T.fg2,
								borderRadius: 8, padding: "4px 8px", font: "16px/16px " + T.font
							}
						}, h(Icon, { name: "x", size: 15, strokeWidth: 2 }))
					),
					h("div", { style: { display: "flex", gap: 2, padding: "0 10px", borderBottom: "1px solid " + T.bd1, flexWrap: "wrap" } },
						TABS.map((t) => {
							const active = tab === t.id;
							return h("button", {
								key: t.id,
								onClick: () => setTab(t.id),
								style: {
									cursor: "pointer", border: 0, background: "transparent",
									padding: "9px 11px",
									borderBottom: "2px solid " + (active ? T.biz : "transparent"),
									color: active ? T.fg : T.fg2,
									font: (active ? "600 " : "500 ") + "12.5px/18px " + T.font
								}
							}, t.label);
						})
					),
					h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "14px 16px 22px" } }, body)
				)
			);
		}

		function MailButton() {
			const open = useSyncExternalStore(subscribe, getSnapshot);
			const [hover, setHover] = useState(false);
			const [narrow, setNarrow] = useState(false);
			const boxRef = useRef(null);

			// 收起判定照抄 OB：量侧栏本身，别量按钮（自锁）。
			useEffect(() => {
				const node = boxRef.current;
				if (!node || typeof ResizeObserver === "undefined") return undefined;
				const measured = node.closest('[class*="sidebarCol"]') || (() => {
					let n = node.parentElement;
					while (n) {
						const cs = getComputedStyle(n);
						const w = n.getBoundingClientRect().width;
						if (cs.overflowX === "hidden" && w > 0 && w < 600) return n;
						n = n.parentElement;
					}
					return null;
				})();
				if (!measured) return undefined;
				const ro = new ResizeObserver((entries) => {
					for (const e of entries) {
						const w = e.contentRect.width;
						setNarrow((prev) => (prev ? w < 190 : w < 170));
					}
				});
				ro.observe(measured);
				return () => ro.disconnect();
			}, []);

			return h("button", {
				ref: boxRef,
				onClick: () => setOpen(true),
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				"aria-label": "打开信箱面板",
				title: "信箱：收件验收 / 已发送账本 / 邮箱配置",
				style: {
					cursor: "pointer",
					position: "relative",
					justifyContent: "flex-start",
					alignItems: "center",
					display: "inline-flex",
					gap: 7,
					height: 28,
					maxWidth: "100%",
					overflow: "hidden",
					border: 0,
					borderRadius: 8,
					padding: "0 8px",
					font: "500 13px/16px " + T.font,
					color: open ? T.biz : "var(--dsw-alias-label-primary, " + T.fg + ")",
					background: hover ? T.hover : "transparent",
					transition: "color 120ms, background 120ms"
				}
			},
				h(Icon, { name: "mail", size: 16 }),
				narrow ? null : h("span", { style: { whiteSpace: "nowrap" } }, "邮箱")
			);
		}

		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-ui-mail",
				inject: () => ({})
			}, MailButton));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-ui-mail",
				inject: () => ({})
			}, MailPanel));
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
