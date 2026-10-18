# @dsh-external/dsh-plugin-migrator — 插件迁移器

在 DSH 桌面版 **设置 →「插件迁移」** 里勾选插件，做三件事：

| 操作 | 用途 |
| --- | --- |
| ① 导出迁移包 | 把选中插件打包成**一个文件夹 + 一个 zip**：本地插件附源码快照，远程插件只记版本声明 |
| ② 导入迁移包 | 把迁移包（文件夹或 zip）恢复到本机 profile：拷源码 + 写依赖/bundles + 建链接 + 迁 patch |
| ③ 搬到本机另一个 profile | 如 web → headless：写依赖 + 建 junction + 迁 patch 条目 |

恢复逻辑在**迁移包自带**的 `restore.mjs` 里（本插件导出时随包写入），所以在**别的机器**上不需要先装本插件：

```bash
node restore.mjs --list                      # 先看包里有什么
node restore.mjs --profile web --dry-run     # 预览会做什么（不写任何文件）
node restore.mjs --profile web --root D:/插件根目录   # 真正恢复
```

## 启动体检 与 dsh.bundle（DSH ≥ 0.1.2-rc.1 的硬要求）

新版 DSH 启动时会遍历 `profile/dsh.profile.bundles`，逐包读 `package.json` 的 **`dsh.bundle.patch`**；
取不到就抛 `profile bundle "..." declares no dsh.bundle in its package.json` 并**直接起不来**。
`dsh.bundle.patch` 同时也是「把自己挂载起来」的载体——patch 里的 `insert` 行就是插件的 loader 行。

本插件为此提供三样东西：

| 位置 | 作用 |
| --- | --- |
| 面板「**启动体检**」按钮 | 调用 DSH 自己的 `loadProfile()`（与启动同源），**不重启**就知道下次启动会不会挂 |
| 面板「**修复选中：dsh.bundle**」 | 给选中插件补 `cordis.patch.yml` + `dsh.bundle`（写前备份 `package.json`） |
| `tools/check-profile-boot.mjs` | 命令行版体检：`node tools/check-profile-boot.mjs [--profile web]`，退出码非 0 = 启动会失败 |

迁移流程还自带护栏：

- 导出：本地插件快照若缺 `dsh.bundle`，**只给快照副本补上**（不动你的源码），manifest 标 `bundleFieldAdded`
- 导入：跑包内脚本**之前**先给快照补齐字段（旧迁移包自带旧引擎、没这层护栏），跑完再自动做一次启动体检
- 恢复/搬运：包没到位、或没声明 `dsh.bundle.patch` → **只写 `dependencies`、不写进 `bundles`**，并给出修法

## 路径菜单（不用手打路径）

三个路径框右边都有按钮：**选择目录… / 选择包…**，点开是内置的目录浏览器：

