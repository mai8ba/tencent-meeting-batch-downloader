# 测试说明

> v1.8.17 起本项目开源（MIT），**试用/激活码/联网校时已全部取消**，
> 对应的 `license.test.cjs` 与 `network-time.test.cjs` 一并移除；
> 开源约束由 `panel.test.cjs` 里的契约用例守住（恒放行、不联网校时）。

运行全部用例：

```bash
node --test tests/*.test.cjs
```

单跑某个文件（输出更直观）：

```bash
node tests/regression.test.cjs
```

## 文件清单

| 文件 | 覆盖内容 |
|---|---|
| `journal.test.cjs` | 下载凭据持久化、**按下载记录判定完成（不读文件）**、字节不完整/文件被删仍失败、认领历史下载、暂停续传、索引 |
| `shared.test.cjs` | 分享文本解析、`common-record-info`/`minutes/detail` 提取、DOCX 生成、分享任务状态机、正文按需读写 |
| `shared-password.test.cjs` | 受控输入的 React 状态同步、遮罩密码、按钮框架处理器兜底 |
| `regression.test.cjs` | 后台租约与命名、录制页并发导出、选择集、悬浮球挂载 |
| `batch.test.cjs` | 工作台纯函数（转义/筛选/进度）+ `tmeet.batch` 消息契约（来源白名单、snapshot、filter、select、collect/export/stop/reset） |
| `site-adapter.test.cjs` | 站点选择器契约（DOM 快照）+ 文件类型分类 |
| `own-export.test.cjs` | 导出弹窗定位与重建、多弹窗保护、按钮不可用 |
| `local-files.test.cjs` | 目录授权探测（probe）；DOCX 完整性判定（空模板 / 只生成标题 / 正常 / 截断） |
| `dir-match.test.cjs` | 目录一致性（主流程已不要求授权）：locate 报错带实际路径、`contains` 实测、导出前置不再要求选文件夹 |
| `visibility.test.cjs` | 页面可见性：导出前切前台、挂起等待不报错、后台 focus-recording-tab、报错写明"不在前台"（5 项） |
| `panel.test.cjs` | 面板架构契约：manifest 注入顺序、资源 web_accessible、面板直连 TMeetEngine、进度同页直推、open-url 白名单、**结构自检+失败可见**、**第1步禁止调 open-recordings**、**更多菜单已下线**（9 项） |
| `e2e-cdp.mjs` | 真浏览器 E2E（CDP）：扩展加载、五步结构、未连接时的按钮状态、deflate DOCX 校验、无 JS 异常。**不在 `node --test` 里跑**，见下方说明 |
| `e2e-flow.mjs` | 真浏览器 E2E：用 Fetch 拦截造一个假录制页，跑通 注入→悬浮球→连接→采集→搜索/筛选→导出前置拦截（32 项） |
| `e2e-multipage.mjs` | 真浏览器 E2E：65 条 / 7 页的翻页采集，验证不重复、不遗漏、回到首页、每页条数生效（20 项） |
| `e2e-lib.mjs` | E2E 公共脚手架：CDP 连接、页面求值、拦截造页、**接管后台校时**、清草稿、**清本地目录句柄**、清残留标签页。非用例文件 |
| `run-e2e.mjs` | 一键串行跑上面三个 E2E，最后打汇总（73 项） |
| `mini-dom.cjs` | 测试用极简 DOM（后代选择器/逗号分组/tag/.class/#id/属性选择器），非用例文件 |

## 真浏览器 E2E（改界面 / 校验 / 通信后必跑）

`node --test` 用的是 vm 桩：测不到 content script 真实注入、消息通道、tab 查询、storage 行为，
DOCX 也只覆盖 ZIP store 模式（腾讯导出的其实是 deflate）。

**启动调试浏览器**（Chrome 137+ 已禁用 `--load-extension`，必须用这个开关）：

```bash
"C:/Program Files/Google/Chrome/Application/chrome.exe"   --remote-debugging-port=9223 --user-data-dir=C:/tmeet-e2e   --enable-unsafe-extension-debugging --no-first-run about:blank
```

**跑**：

```bash
node tests/run-e2e.mjs          # 三个一起跑（约 1 分钟）
node tests/e2e-flow.mjs         # 或单独跑某一个
```

三个脚本各自覆盖：

| 脚本 | 覆盖 | 项数 |
|---|---|---|
| `e2e-cdp.mjs` | 扩展加载、五步结构与编号、未连接时按钮状态、deflate DOCX 三档判定、无 JS 异常 | 21 |
| `e2e-flow.mjs` | 假录制页注入 → 悬浮球几何 → 工作台连接 → 采集解析（标识/类型/会议号/时间/大小）→ 搜索 → 类型筛选即勾选 → 未授权导出被拦 | 32 |
| `e2e-multipage.mjs` | 65 条 / 7 页翻页采集 → 唯一性 → 连续覆盖 → 回首页 → **带单位的每页条数文案（"30 条/页"）** → 收尾后按钮自愈 | 20 |

**四条让 E2E 稳定可复现的约定**（都已在 `e2e-lib.mjs` 落实）：

1. **接管后台校时**：`authorize` 每次都联网取时间。不接管的话，公网抖一下采集就失败，
   测试结果分不清是产品坏了还是网不好（实际踩过）。
2. **清掉上轮草稿**：不清会先显示上轮的数据，断言假通过、随后 collect 又清空，非常迷惑。
3. **关掉残留录制页标签**：上轮跑挂留下的旧页面会让 `tabs.query` 挑到失联页面。
4. **断言要等状态落定**：清单条数到位 ≠ 收尾完成。采集刚结束时就采样 busy 状态，
   会把"还在收尾"误判成"永久卡住"——这个坑本轮踩过两次。

- 端口用 `CDP_PORT` 覆盖；连不上会打印 skipped 并以 0 退出，不误报失败。
- 换成品目录名时同步改各脚本顶部的 `EXT_DIR`。

## 约定

- 新增用例放 `tests/*.test.cjs`，并在上表登记一行。
- 需要 DOM 的用例优先复用 `mini-dom.cjs`；不要引入 jsdom 等外部依赖（源码目录保持零依赖）。
- 涉及真实站点的选择器，只断言"能命中快照里的目标节点"，不要断言坐标、样式或动画。


## 2026-10-30 真实下载回归

`download-click.test.cjs` 在独立 Edge 配置下测试真实下载，不访问用户现有账号和标签页。默认跳过；显式设置 `TMEET_BROWSER_E2E=1` 后运行 `node --test tests/download-click.test.cjs`。需要本机Playwright、Edge及原密钥生成器路径（可用 `TMEET_GENERATOR_PATH` 指定）；私钥只在内存中读取，不进入日志或产物。

全部自动回归建议：`node --test --test-concurrency=1 tests/*.test.cjs`。Node 25在并发输出跨VM错误时曾出现测试运行器反序列化异常，串行执行可避免运行器干扰，断言保持不变。

独立浏览器的原有三套E2E可通过 `CDP_PORT` 指定端口。本轮使用9347，避免连接或清理用户浏览器。
