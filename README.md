# Plugin Porter · DSH 插件搬家工具

> 把 DSH 的插件、配置、记忆、会话，打包带走。
> 换电脑、换 profile、给别人分享工作环境——一个包搞定。

**Plugin Porter** is a plugin migrator / backup tool for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai):
export a migration bundle, import it on another machine, copy plugins to a different profile,
or move the whole environment — config, memory, sessions, attachments, plugin sources —
in one checksummed, multi-volume archive. Cross-machine, cross-profile, one command.

[![License](https://img.shields.io/badge/license-BSD--3--Clause-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-0.1.2%2B-blue)](#三分钟装好)

---

## 这东西解决什么问题

装了几十个插件、调了半天配置、攒了几百条记忆——**换台电脑全没了**。这个插件就是干这个的。

| 你的处境 | 它怎么帮你 |
| --- | --- |
| 买了新电脑，不想重装一遍插件 | **整机迁移**：一个包，配置/记忆/会话/插件全带走 |
| 只想把某几个插件搬到另一台机器 | **迁移包**：勾选 → 导出 → 那边导入 |
| 想让同事体验你的插件组合 | **全量整合包**：连"怎么装、有什么坑"一起打包，附一段提示词 |
| 想试试 headless 模式又不想重装 | **搬到别的 profile**：一键复制过去 |

---

## 三分钟装好

### 方式 A：从设置里装（推荐）

1. 打开 DSH → **设置 → 插件 → 添加插件**
2. 填这一行：

   ```
   github:chenzhihan1751-cyber/plugin-porter
   ```

3. 装完**重启 DSH**（关窗口，再双击图标）
4. 设置里多出一个 **「插件迁移」** 页

### 方式 B：下载 zip 手动装

1. 点右上角 **Code → Download ZIP**
2. 解压到任意目录（比如 `D:\plugin-porter`）
3. 双击目录里的 **`install.bat`**
4. 重启 DSH

> 装不上？见 [FAQ](#faq)。

---

## 五个功能，一眼看懂

打开 **设置 → 插件迁移**，面板上一排五个区块：

| # | 功能 | 一句话 |
| --- | --- | --- |
| ① | **导出迁移包** | 勾选插件 → 打包成一个 zip |
| ② | **导入迁移包** | 选包 → 恢复到本机 |
| ③ | **搬到别的 profile** | web → headless，插件复制过去 |
| ④ | **全量整合包** | 连"怎么装、有哪些坑"一起打包 |
| ⑤ | **整机迁移** | 配置+记忆+会话+插件，换电脑用一个包 |

---

### ① 导出迁移包

**什么时候用**：只想搬插件，不想搬别的。

1. 左侧列表勾选要带走的插件
2. 右侧选输出目录（点 **选择目录…** 有可视化浏览，不用手打路径）
3. 点 **导出迁移包**

产出一个文件夹 + 一个 zip：

```
plugin-migration-20261018-1430/
├── manifest.json        ← 清单：有哪些插件、版本、来源
├── restore.mjs          ← 恢复脚本（包自带，换电脑不用先装本插件）
├── restore.bat          ← Windows 双击也能跑
└── plugins/
    └── dsh-xxx/         ← 本地插件连源码一起打包
```

> 远程插件（从 npm / GitHub 装的）只记版本号，恢复时自动重新拉取，包体很小。

---

### ② 导入迁移包

**最省事的做法**：把整个包拷到新电脑，双击包里的 `restore.bat`。

想先看看会发生什么（推荐）：

```bash
node restore.mjs --list
```

```
包里 6 个插件：
  dsh-ai-memory        0.9.2   本地源码
  dsh-cost-meter       0.4.1   本地源码
  dshmarket            1.66.9  npm
  ...
```

预览（不写任何文件）：

```bash
node restore.mjs --profile web --dry-run
```

确认没问题再真正恢复：

```bash
node restore.mjs --profile web --root D:\我的插件
```

也可以回到 DSH 界面里做：**插件迁移 → ② 导入迁移包 → 选择包…（zip 或文件夹都行）→ 导入**。

**恢复完必须重启 DSH**，插件才会真正加载。

---

### ③ 搬到本机另一个 profile

**什么时候用**：你平时用 `web`，想再开一个 `headless` 跑后台任务，插件想复用。

1. 勾选插件
2. 在 **③** 区块填目标 profile（比如 `headless`）
3. 点 **复制到目标 profile**

它会做三件事：写依赖声明、建目录链接、迁移 patch 条目（自动按 id 去重，不会造成启动崩溃）。

---

### ④ 全量整合包：把"使用经验"也打包

**什么时候用**：把环境交给一台**全新的 DSH**，或者分享给别人。

跟 ① 的区别：① 只给"插件本体"，对方还得自己摸索怎么装；④ 把**踩过的坑、搭建步骤、提示词**一起抽出来。

点 **④ 全量整合包 → 生成整合包（后台）**，跑完得到：

| 文件 | 内容 |
| --- | --- |
| `PROMPT.md` | 一段提示词，**整段粘给新 DSH 的对话框**，它自己照着搭 |
| `TRICKS.md` | 通用踩坑总集 |
| `catalog/插件名.md` | 每个插件一页：功能、依赖、装配要点、版本变迁 |
| `plugins/` + `restore.mjs` | 插件本体与恢复脚本 |

**用法**：新机器上装好 DSH → 开个对话 → 粘贴 `PROMPT.md` 全文 → 它自己开工。

---

### ⑤ 整机迁移：换电脑的终极方案

**什么时候用**：真的换机器了，想把这一整套环境原样搬过去。

勾选范围（三档）：

| 档位 | 包含 | 体积 |
| --- | --- | --- |
| `essential` | 配置 + 记忆 + 技能 | 最小，够用 |
| `standard` | 上面 + 会话 + 附件 + 插件源码 | 日常推荐 |
| `everything` | 上面 + 整个工作区 | 可能几个 GB |

点 **生成整机迁移包**，它会：

- 打成**分卷**（默认每卷 1.8GB，方便网盘/U 盘传）
- 每卷附 **sha256** 校验清单（传坏了能发现）
- 包内自带 `恢复-DSH.bat` / `restore-dsh.mjs`

新电脑上：解压 → 双击 `恢复-DSH.bat` → 按提示选目标目录 → 完事。

> ⚠️ 包里含 API 密钥。要传给别人的话，先只选 `essential`，或者手动删掉密钥段。

---

## 迁移包里到底装了什么

```
manifest.json    清单（版本、来源、校验和）
restore.mjs      恢复脚本 —— 纯 Node，不依赖本插件
restore.bat      Windows 双击入口
plugins/         本地插件的源码快照
```

关键点：**恢复脚本跟着包走**。所以新电脑上不需要先装 Plugin Porter，直接 `node restore.mjs` 就行。

---

## 安全吗

| 它可能碰到 | 保护措施 |
| --- | --- |
| `profiles/<名字>/package.json` | 改之前先存 `package.json.bak-时间戳` |
| `profiles/<名字>/cordis.patch.yml` | 先备份；按 id 去重，防 `duplicate loader entry id` 启动崩溃 |
| 你的插件源码目录 | 目标已存在就**原样保留**，要覆盖必须显式加 `--force` |
| 导出的包 | 只新建目录，**不覆盖**已有同名目录 |

它**不碰** DSH 主程序代码，也不改你的插件源码（导出时只给快照副本补字段）。

---

## 启动体检：装完先自检

DSH 新版本对插件有个硬要求：每个插件必须在 `package.json` 里声明 `dsh.bundle.patch`，缺了**启动直接失败**。

面板上的 **「启动体检」** 按钮 = 用 DSH 自己的加载逻辑先跑一遍，**不用重启**就知道下次启动会不会挂。

也可以用命令行：

```bash
node tools/check-profile-boot.mjs --profile web
```

退出码 `0` = 没问题，非 `0` = 启动会失败（会告诉你是哪个插件）。

真出问题了，面板上有 **「修复选中：dsh.bundle」**，一键补齐并备份原文件。

---

## 恢复后怎么生效

**重启 DSH**。桌面版：关掉窗口，再双击图标。

重启前设置页里只是列表刷新了而已，插件代码还没加载。

---

## FAQ

**Q：装完设置里没看到「插件迁移」？**
重启 DSH。插件的 UI 是启动时挂载的，热更新不覆盖这一层。

**Q：导入后插件列表有了，但功能没生效？**
同上，重启。列表刷新 ≠ 插件加载。

**Q：恢复脚本报 `Cannot find module`？**
Node 版本太低。要求 **Node ≥ 22**：`node -v` 看一下。

**Q：包传过去 sha256 对不上？**
传输过程损坏（网盘/U 盘常见）。重新传那一卷，别硬解压。

**Q：会覆盖我现有的插件吗？**
不会。目标目录已存在时保留原样；要覆盖得自己加 `--force`。

**Q：能只导出某一个插件吗？**
可以，列表里只勾那一个就行。

**Q：和「插件市场」有什么区别？**
市场负责**装新插件**，这个负责**搬已有的**。两者不冲突，可以同时装。

---

## 开发者

- 零构建：`lib/` 里的 JS 就是源码，改完重启即生效
- 不 spawn 子进程：zip 用自带的 `lib/zip.mjs` 压缩/解压
- 实现细节、边界、设计取舍 → [docs/INTERNALS.md](docs/INTERNALS.md)
- Agent 工具：`plugin_migrator_list` / `_export` / `_import` / `_copy`

```bash
git clone https://github.com/chenzhihan1751-cyber/plugin-porter.git
cd plugin-porter
node install.mjs        # 装进本机 DSH
```

---

## License

BSD-3-Clause