- **快捷位置**：上次导出目录 · 默认迁移包目录 · 最近导出的包（最多 3 个）· 工作区 · 主目录 · `C:\` `D:\` `E:\`
- **面包屑**可点跳转；**上一级 / 主目录**；行内 `📁` 进目录
- **📦 + 「迁移包」标签** = 该目录本身就是迁移包，**点一下直接选中**（不用再进去找）
- 文件模式额外列出 `*.zip`，点一下就选中
- 底部可**新建文件夹**（父目录 = 当前层）
- 走过的路径不存在/读不了时，自动**回退到最近的已存在上级**并提示，不会卡在空列表

实现：走后端 `/plugin-migrator/api/browse`，优先用宿主 `ctx.directoryPicker`——
`browse` 后端 = 官方「添加工作区」对话框同一套列目录原语；`native` 后端则直接弹系统文件夹对话框，
回来后自动把路径填进输入框。宿主服务不可用时兜底自己读盘（`/mkdir` 同理）。

导出成功会记住位置（`<DSH_HOME>/plugin-migrator/state.json`），下次「选择包…」直接落在那里。

## 边界（不抢邻居的活）

- `dsh-super-injector` 的「插件管理」= 装卸**本机**插件（inject / uninstall）
- `dshmarket` = 从**市场**装插件
- 本插件只负责**搬迁**：导出 / 导入 / 跨 profile 搬运。不负责日常装卸。

## 写入面（唯一写入者）

| 目标 | 时机 | 保护 |
| --- | --- | --- |
| `~/.dsh/profiles/<profile>/package.json` | 导入 / 搬运 | 先写 `package.json.bak-<时间戳>` |
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | 导入 / 搬运（仅当有 patch 条目） | 先备份；**按 id 去重**，防 `duplicate loader entry id` 崩溃 |
| `<输出目录>/plugin-migration-<时间戳>/` 与 `.zip` | 导出 | 只新增，不覆盖已有目录 |
| `<源码根>/<插件目录>` | 导入 | 目标已存在时**保留原样**（要覆盖得显式 `--force`） |

不读写 `~/.dsh/docs/*`，不碰主包代码。

## 路径损坏自愈

本机 `profiles/web/package.json` 里本地插件的 `file:` 路径曾被编码转坏
（`file:D:/Deepseek?????dsh-xxx`，GBK↔UTF-8 往返写坏），指不到任何目录。扫描时按顺序回退：

1. 依赖声明 → 2. 注入记录 → 3. `node_modules` 安装副本 → 4. **按「插件源码根」猜测**

第 4 步从多数插件源码所在目录推出源码根（本机 = `D:\Deepseek工作区`），命中 `<源码根>/<包名>` 就认它，
列表里标「路径已修正」，导入/搬运时**写成正常路径**（顺带把坏声明修好）。

## agent 工具

| 工具 | 作用 |
| --- | --- |
| `plugin_migrator_list` | 列出某 profile 的插件（名称/版本/来源/目录/启用态/是否含 UI） |
| `plugin_migrator_export` | 导出迁移包 |
| `plugin_migrator_import` | 从迁移包恢复 |
| `plugin_migrator_copy` | 搬到另一个 profile |

宿主 API：`/plugin-migrator/api/{list,export,import,copy,inspect}`（`GET /list?profile=web` 可直接看诊断信息）。

## 实现要点（为什么长这样）

- **零构建**：本机没有 DSH 源码 checkout / tsc，`lib/index.js` 与 `lib/client.js` 都是手写
  （client 对齐本机跑通的 `@dsh-external/composer-attach` ModuleLoader 格式），改完即生效。
- **不 spawn 子进程**：本机插件进程里 `spawnSync('powershell')` 会被拒（EPERM），
  所以 zip 用 `lib/zip.mjs` 自己压/解（写 store、读兼容 store+deflate），恢复走**进程内** `import()`。
- **Config 不导出**：DSH 要求 `Config` 是 schemastery schema；本插件零依赖，配置走 patch 层或留空。

## 恢复后怎么生效

重启 DSH（桌面版：关窗口，再双击图标）。重启前设置页里只是列表刷新了而已。

---

## 0.2 新增：④ 全量整合包（给「全新 DSH」用）

① 导出迁移包只搬「插件本体」，适合已经知道怎么装的人。**④ 全量整合包把这台机器的「环境知识」也一起抽出来**：把这个包 + 一段提示词交给一台全新的 DSH，它自己就能搭起来。

面板：设置 →「插件迁移」→ ④ 全量整合包 →「生成整合包（后台）」，跑完点「导出…」「复制提示词」。

产物结构：

| 路径 | 内容 |
| --- | --- |
| `PROMPT.md` | **给全新 DSH 的施工提示词**（铁律 / 9 步施工顺序 / 症状→处置表 / 完成定义），整段可粘贴 |
| `TRICKS.md` | 通用踩坑总集：9 条铁律 + 7 步施工顺序 + 本机错误库命中行 |
| `catalog/<插件>.md` | 每插件一页：①身份 ②全部功能（工具/HTTP 接口/UI 槽位/环境变量/数据文件）③依赖与装配要点 ④搭建技巧（记忆库 facts/steps + 错误库命中）⑤版本变迁 ⑥文件清单 ⑦原 README 摘录 |
| `INSTALL.md` | 人读安装指南 + 每步验收标准 |
| `knowledge/` | AGENTS.md、agent-playbook、插件开发闭环技能、启动排查技能、写盘安全技能、错误库摘录（全部脱敏） |
| `manifest.allinone.json` | 机器可读全量清单，agent 以它为准 |
| `secrets.required.json` | 要填的密钥**字段**（不含值） |
| `packages/` | 本地插件源码快照（复用 ① 的密钥抹除与 bundle 修补） |
| `restore.mjs` / `恢复.bat` / `新机一键装.bat` | 自动恢复脚本 |

工具（agent 也能直接调）：

- `plugin_allinone_build` — 同步构建（`profile` / `outDir` / `includeSource` / `includeKnowledge`）
- `plugin_allinone_status` — 查后台任务（不给 jobId 就列最近任务）

HTTP：`POST /plugin-migrator/api/allinone/{start,export,open}`、`GET /plugin-migrator/api/allinone/{status,jobs,prompt}`

命令行（不经 DSH 也能跑同一份逻辑）：

```
node tools/allinone-build.mjs [--profile web] [--out DIR] [--no-source] [--no-knowledge]
```

设计取舍（实测踩到的）：

- **超大插件不附源码**：单插件 > 80MB（如带 7GB 本地模型的 dsh-video-lens）只出文档、不出快照，否则 zip 撑爆；catalog 与 PROMPT 里会标明「需另行取得」。
- **快照不带备份文件**：`.bak-xxx` 不进包（除了省体积，`.bak-….` 这种带尾点的名字落到 Windows 上就删不掉）。
- **知识层一律脱敏**：`sk-`/`ghp_`/Bearer/`apiKey: …` 这类值抹成 `<已抹除>`；密钥只留字段名。
- **版本变迁不编造**：来源只有三处（package.json 当前版本 / README 里的版本痕迹 / 记忆库该词条的修订史），并明确标注「记忆库修订史 ≠ 代码版本」。

---

## 0.3 新增：⑤ 整机迁移（换电脑用）

④ 是「让一台新 DSH 自己把插件搭起来」；**⑤ 是把这台机器的 DSH 整体搬走** —— 配置、记忆库、错误库、技能、会话历史、对话附件、插件源码、API 密钥，一个包，换机前后一模一样。

面板：设置 →「DSH 迁移」（原「插件迁移」）→ ⑤ 整机迁移 → 选档位 →「生成迁移包（后台）」→「导出…」。

### 三档范围

| 档位 | 内容 | 实测体积（本机） |
| --- | --- | --- |
| 精简 `essential` | ~/.dsh 的配置 + 记忆 + 技能 + 密钥（不含会话/附件/源码） | 1200 文件 / 55 MB |
| 标准 `standard` | + 会话历史 + 对话附件 + 工作区插件源码 | 约 960 MB |
| 最全 `everything` | + state 缓存 / 修复备份 / 浏览器运行时 / 整个工作区 | 十几 GB，按分钟计 |

### 包结构

| 文件 | 内容 |
| --- | --- |
| `01-dsh-home.zip` | ~/.dsh 的全部选中内容（包内前缀 `dsh-home/`） |
| `02-workspace.zip` | 工作区（包内前缀 `workspace/`） |
| `MANIFEST.json` | 逐文件 size / crc32 / **sha256** + 卷哈希 + 跳过的文件 |
| `MANIFEST.sha256` | 各卷自身哈希（传输校验） |
| `README-先读我.txt` | 含明文密钥的警示 + 三步恢复流程 |
| `PROMPT.md` | 给新机器 DSH 的恢复提示词（铁律 / 顺序 / 完成定义） |
| `restore-dsh.mjs` + `恢复-DSH.bat` | 恢复脚本（`--verify-only` / `--dry-run` / 真恢复） |

### 为什么自己写流式 zip（`lib/stream-zip.mjs`）

- **bsdtar（Windows 自带）不行**：写 zip 时按本地代码页存文件名、且不置 UTF-8 标志位（0x0800），换到非中文系统解包就是乱码 —— 与「无损」直接冲突。实测已复现。
- **原 `lib/zip.mjs` 不行**：内存实现（readFileSync + Buffer.concat 整包），十几 MB 没问题，上 GB 直接 OOM（实测 7GB 的 models 目录连 zip 都打不出来）。
- 现在的做法：自己写 local header / central directory / EOCD，文件名 UTF-8 + 置 flag；小文件（≤64MB）一次读入同时算 CRC32+SHA-256，大文件流式两遍，内存恒定；超过单卷上限就切卷，单文件超上限则跳过并记录。

### 无损怎么保证

实测（本机，精简档）：1200 个条目 → **1196 个字节级一致**，4 个 `profiles/*/package.json` 是**预期改写**（跨机路径必须改），0 缺失、0 不符。校验脚本 `tools/_verify-restore.mjs` 按 MANIFEST 逐文件比 sha256。

### 恢复流程（新机）

```
node restore-dsh.mjs --verify-only          # 先校验卷
node restore-dsh.mjs --dry-run              # 看计划，不写文件
node restore-dsh.mjs --workspace "D:\Deepseek工作区"   # 真恢复（覆盖前自动备份 .restore-backup-<ts>）
cd %USERPROFILE%\.dsh\profiles\web && pnpm install     # 依赖不随包走
```

恢复脚本会顺手做两件手工最容易忘的事：改写 `file:`/`link:` 里的来源机绝对路径、按新路径重建 `node_modules` junction；写不进去的文件全部进 `RESTORE-REPORT.json`。

### 边界

- **不打包**：`node_modules`（pnpm install 重建）、浏览器 profile（含 cookie，换机失效）、python 运行时、`models/` 本地模型、下载素材、以往迁移包（避免包里套包）。这些都列在 README 的「明确不进包」一节，不是静默遗漏。
- **超过单卷上限的单文件**（默认 1800MB）会跳过并逐条记进 `MANIFEST.skipped`。
- 含明文密钥 → 只在本人的机器之间传递；恢复完建议删包或轮换密钥。
