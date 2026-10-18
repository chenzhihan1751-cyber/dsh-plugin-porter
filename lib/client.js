window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-plugin-migrator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		const API = "/plugin-migrator/api";

		const styles = `
.pmg-page{font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;padding:14px 16px;max-width:820px}
.pmg-page h3{margin:0 0 6px;font-size:13px}
.pmg-stats{color:var(--theme-text-secondary,#888);font-size:11px;margin:0 0 10px}
.pmg-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.pmg-input{background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit}
.pmg-input.grow{flex:1;min-width:160px}
.pmg-select{background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:5px 8px;font-size:12px}
.pmg-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:5px 11px;cursor:pointer;font-size:12px;white-space:nowrap}
.pmg-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.pmg-btn:disabled{opacity:.45;cursor:not-allowed}
.pmg-list{list-style:none;margin:0 0 12px;padding:0;max-height:320px;overflow:auto;border:1px solid var(--theme-border,#333);border-radius:8px}
.pmg-item{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 8px;padding:7px 10px;border-bottom:1px solid var(--theme-border,#2a2a2a)}
.pmg-item:last-child{border-bottom:none}
.pmg-item>input[type=checkbox]{grid-row:1/3;align-self:center;margin:0}
.pmg-item .head{display:flex;gap:8px;align-items:baseline;min-width:0}
.pmg-item .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmg-item .vr{color:var(--theme-text-secondary,#888);font-size:11px;flex:0 0 auto}
.pmg-item .meta{display:flex;gap:6px;align-items:center;min-width:0}
.pmg-item .dr{color:var(--theme-text-secondary,#777);font-size:10px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.pmg-tag{font-size:10px;padding:1px 6px;border-radius:9px;border:1px solid transparent;white-space:nowrap;flex:0 0 auto}
.pmg-tag.fix{background:rgba(230,126,34,.15);color:#e67e22}
.pmg-tag.local{background:rgba(74,158,255,.15);color:#4a9eff}
.pmg-tag.remote{background:rgba(155,89,182,.15);color:#b06fd8}
.pmg-tag.on{background:rgba(46,204,113,.15);color:#2ecc71}
.pmg-tag.off{background:rgba(255,193,7,.12);color:#f1c40f}
.pmg-tag.ui{background:rgba(255,255,255,.08);color:var(--theme-text-secondary,#aaa)}
.pmg-tag.warn{background:rgba(231,76,60,.15);color:#e74c3c}
.pmg-sec{border:1px solid var(--theme-border,#333);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.pmg-sec label{display:flex;gap:6px;align-items:center;font-weight:600;margin-bottom:6px}
.pmg-sec .hint{color:var(--theme-text-secondary,#888);font-size:11px;font-weight:400;margin:0 0 6px}
.pmg-msg{margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);white-space:pre-wrap;max-height:260px;overflow:auto;font-size:11px;display:none}
.pmg-row{display:flex;gap:6px;align-items:center}
.pmg-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;display:flex;align-items:center;justify-content:center}
.pmg-dlg{width:min(620px,92vw);max-height:82vh;display:flex;flex-direction:column;background:var(--theme-bg,#14181f);border:1px solid var(--theme-border,#3a4150);border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.5);font-family:ui-monospace,monospace;font-size:12px;color:var(--theme-text,#ddd);overflow:hidden}
.pmg-dlg-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--theme-border,#333)}
.pmg-dlg-title{flex:1;font-weight:600}
.pmg-quick{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--theme-border,#2b2b2b)}
.pmg-crumb{display:flex;gap:4px;flex-wrap:wrap;padding:8px 12px;color:var(--theme-text-secondary,#999);border-bottom:1px solid var(--theme-border,#2b2b2b)}
.pmg-crumb span{cursor:pointer}
.pmg-crumb span:hover{color:var(--theme-accent,#4a9eff);text-decoration:underline}
.pmg-files{list-style:none;margin:0;padding:4px 0;overflow:auto;flex:1 1 auto;min-height:120px}
.pmg-files li{display:flex;gap:8px;align-items:center;padding:5px 12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmg-files li:hover{background:rgba(74,158,255,.12)}
.pmg-files li.hid{opacity:.5}
.pmg-dlg-foot{display:flex;gap:6px;align-items:center;padding:10px 12px;border-top:1px solid var(--theme-border,#333)}
.pmg-dlg-foot .grow{flex:1}
.pmg-err{padding:8px 12px;color:#e57373;border-top:1px solid var(--theme-border,#2b2b2b);display:none}
.pmg-sec-note{padding:8px 12px;font-size:12px;line-height:1.7;color:var(--theme-text-secondary,#999);border-bottom:1px solid var(--theme-border,#2b2b2b)}
.pmg-sec-rows{max-height:46vh;overflow:auto;padding:4px 0}
.pmg-sec-row{display:flex;flex-direction:column;gap:5px;padding:7px 12px}
.pmg-sec-row label{font-size:12px;color:var(--theme-text-secondary,#999)}
.pmg-sec-row .pmg-input{width:100%}
.pmg-sec-row .hint{font-size:11px;color:var(--theme-text-secondary,#777)}
`;

		/**
		 * 迁移包需要 API 密钥时弹的输入框（迁移包里**不含任何密钥值**）。
		 * items: [{ id, label }]（来自 host 的导入结果 secrets[]，filled=false 的才算）
		 * onSubmit({ secretId: value })：空值会在 host 侧被跳过（不覆盖目标机已有值）
		 */
		function askSecrets(items, onSubmit) {
			const overlay = el("div", "pmg-ov");
			const dlg = el("div", "pmg-dlg");
			const head = el("div", "pmg-dlg-head");
			head.append(el("div", "pmg-dlg-title", "这个迁移包需要 API 密钥（" + items.length + " 个）"));
			dlg.append(head);
			dlg.append(el("div", "pmg-sec-note",
				"迁移包里不含任何密钥值：这里填的会写进目标机的 settings.yaml / .credentials.yaml / 插件配置文件，写前自动备份 .bak-secrets-<时间戳>。留空 = 跳过，不动目标机已有的值。"));
			const rows = el("div", "pmg-sec-rows");
			const inputs = [];
			for (const s of items) {
				const row = el("div", "pmg-sec-row");
				row.append(el("label", undefined, s.label || s.id));
				const inp = el("input", "pmg-input");
				inp.type = "text";
				inp.placeholder = "粘贴 API Key（留空=跳过这一项）";
				row.append(inp);
				const hint = el("div", "hint", s.where || "");
				row.append(hint);
				inputs.push([s.id, inp]);
				rows.append(row);
			}
			dlg.append(rows);
			const foot = el("div", "pmg-dlg-foot");
			const btnOk = el("button", "pmg-btn", "写入并重跑");
			const btnSkip = el("button", "pmg-btn ghost", "稍后再说");
			foot.append(el("span", "grow"), btnOk, btnSkip);
			dlg.append(foot);
			overlay.append(dlg);
			document.body.append(overlay);
			const close = () => overlay.remove();
			btnSkip.onclick = close;
			btnOk.onclick = () => {
				const vals = {};
				for (const [id, inp] of inputs) if (inp.value.trim()) vals[id] = inp.value.trim();
				close();
				if (Object.keys(vals).length === 0) return onSubmit(null);
				onSubmit(vals);
			};
		}

		function el(tag, cls, text) {
			const e = document.createElement(tag);
			if (cls) e.className = cls;
			if (text !== undefined) e.textContent = text;
			return e;
		}

		function fetchJson(path, init) {
			return fetch(API + path, {
				headers: { "content-type": "application/json" },
				...init,
			}).then((r) => r.json());
		}

		/**
		 * 路径菜单：逐级浏览主机目录并选一个路径。
		 * 后端走宿主 ctx.directoryPicker（browse 原语 = 官方对话框同一套；native 后端则直接弹系统对话框）。
		 * opts: { title, mode:'dir'|'file', start, quick:[{label,path}], onPick(path) }
		 */
		function openPicker(opts) {
			const mode = opts.mode === "file" ? "file" : "dir";
			const overlay = el("div", "pmg-ov");
			const dlg = el("div", "pmg-dlg");
			const head = el("div", "pmg-dlg-head");
			const title = el("div", "pmg-dlg-title", opts.title || (mode === "file" ? "选择文件" : "选择目录"));
			const btnX = el("button", "pmg-btn ghost", "关闭");
			head.append(title, btnX);

			const quick = el("div", "pmg-quick");
			const crumb = el("div", "pmg-crumb");
			const list = el("ul", "pmg-files");
			const err = el("div", "pmg-err");
			const foot = el("div", "pmg-dlg-foot");
			const newName = el("input", "pmg-input");
			newName.placeholder = "新建文件夹名…";
			newName.style.maxWidth = "150px";
			const btnMk = el("button", "pmg-btn ghost", "新建");
			const btnUp = el("button", "pmg-btn ghost", "上一级");
			const btnHome = el("button", "pmg-btn ghost", "主目录");
			const spacer = el("span", "grow");
			const btnOk = el("button", "pmg-btn", mode === "file" ? "选择当前目录" : "选择当前目录");
			const btnCancel = el("button", "pmg-btn ghost", "取消");
			foot.append(btnUp, btnHome, newName, btnMk, spacer, btnOk, btnCancel);

			dlg.append(head, quick, crumb, list, err, foot);
			overlay.append(dlg);
			document.body.append(overlay);

			let cur = null;       // 当前 listing
			let pickedFile = null;

			const showError = (text) => { err.textContent = text || ""; err.style.display = text ? "block" : "none"; };
			const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
			const onKey = (ev) => { if (ev.key === "Escape") close(); };
			document.addEventListener("keydown", onKey);
			btnX.onclick = close;
			btnCancel.onclick = close;
			overlay.onclick = (ev) => { if (ev.target === overlay) close(); };

			const finish = (p) => { close(); opts.onPick(p); };
			btnOk.onclick = () => finish(pickedFile || (cur && cur.path) || "");
			btnUp.onclick = () => { if (cur && cur.parent) load(cur.parent); };
			btnHome.onclick = () => { if (cur && cur.home) load(cur.home); };

			for (const q of opts.quick || []) {
				if (!q || !q.path) continue;
				const b = el("button", "pmg-btn ghost", q.label);
				b.onclick = () => load(q.path);
				quick.append(b);
			}
			// 盘符（Windows）
			for (const d of ["C:\\", "D:\\", "E:\\"]) {
				const b = el("button", "pmg-btn ghost", d);
				b.onclick = () => load(d);
				quick.append(b);
			}

			btnMk.onclick = () => {
				const name = newName.value.trim();
				if (!name || !cur) return showError("先填一个文件夹名");
				btnMk.disabled = true;
				fetchJson("/mkdir", { method: "POST", body: JSON.stringify({ parent: cur.path, name }) })
					.then((r) => {
						if (!r.ok) return showError(r.result);
						newName.value = "";
						showError("");
						load(r.path);
					})
					.catch((e) => showError("新建失败：" + e))
					.finally(() => { btnMk.disabled = false; });
			};

			function render() {
				crumb.textContent = "";
				for (const c of cur.crumbs || []) {
					const s = el("span", undefined, c.name);
					s.onclick = () => load(c.path);
					crumb.append(s, document.createTextNode(" › "));
				}
				list.textContent = "";
				const dirs = (cur.entries || []).slice().sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name));
				if (!dirs.length && !(cur.files || []).length) list.append(el("li", "hid", "（没有子目录）"));
				for (const d of dirs) {
					const li = el("li", d.hidden && !d.isPack ? "hid" : undefined);
					li.append(el("span", undefined, d.isPack ? "📦" : "📁"), el("span", undefined, d.name));
					if (d.isPack) {
						li.append(el("span", "pmg-tag local", "迁移包"));
						li.title = "这是一个迁移包目录，点一下直接选中";
						li.onclick = () => finish(d.path);
					} else {
						li.onclick = () => load(d.path);
					}
					list.append(li);
				}
				for (const f of cur.files || []) {
					const li = el("li");
					const name = el("span", undefined, "🗜️ " + f.name);
					li.append(name, el("span", "pmg-tag remote", "压缩包"));
					li.title = "迁移包的 zip 版（拷到别的机器更方便）";
					li.onclick = () => { pickedFile = f.path; finish(f.path); };
					list.append(li);
				}
				if (cur.truncated) list.append(el("li", "hid", "（目录过多，已截断）"));
				if (cur.pack) {
					const hint = el("li");
					hint.append(el("span", "pmg-tag on", "当前目录就是一个迁移包"), el("span", undefined, "点右下「选择当前目录」即可"));
					hint.style.cursor = "default";
					list.append(hint);
				}
				btnOk.disabled = false;
				if (mode === "dir") title.textContent = (opts.title || "选择目录") + " · " + (cur.path || "");
			}

			function load(target) {
				showError("");
				list.textContent = "";
				list.append(el("li", "hid", "读取中…"));
				pickedFile = null;
				const query = "/browse?mode=" + mode + (target ? "&path=" + encodeURIComponent(target) : "");
				fetchJson(query)
					.then((r) => {
						if (!r.ok) { list.textContent = ""; return showError(r.result || "读取失败"); }
						if (r.kind === "native") {                 // 系统对话框后端：已拿到结果
							if (r.picked) return finish(r.picked);
							list.textContent = "";
							return showError("已取消系统选择框");
						}
						cur = r;
						if (r.note) showError(r.note);
						render();
					})
					.catch((e) => { list.textContent = ""; showError("读取失败：" + e); });
			}

			load(opts.start);
		}

		function MigratorPage() {
			const hostRef = react.useRef(null);

			react.useEffect(() => {
				const root = hostRef.current;
				if (!root) return;

				const style = el("style");
				style.textContent = styles;
				const page = el("div", "pmg-page");
				const title = el("h3", undefined, "DSH 迁移");
				const stats = el("p", "pmg-stats");
				page.append(style, title, stats);

				// ── 顶部：profile 选择 / 过滤 / 批量选择 ──
				const bar = el("div", "pmg-bar");
				const profileSel = el("select", "pmg-select");
				const btnRefresh = el("button", "pmg-btn ghost", "刷新");
				const filterInput = el("input", "pmg-input grow");
				filterInput.placeholder = "过滤插件名…";
				const btnAll = el("button", "pmg-btn ghost", "全选");
				const btnNone = el("button", "pmg-btn ghost", "清空");
				const btnBoot = el("button", "pmg-btn ghost", "启动体检");
				btnBoot.title = "直接调用 DSH 自己的 loadProfile()（与启动同源），不用重启就能知道下次启动会不会因 bundle 配置报错";
				bar.append(profileSel, btnRefresh, filterInput, btnAll, btnNone, btnBoot);
				page.append(bar);

				const list = el("ul", "pmg-list");
				page.append(list);

				// 该页要用到的「快捷位置」，refresh() 时由 /list 补上
				const places = { home: "", exportRoot: "", sourceRoot: "", profileDir: "", lastExportRoot: "", lastExportDir: "", recent: [] };
				const quickFor = () => {
					const out = [];
					out.push({ label: "上次导出目录", path: places.lastExportDir || places.lastExportRoot || places.exportRoot });
					out.push({ label: "默认迁移包目录", path: places.exportRoot });
					for (const p of places.recent.slice(0, 3)) {
						const label = String(p).split(/[\\/]/).filter(Boolean).pop() || p;
						out.push({ label: "最近包：" + label, path: p });
					}
					out.push({ label: "工作区", path: places.sourceRoot });
					out.push({ label: "主目录", path: places.home });
					return out.filter((q) => q.path);
				};

				// ── 三个动作区 ──
				const mode = { value: "export" };

				const secExport = el("div", "pmg-sec");
				const rExport = el("label");
				const radioExport = el("input");
				radioExport.type = "radio";
				radioExport.name = "pmg-mode";
				radioExport.checked = true;
				rExport.append(radioExport, document.createTextNode("① 导出迁移包（勾选插件 → 打包，可拷到别的机器）"));
				const exportRow = el("div", "pmg-row");
				const outDir = el("input", "pmg-input grow");
				outDir.placeholder = "输出目录（留空 = DSH_HOME/plugin-migrations）";
				const btnPickOut = el("button", "pmg-btn ghost", "选择目录…");
				btnPickOut.onclick = () => openPicker({
					title: "选择导出目录",
					mode: "dir",
					start: outDir.value.trim() || places.exportRoot || places.home,
					quick: quickFor(),
					onPick: (p) => { outDir.value = p; },
				});
				exportRow.append(outDir, btnPickOut);
				secExport.append(rExport, exportRow);

				const secImport = el("div", "pmg-sec");
				const rImport = el("label");
				const radioImport = el("input");
				radioImport.type = "radio";
				radioImport.name = "pmg-mode";
				rImport.append(radioImport, document.createTextNode("② 导入迁移包（把迁移包恢复到本机）"));
				const importRow1 = el("div", "pmg-row");
				const pkgPath = el("input", "pmg-input grow");
				pkgPath.placeholder = "迁移包目录或 .zip 路径";
				const btnPickPkg = el("button", "pmg-btn ghost", "选择包…");
				btnPickPkg.onclick = () => openPicker({
					title: "选择迁移包（文件夹或 .zip）",
					mode: "file",
					start: pkgPath.value.trim() || places.lastExportDir || places.lastExportRoot || places.exportRoot || places.home,
					quick: quickFor(),
					onPick: (p) => { pkgPath.value = p; },
				});
				importRow1.append(pkgPath, btnPickPkg);
				const importRow2 = el("div", "pmg-row");
				importRow2.style.marginTop = "6px";
				const srcRoot = el("input", "pmg-input grow");
				srcRoot.placeholder = "本地插件源码落盘根目录（留空 = 沿用迁移包记录的路径）";
				const btnPickSrc = el("button", "pmg-btn ghost", "选择目录…");
				btnPickSrc.onclick = () => openPicker({
					title: "选择插件源码落盘目录",
					mode: "dir",
					start: srcRoot.value.trim() || places.sourceRoot || places.home,
					quick: quickFor(),
					onPick: (p) => { srcRoot.value = p; },
				});
				const dry = el("label");
				const dryBox = el("input");
				dryBox.type = "checkbox";
				dry.append(dryBox, document.createTextNode("仅预览"));
				importRow2.append(srcRoot, btnPickSrc, dry);
				secImport.append(rImport, importRow1, importRow2);

				const secCopy = el("div", "pmg-sec");
				const rCopy = el("label");
				const radioCopy = el("input");
				radioCopy.type = "radio";
				radioCopy.name = "pmg-mode";
				rCopy.append(radioCopy, document.createTextNode("③ 搬到本机另一个 profile（写依赖 + 建链接 + 迁 patch）"));
				const copyRow = el("div", "pmg-row");
				const targetSel = el("select", "pmg-select");
				const dry2 = el("label");
				const dry2Box = el("input");
				dry2Box.type = "checkbox";
				dry2.append(dry2Box, document.createTextNode("仅预览"));
				copyRow.append(targetSel, dry2);
				secCopy.append(rCopy, copyRow);

				page.append(secExport, secImport, secCopy);

				// ── ④ 全量整合包（独立动作，不参与上面 ①②③ 的单选）──
				const secAll = el("div", "pmg-sec");
				const tAll = el("label");
				tAll.append(el("b", undefined, "④ 全量整合包"), document.createTextNode("（全部插件 + 每插件功能/搭建技巧/版本变迁 + 可直接粘给新 DSH 的提示词）"));
				const hintAll = el("p", "hint", "一次生成：catalog/*.md（每插件一页）· TRICKS.md（踩坑总集）· PROMPT.md（施工提示词）· knowledge/（纪律与技能）· packages/ 源码快照 · zip");
				const aoRow1 = el("div", "pmg-row");
				const aoOut = el("input", "pmg-input grow");
				aoOut.placeholder = "输出目录（留空 = DSH_HOME/plugin-migrations）";
				const aoPick = el("button", "pmg-btn ghost", "选择目录…");
				aoPick.onclick = () => openPicker({
					title: "选择整合包输出目录",
					mode: "dir",
					start: aoOut.value.trim() || places.exportRoot || places.home,
					quick: quickFor(),
					onPick: (p) => { aoOut.value = p; },
				});
				aoRow1.append(aoOut, aoPick);
				const aoRow2 = el("div", "pmg-row");
				aoRow2.style.marginTop = "6px";
				aoRow2.style.gap = "14px";
				const aoSrcL = el("label");
				const aoSrc = el("input");
				aoSrc.type = "checkbox";
				aoSrc.checked = true;
				aoSrcL.append(aoSrc, document.createTextNode("带源码快照"));
				const aoKnL = el("label");
				const aoKn = el("input");
				aoKn.type = "checkbox";
				aoKn.checked = true;
				aoKnL.append(aoKn, document.createTextNode("带知识层（AGENTS/技能/错误库）"));
				aoRow2.append(aoSrcL, aoKnL);
				const aoRow3 = el("div", "pmg-row");
				aoRow3.style.marginTop = "8px";
				const aoRun = el("button", "pmg-btn", "生成整合包（后台）");
				const aoAgain = el("button", "pmg-btn ghost", "刷新进度");
				const aoOpen = el("button", "pmg-btn ghost", "打开文件夹");
				const aoExport = el("button", "pmg-btn ghost", "导出…");
				const aoCopy = el("button", "pmg-btn ghost", "复制提示词");
				aoOpen.disabled = true;
				aoExport.disabled = true;
				aoCopy.disabled = true;
				aoRow3.append(aoRun, aoAgain, aoOpen, aoExport, aoCopy);
				const aoStep = el("div", "pmg-stats");
				aoStep.style.margin = "8px 0 0";
				aoStep.style.whiteSpace = "pre-wrap";
				aoStep.style.lineHeight = "1.6";
				aoStep.textContent = "未生成。点「生成整合包」后在后台跑（约 10~40 秒），可随时点「刷新进度」。";
				secAll.append(tAll, hintAll, aoRow1, aoRow2, aoRow3, aoStep);
				page.append(secAll);

				// ── ⑤ 整机迁移（换电脑：配置/记忆/会话/附件/技能/插件/API 密钥 一起走）──
				const secFull = el("div", "pmg-sec");
				const tFull = el("label");
				tFull.append(el("b", undefined, "⑤ 整机迁移"), document.createTextNode("（换电脑：~/.dsh 配置/记忆/会话/附件/技能 + 插件源码 + API 密钥，一个包带走）"));
				const hintFull = el("p", "hint", "含明文密钥（这是换机要求），包按机密文件处理。每卷独立可解，MANIFEST.json 记了每个文件的 sha256，可逐字节校验。");
				const fmSel = el("div", "pmg-row");
				fmSel.style.marginTop = "4px";
				fmSel.style.gap = "12px";
				fmSel.style.flexWrap = "wrap";
				const fmScopes = [
					{ id: "essential", label: "精简", hint: "配置+记忆+技能（~55MB）" },
					{ id: "standard", label: "标准", hint: "+会话+附件+插件源码（~1GB）" },
					{ id: "everything", label: "最全", hint: "+缓存备份+整个工作区（十几 GB）" },
				];
				const fmRadios = {};
				for (const sc of fmScopes) {
					const wrap = el("label");
					const r = el("input");
					r.type = "radio";
					r.name = "pmg-fm-scope";
					r.value = sc.id;
					if (sc.id === "standard") r.checked = true;
					const tip = el("span", "pmg-stats");
					tip.style.margin = "0";
					tip.style.fontSize = "11px";
					tip.style.opacity = ".8";
					tip.textContent = sc.hint;
					wrap.append(r, document.createTextNode(sc.label + " "), tip);
					wrap.title = sc.hint;
					fmRadios[sc.id] = r;
					fmSel.append(wrap);
				}
				const fmRow1 = el("div", "pmg-row");
				fmRow1.style.marginTop = "6px";
				const fmOut = el("input", "pmg-input grow");
				fmOut.placeholder = "输出目录（留空 = DSH_HOME/dsh-migrations）";
				const fmPick = el("button", "pmg-btn ghost", "选择目录…");
				fmPick.onclick = () => openPicker({
					title: "选择整机迁移包输出目录",
					mode: "dir",
					start: fmOut.value.trim() || places.home,
					quick: quickFor(),
					onPick: (p) => { fmOut.value = p; },
				});
				fmRow1.append(fmOut, fmPick);
				const fmRow2 = el("div", "pmg-row");
				fmRow2.style.marginTop = "8px";
				const fmEstimate = el("button", "pmg-btn", "算一下体积（评估）");
				const fmRun = el("button", "pmg-btn ghost", "生成迁移包（后台）");
				const fmAgain = el("button", "pmg-btn ghost", "刷新进度");
				const fmOpen = el("button", "pmg-btn ghost", "打开文件夹");
				const fmExport = el("button", "pmg-btn ghost", "导出…");
				const fmCopy = el("button", "pmg-btn ghost", "复制提示词");
				fmOpen.disabled = true;
				fmExport.disabled = true;
				fmCopy.disabled = true;
				fmRow2.append(fmEstimate, fmRun, fmAgain, fmOpen, fmExport, fmCopy);
				const fmStep = el("div", "pmg-stats");
				fmStep.style.margin = "8px 0 0";
				fmStep.style.whiteSpace = "pre-wrap";
				fmStep.style.lineHeight = "1.6";
				fmStep.textContent = "先选档位 → 点「算一下体积（评估）」：会告诉你这档带什么、多少 MB、体积花在哪、哪些被排除，全程不写任何文件。确认能接受再点「生成迁移包」。";
				secFull.append(tFull, hintFull, fmSel, fmRow1, fmRow2, fmStep);
				page.append(secFull);

				const runRow = el("div", "pmg-bar");
				const btnRun = el("button", "pmg-btn", "执行");
				const btnFix = el("button", "pmg-btn ghost", "修复选中：dsh.bundle");
				btnFix.title = "给选中插件补 dsh.bundle.patch + cordis.patch.yml（新版 DSH 的硬要求）。写入前自动备份 package.json，可在插件目录用 .bak-bundlefield-* 还原。";
				const selInfo = el("span", "pmg-stats");
				selInfo.style.margin = "0";
				runRow.append(btnRun, btnFix, selInfo);
				page.append(runRow);

				const msg = el("div", "pmg-msg");
				page.append(msg);

				const say = (text, isErr) => {
					msg.textContent = text || "";
					msg.style.display = text ? "block" : "none";
					msg.style.borderColor = isErr ? "#d33" : "var(--theme-border,#333)";
					msg.scrollTop = 0;
				};

				// ── 状态 ──
				let state = { profile: "web", plugins: [], profiles: [], selected: new Set(), filter: "" };

				// ── ④ 全量整合包：后台任务 + 轮询 + 导出 ──
				let aoJob = null;
				let aoTimer = null;
				const aoStop = () => { if (aoTimer) { clearInterval(aoTimer); aoTimer = null; } };
				const aoRender = (job) => {
					if (!job) return;
					aoJob = job;
					if (job.status === "running") {
						aoRun.disabled = true;
						const secs = Math.max(0, Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000));
						aoStep.textContent = "⏳ 后台生成中（" + secs + "s）：" + (job.step || "…");
						return;
					}
					aoRun.disabled = false;
					if (job.status === "done") {
						const c = job.counts || {};
						aoStep.textContent = "✅ 完成：插件 " + (c.plugins || "?") + " 个 · 工具 " + (c.tools || "?") + " 个 · HTTP 接口 " + (c.routes || "?") + " 个 · 待填密钥 " + (c.secrets || 0) + " 个"
							+ "\n目录：" + (job.root || "?")
							+ (job.zip ? "\n压缩包：" + job.zip : "\n（zip 未生成，可手动压缩目录）")
							+ "\n下一步：点「导出…」把 zip + PROMPT.md 拷到目标机，或点「复制提示词」直接粘给新 DSH。";
						aoOpen.disabled = false;
						aoExport.disabled = false;
						aoCopy.disabled = false;
					} else {
						aoStep.textContent = "❌ 失败：" + (job.error || "未知原因");
					}
				};
				const aoPoll = async () => {
					if (!aoJob) return;
					try {
						const r = await fetchJson("/allinone/status?job=" + encodeURIComponent(aoJob.id));
						if (r && r.job) { aoRender(r.job); if (r.job.status !== "running") aoStop(); }
					} catch { /* 单次轮询失败不打断 */ }
				};
				aoRun.onclick = async () => {
					aoStop();
					aoStep.textContent = "提交任务…";
					aoRun.disabled = true;
					try {
						const r = await fetchJson("/allinone/start", {
							method: "POST",
							body: JSON.stringify({
								profile: profileSel.value || "web",
								outDir: aoOut.value.trim(),
								includeSource: aoSrc.checked,
								includeKnowledge: aoKn.checked,
							}),
						});
						if (!r || !r.job) { aoRun.disabled = false; aoStep.textContent = "❌ 起任务失败：" + ((r && r.result) || "无响应"); return; }
						aoRender(r.job);
						aoTimer = setInterval(aoPoll, 1500);
					} catch (e) { aoRun.disabled = false; aoStep.textContent = "❌ 起任务失败：" + String((e && e.message) || e); }
				};
				aoAgain.onclick = () => { if (!aoJob) { aoStep.textContent = "还没有任务。先点「生成整合包」。"; return; } aoPoll(); };
				aoOpen.onclick = async () => {
					if (!aoJob || !aoJob.root) return;
					const r = await fetchJson("/allinone/open", { method: "POST", body: JSON.stringify({ dir: aoJob.root }) });
					if (r && !r.ok) say(r.result, true); else say("已打开：" + aoJob.root);
				};
				aoExport.onclick = () => {
					if (!aoJob || !aoJob.root) return;
					openPicker({
						title: "导出整合包到…（zip + PROMPT/INSTALL/TRICKS + manifest）",
						mode: "dir",
						start: places.lastExportDir || places.home,
						quick: quickFor(),
						onPick: async (p) => {
							const r = await fetchJson("/allinone/export", { method: "POST", body: JSON.stringify({ jobId: aoJob.id, target: p }) });
							say((r && r.result) || "导出无响应", !(r && r.ok));
						},
					});
				};
				aoCopy.onclick = async () => {
					if (!aoJob) return;
					const r = await fetchJson("/allinone/prompt?job=" + encodeURIComponent(aoJob.id));
					if (!r || !r.ok) { say((r && r.result) || "读不到 PROMPT.md", true); return; }
					try {
						await navigator.clipboard.writeText(r.text);
						say("已复制 PROMPT.md（" + r.text.length + " 字）到剪贴板，直接粘给新 DSH 即可");
					} catch {
						say("剪贴板不可用；文件在：" + r.path);
					}
				};

				// ── ⑤ 整机迁移：预估 / 后台构建 / 导出 ──
				let fmJob = null;
				let fmTimer = null;
				const fmStop = () => { if (fmTimer) { clearInterval(fmTimer); fmTimer = null; } };
				const fmScope = () => Object.keys(fmRadios).find((k) => fmRadios[k].checked) || "standard";
				const fmRender = (job) => {
					if (!job) return;
					fmJob = job;
					if (job.status === "running") {
						fmRun.disabled = true;
						const secs = Math.max(0, Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000));
						const pct = job.total ? "（" + job.done + "/" + job.total + "）" : "";
						fmStep.textContent = "⏳ " + job.scope + " 生成中 " + secs + "s" + pct + "：" + (job.step || "…");
						return;
					}
					fmRun.disabled = false;
					if (job.status === "done") {
						const s = job.stats || {};
						fmStep.textContent = "✅ 完成：" + (s.files || "?") + " 个文件 / " + ((s.bytes || 0) / 1048576).toFixed(1) + " MB / " + (s.volumes || "?") + " 卷"
							+ (s.skipped ? "（" + s.skipped + " 个未打包）" : "")
							+ "\n目录：" + (job.root || "?")
							+ "\n下一步：点「导出…」把整包拷走 / 点「复制提示词」贴给新机器的 DSH。"
							+ "\n⚠ 包含明文 API 密钥：只在自己机器之间传，用完删包或换密钥。";
						fmOpen.disabled = false;
						fmExport.disabled = false;
						fmCopy.disabled = false;
					} else {
						fmStep.textContent = "❌ 失败：" + (job.error || "未知原因");
					}
				};
				const fmPoll = async () => {
					if (!fmJob) return;
					try {
						const r = await fetchJson("/full/status?job=" + encodeURIComponent(fmJob.id));
						if (r && r.job) { fmRender(r.job); if (r.job.status !== "running") fmStop(); }
					} catch { /* 单次失败忽略 */ }
				};
				const fmDoEstimate = async () => {
					const sc = fmScope();
					fmEstimate.disabled = true;
					fmStep.textContent = "正在扫描 " + sc + " 范围（最全档可能要几十秒）…";
					try {
						const r = await fetchJson("/full/estimate?scope=" + encodeURIComponent(sc));
						if (!r || !r.ok) { fmStep.textContent = "❌ 预估失败"; return; }
						const L = [];
						L.push("评估【" + r.scope + "】" + r.label);
						L.push("  " + r.files + " 个文件 / " + r.mb + " MB ≈ " + r.volumesAt1800 + " 卷（按 1800MB/卷）");
						L.push("");
						L.push("体积花在哪：");
						for (const x of (r.included || []).slice(0, 6)) L.push("  · " + x.key + "  " + x.mb + " MB / " + x.files + " 文件");
						if (r.heaviest && r.heaviest.length) {
							L.push("");
							L.push("最大的单个文件：");
							for (const h of r.heaviest.slice(0, 3)) L.push("  · " + h.mb + " MB  " + h.rel.split("/").slice(-2).join("/"));
						}
						L.push("");
						L.push("按规则排除掉：约 " + r.excludedMb + " MB（" + r.excluded + " 个条目）");
						for (const x of (r.excludedTop || []).slice(0, 4)) L.push("  · " + x.path.split("/").slice(-2).join("/") + "  " + x.mb + " MB");
						if (r.heavySkipped) {
							L.push("");
							L.push("另有 " + r.heavySkipped + " 个 >50MB 的大文件按本档规则跳过：");
							for (const h of (r.heavyTop || []).slice(0, 3)) L.push("  · " + h.mb + " MB  " + h.rel.split("/").slice(-2).join("/"));
						}
						L.push("");
						L.push("DSH_HOME：" + r.dshHome);
						L.push("工作区：" + r.workspace);
						L.push("（扫描 " + (r.tookMs / 1000).toFixed(1) + "s，没有写任何文件）");
						fmStep.textContent = L.join("\n");
					} catch (e) { fmStep.textContent = "❌ 预估失败：" + String((e && e.message) || e); }
					finally { fmEstimate.disabled = false; }
				};
				fmEstimate.onclick = () => fmDoEstimate();
				for (const k of Object.keys(fmRadios)) {
					fmRadios[k].onchange = () => {
						fmStop();
						fmStep.textContent = "已选【" + k + "】。点「算一下体积（评估）」看这档带什么、多大、体积花在哪（不写文件）。";
					};
				}
				fmRun.onclick = async () => {
					fmStop();
					fmRun.disabled = true;
					fmStep.textContent = "提交任务…";
					try {
						const r = await fetchJson("/full/start", {
							method: "POST",
							body: JSON.stringify({ scope: fmScope(), outDir: fmOut.value.trim() }),
						});
						if (!r || !r.job) { fmRun.disabled = false; fmStep.textContent = "❌ 起任务失败：" + ((r && r.result) || "无响应"); return; }
						fmRender(r.job);
						fmTimer = setInterval(fmPoll, 1500);
					} catch (e) { fmRun.disabled = false; fmStep.textContent = "❌ 起任务失败：" + String((e && e.message) || e); }
				};
				fmAgain.onclick = () => { if (!fmJob) { fmStep.textContent = "还没有任务。先选档位再点「生成迁移包」。"; return; } fmPoll(); };
				fmOpen.onclick = async () => {
					if (!fmJob || !fmJob.root) return;
					const r = await fetchJson("/allinone/open", { method: "POST", body: JSON.stringify({ dir: fmJob.root }) });
					if (r && !r.ok) say(r.result, true); else say("已打开：" + fmJob.root);
				};
				fmExport.onclick = () => {
					if (!fmJob || !fmJob.root) return;
					openPicker({
						title: "导出整机迁移包到…（卷 + 清单 + 恢复脚本 + 提示词）",
						mode: "dir",
						start: places.lastExportDir || places.home,
						quick: quickFor(),
						onPick: async (p) => {
							const r = await fetchJson("/full/export", { method: "POST", body: JSON.stringify({ jobId: fmJob.id, target: p }) });
							say((r && r.result) || "导出无响应", !(r && r.ok));
						},
					});
				};
				fmCopy.onclick = async () => {
					if (!fmJob || !fmJob.root) return;
					try {
						const r2 = await fetchJson("/full/prompt?job=" + encodeURIComponent(fmJob.id));
						if (!r2 || !r2.ok) { say((r2 && r2.result) || "读不到 PROMPT.md", true); return; }
						await navigator.clipboard.writeText(r2.text);
						say("已复制整机迁移 PROMPT.md（" + r2.text.length + " 字）到剪贴板，贴给新机器的 DSH 即可");
					} catch {
						say("剪贴板不可用；文件在：" + fmJob.root + "\\PROMPT.md");
					}
				};

				const syncModes = () => {
					secExport.style.opacity = mode.value === "export" ? "1" : ".55";
					secImport.style.opacity = mode.value === "import" ? "1" : ".55";
					secCopy.style.opacity = mode.value === "copy" ? "1" : ".55";
					renderList();
				};
				radioExport.checked = true;
				radioExport.onchange = () => { mode.value = "export"; syncModes(); };
				radioImport.onchange = () => { mode.value = "import"; syncModes(); };
				radioCopy.onchange = () => { mode.value = "copy"; syncModes(); };

				const selectedCount = () => {
					let n = 0;
					for (const p of state.plugins) if (state.selected.has(p.name)) n += 1;
					return n;
				};

				const renderList = () => {
					list.textContent = "";
					const needle = state.filter.trim().toLowerCase();
					const shown = state.plugins.filter((p) => !needle || p.name.toLowerCase().includes(needle));
					if (!shown.length) {
						list.append(el("li", "pmg-item", state.plugins.length ? "（无匹配插件）" : "（该 profile 暂无插件）"));
					}
					for (const p of shown) {
						const li = el("li", "pmg-item");
						const box = el("input");
						box.type = "checkbox";
						box.checked = state.selected.has(p.name);
						box.onchange = () => {
							if (box.checked) state.selected.add(p.name);
							else state.selected.delete(p.name);
							selInfo.textContent = "已选 " + selectedCount() + " / " + state.plugins.length;
						};
						const head = el("div", "head");
						head.append(el("span", "nm", p.name), el("span", "vr", "v" + (p.version || "?")));
						const meta = el("div", "meta");
						meta.append(el("span", "pmg-tag " + (p.kind === "local" ? "local" : "remote"), p.kind === "local" ? "本地" : "远程"));
						meta.append(el("span", "pmg-tag " + (p.disabled ? "off" : "on"), p.disabled ? "已禁用" : (p.inBundles ? "已启用" : "未进 bundles")));
						if (p.source.includes("injected")) meta.append(el("span", "pmg-tag ui", "注入"));
						if (p.hasClient) meta.append(el("span", "pmg-tag ui", "含UI"));
						if (p.specBroken) meta.append(el("span", "pmg-tag fix", p.dirSource === "guessed" ? "路径已修正" : "路径损坏"));
						if (!p.bundlePatchOk) {
							const t = el("span", "pmg-tag warn", "缺 dsh.bundle");
							t.title = "package.json 没声明 dsh.bundle.patch：DSH ≥ 0.1.2-rc.1 里，把它放进 profile bundles 会导致启动直接报错。点下方「修复 dsh.bundle」可一键补（会备份 package.json）。";
							meta.append(t);
						}
						meta.append(el("span", "dr", p.dir || "（未装到 node_modules）"));
						li.append(box, head, meta);
						list.append(li);
					}
					selInfo.textContent = "已选 " + selectedCount() + " / " + state.plugins.length;
					btnRun.textContent = mode.value === "export" ? "导出选中插件" : mode.value === "import" ? "导入迁移包" : "搬到目标 profile";
				};

				filterInput.oninput = () => { state.filter = filterInput.value; renderList(); };
				btnAll.onclick = () => { for (const p of state.plugins) if (!state.filter.trim() || p.name.toLowerCase().includes(state.filter.trim().toLowerCase())) state.selected.add(p.name); renderList(); };
				btnNone.onclick = () => { state.selected.clear(); renderList(); };

				const fillProfiles = (profiles, current) => {
					profileSel.textContent = "";
					targetSel.textContent = "";
					for (const p of profiles) {
						const o1 = el("option", undefined, p);
						o1.value = p;
						if (p === current) o1.selected = true;
						profileSel.append(o1);
						const o2 = el("option", undefined, p);
						o2.value = p;
						if (p !== current) o2.selected = true;
						targetSel.append(o2);
					}
					if (!targetSel.options.length) targetSel.append(el("option", undefined, "（无其它 profile）"));
				};

				btnBoot.onclick = () => {
					btnBoot.disabled = true;
					say("正在用 DSH 自己的装配代码体检…");
					fetchJson("/bootcheck?profile=" + encodeURIComponent(state.profile))
						.then((r) => say((r.ok ? "" : "") + (r.result || JSON.stringify(r)), !r.ok))
						.catch((e) => say("体检请求失败：" + e, true))
						.finally(() => { btnBoot.disabled = false; });
				};

				const refresh = () => {
					return fetchJson("/list?profile=" + encodeURIComponent(state.profile))
						.then((d) => {
							if (!d?.ok) return say(JSON.stringify(d), true);
							state.profile = d.profile;
							state.plugins = d.plugins || [];
							places.home = d.home || "";
							places.exportRoot = d.exportRoot || "";
							places.sourceRoot = d.sourceRoot || "";
							places.profileDir = d.profileDir || "";
							places.lastExportRoot = d.lastExportRoot || "";
							places.lastExportDir = d.lastExportDir || "";
							places.recent = d.recentExports || [];
							fillProfiles(d.profiles || [], d.profile);
							if (!outDir.value) outDir.placeholder = "输出目录（默认 " + d.exportRoot + "）";
							if (!srcRoot.value) srcRoot.placeholder = "插件源码根目录（留空 = 自动判定，推荐）";
							stats.textContent = "profile=" + d.profile + " · " + state.plugins.length + " 个插件 · 目录 " + d.profileDir + (d.warnings?.length ? " · 警告 " + d.warnings.length : "");
							renderList();
						})
						.catch((e) => say("加载失败：" + e, true));
				};

				profileSel.onchange = () => { state.profile = profileSel.value; state.selected.clear(); say(""); refresh(); };
				btnRefresh.onclick = () => { say(""); refresh(); };

				btnFix.onclick = () => {
					const names = state.plugins.filter((p) => state.selected.has(p.name)).map((p) => p.name);
					if (!names.length) return say("请先勾选要修复的插件", true);
					btnFix.disabled = true;
					say("正在补齐 dsh.bundle…");
					fetchJson("/fixbundle", { method: "POST", body: JSON.stringify({ profile: state.profile, names }) })
						.then((r) => {
							say(r?.result ?? JSON.stringify(r), !r?.ok);
							if (r?.ok) setTimeout(refresh, 800);
						})
						.catch((e) => say("请求失败：" + e, true))
						.finally(() => { btnFix.disabled = false; });
				};

				const doRun = (path, payload, mayAsk) => {
					btnRun.disabled = true;
					const prev = btnRun.textContent;
					btnRun.textContent = "执行中…";
					say("执行中…");
					return fetchJson(path, { method: "POST", body: JSON.stringify(payload) })
						.then((r) => {
							say(r?.result ?? JSON.stringify(r), !r?.ok);
							if (r?.ok) setTimeout(refresh, 800);
							// 导入后：包里不含密钥值，未填的那些就现场弹输入框（填完自动重跑一次导入）
							// mayAsk 只允许每轮用户操作弹一次，避免「填一半 → 重跑 → 又弹」这种循环
							const missing = (r?.secrets || []).filter((s) => !s.filled);
							if (r?.ok && path === "/import" && missing.length && mayAsk !== false) {
								askSecrets(missing, (vals) => {
									if (!vals) return say("已跳过密钥写入（相关插件可能用不了；随时可再导入一次并填写）。");
									say("\n—— 写入 API 密钥后重跑导入 ——");
									doRun("/import", { ...payload, secrets: vals }, false);
								});
							}
						})
						.catch((e) => say("请求失败：" + e, true))
						.finally(() => {
							btnRun.disabled = false;
							btnRun.textContent = prev;
						});
				};

				btnRun.onclick = () => {
					const names = state.plugins.filter((p) => state.selected.has(p.name)).map((p) => p.name);
					if (mode.value !== "import" && !names.length) return say("请先勾选插件", true);
					const payload = { profile: state.profile, names };
					let path = "/export";
					if (mode.value === "import") {
						if (!pkgPath.value.trim()) return say("请填写迁移包路径", true);
						path = "/import";
						payload.pkgPath = pkgPath.value.trim();
						payload.root = srcRoot.value.trim();
						payload.dryRun = dryBox.checked;
					} else if (mode.value === "copy") {
						path = "/copy";
						payload.targetProfile = targetSel.value;
						payload.dryRun = dry2Box.checked;
					} else {
						payload.outDir = outDir.value.trim();
					}
					doRun(path, payload);
				};

				root.append(page);
				refresh();

				return () => { root.textContent = ""; };
			}, []);

			return react.createElement("div", { ref: hostRef });
		}

		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "plugin-migrator",
				order: 55,
				label: () => "DSH 迁移",
			}, () => react.createElement(MigratorPage))), "plugin-migrator: settings page");
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
