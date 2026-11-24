# 腾讯会议录制批量下载助手 · 源码

当前版本：**v1.8.23**（MIT 开源，无任何使用限制）

完整说明、安装方法、致谢与联系方式见仓库根目录的 [README](../README.md)。

## 目录

| 文件 | 作用 |
|---|---|
| `manifest.json` | 扩展清单（Manifest V3） |
| `background.js` | 后台：消息路由、下载命名、离屏文档生命周期 |
| `content.js` | 录制页脚本：采集清单、筛选、勾选、导出编排 |
| `batch.js` / `batch.html` / `batch.css` | 工作台界面（独立页与页面内抽屉共用） |
| `panel.js` / `panel.css` | 页面内抽屉外壳：贴边把手 + 右侧滑出 |
| `detail-transcript.js` | 详情页抓逐字稿（接口优先，DOM 兜底） |
| `detail-service.js` | 逐字稿导出编排：开页、抓取、存文件 |
| `file-check.js` / `file-check.html` | 离屏文档：建 blob 链接、本地文件校验 |
| `license.js` / `license-ui.js` | **开源版**：恒放行，不渲染激活界面 |
| `shared-*.js` | 「下载他人分享课程」链路 |
| `own-export.js` | 页面导出菜单的定位与点击 |
| `site-adapter.js` | 站点选择器 / 分类规则 |
| `tests/` | 单元与契约测试 |

## 跑测试

```bash
node --test tests/*.test.cjs
```

## 两条硬规矩（改代码前先看）

1. **站点接口路径判断只用 `endsWith` 或正则，禁止 `===`** ——
   腾讯真实接口带长前缀（如 `/wemeet-cloudrecording-webapi/v1/minutes/detail`），
   用 `===` 会永远匹配不上。
2. **MV3 service worker 里没有 `URL.createObjectURL`；offscreen 文档里只有 `chrome.runtime`**
   —— 建 blob 链接要在 offscreen 做，下载要在 service worker 做，靠 `runtime.sendMessage` 桥接。

## 打包 zip 给 Chrome 拖装

- `manifest.json` 必须在压缩包**根目录**
- 压缩包内路径**全 ASCII**（中文说明文件不要放进包里）
- 用 `zipfile` 写包并设 UTF-8 文件名标记

## 致谢

逐字稿取数思路参考了 [Babywbx](https://github.com/babywbx/Tencent-Meeting-Transcript-Exporter) 的
《腾讯会议逐字稿导出》用户脚本（MIT）。
