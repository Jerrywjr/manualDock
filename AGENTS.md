# ManualDock 维护边界

本文件是 GitHub 仓库中供维护人员和 AI 接手的约束入口。先读 [当前状态与未关闭问题](docs/project-status.md)、[模块边界](docs/architecture.md)，再读 [README](README.md)、[逐文件职责与问题索引](docs/development.md#接手阅读顺序) 和 [贡献约定](CONTRIBUTING.md)。用户当前明确授权优先；历史任务、旧报告和此文件都不是扩大修改范围的授权。

跨开发机或新对话接手时，补读 [2026-10-19 用户问题与功能期望交接表](docs/handoff-2026-10-19.md)。这是需求与当时状态的记录；之后的现状以 `docs/project-status.md` 和源码为准，不能把表中历史问题当作未授权的大改任务。

## 修改范围与源码入口

只修用户报告的问题。不要顺带重构、移动目录、改连接流程、轮换、界面、依赖或删除资料。先检查工作区已有改动，不覆盖他人的未提交内容。`extension/` 是唯一运行源码；`skill/import-security-manuals/assets/extension/` 是生成镜像，修改源文件后同步，不维护第二套实现。版本变动同步 manifest、界面版本、package/lockfile、镜像和 README 日志；纯文档变动不升级运行版本。

| 问题                             | 从哪里查                                                                                     | 不可绕过的检查                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 连接页面、复用标签、退出来源     | `source-controls.js`、`source-connector.js`、`batch.js`、`background-runtime.js`             | 复用已受控标签；移除连接不删除档案；最多同时连接 8 个来源          |
| 目录识别与换章                   | `manual-adapters.js`、`tree.js`、`browser-io.js`                                             | 目录与正文分离；不选歧义候选中的第一个；选中章节和正文切换均须确认 |
| 请求样例、返回样例、参数子树缺失 | `capture.js` 的 `bodyDisclosures`、`prepareContent`、`capture`；`browser-io.js` 的 `capture` | 检查实际内部内容，不能仅检查箭头或外层可见；展开后重新等正文稳定   |
| 保存、恢复、补采                 | `session.js`、`engine.js`、`task-store.js`、`archive.js`                                     | 按任务加锁；失败保留原文；禁止复活删除任务或静默覆盖恢复冲突       |
| 导出缺漏                         | `exports.js` 的 `buildExports`（`core.js` 保留兼容入口） 与原始档案 `pages`                  | 先查 JSON 内正文是否已经缺失，再查格式转换；换格式不能补回未采内容 |
| 菜单轮换                         | `rotation-controller.js`、`navigation-rotation.js`                                           | 独立于采集和控制页生命周期；不要把文档页注册成轮换管理页           |

## 采集能力与限制

目标是通用在线文档，但当前代码并不保证识别所有 HTML 布局。应按实际结构适配，而不是只按厂商或 API / CLI 名称套固定规则。目录导航树和正文参数树可能共用类名；例如 `.x-tree-root-ct` 既可能是目录 UL，也可能是正文中的 DIV 网格，必须核对区域与子结构。

自动展开目前只支持已唯一定位正文内的 `af-api-panel` 样例和 Ext 参数子树。请求、成功返回、失败返回是不同内容，都要逐项核验；样例代码的文字如 `POST /items` 只是文档，不能执行它。不能把任意 `button`、带“+”的元素或所有隐藏节点都点击/导出；其中可能含 API 执行、删除、登录表单或其他章节。真正的模态弹窗、正文区域之外的浮层、悬浮提示、未适配的折叠控件、虚拟列表、跨域框架、Canvas 图和未加载的数据均无通用完整性保证，需要实际页面证据和专项适配。缺内容应报错或注明限制，不能用显示状态伪造完整采集。

当前正文展开有 200 次点击、12 秒总等待和单项 2 秒等待上限；图片有单张 2 MiB、合计 15 MiB、最多 40 张及等待上限；任务队列最多 5000 章。达到上限意味着可能不完整，不能仅提高上限掩盖结构或登录问题。具体实现以 `capture.js` 和 `engine.js` 为准。禁止读取凭据、Cookie、认证存储或执行设备接口来补文档。

## 导出与旧档案

四种导出共用同一份已保存正文。Markdown 便于文本阅读，复杂表格可能保留 HTML，图片引用配套离线 HTML；离线 HTML 保留已采文字、表格、样例和内嵌图片，适合单文件阅读；JSON 包含各章正文及恢复元数据；报告记录进度、失败和警告。没有任何格式能保证恢复未加载或未采集的内容。不要因 Markdown 缺例子就先删除其他格式，先比对 `pages[key].html/markdown/text`。

旧版本已标为成功的章节不会因升级自动重采。0.3.6 的“重试问题项”可识别已知的空样例容器，在用户确认后补采，成功才替换原文；这不是任意内容缺失检测。未知缺漏需逐章核对或另行授权重采。只重新导出不会补全旧档案。

## 浏览器、系统与更新

这是 Manifest V3 浏览器扩展（第三版扩展清单），不是 macOS 原生应用。运行代码使用浏览器接口，没有本机 VPN 客户端、Node.js、Python 或 macOS 路径依赖。Windows 的 Chrome 可以按相同方式加载 `extension/`；Chrome 清单声明最低版本 110，使用当前稳定版更合适。Windows Chrome / Edge 尚无本仓库的实际验收记录，不能表述为“已经在 Windows 验证”。Edge 的 Chromium 扩展兼容性仍需按所用接口实测；Firefox、Safari 不在当前支持范围。企业策略可能禁止开发者模式或未打包扩展。

安装：打开 `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择包含 `manifest.json` 的 `extension/`。更新源码后，需要在扩展管理页点击该扩展“重新加载”，再重新打开控制页。控制页刷新、界面版本文字改变，不等于旧后台已重新载入。运行中升级可能中断当前一章；升级前暂停采集，保留来源标签和已保存任务，升级后续采。一般刷新/关闭控制页与升级扩展是两种不同操作。

VPN、设备认证、站点证书由用户所在电脑和浏览器负责；插件不会连接 Hillstone 或代替登录。同一浏览器安装内使用 IndexedDB 本地存储，没有云同步；跨电脑迁移需要 JSON 导出和导入。卸载扩展或清除扩展数据可能丢失本地档案。

官方参考：[Chrome 本地加载与重新加载](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)、[Microsoft Edge 扩展移植说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/port-chrome-extension)。这些说明支持平台用法，不代表本插件已通过目标系统验收。

## 验证和交付证据

先用用户提供的导出、保存网页或错误记录复现，再修改。不要改动原始证据；`internal/` 只用于本地资料，不进入 GitHub 或发布包。不得提交设备网页、私网地址、凭据、个人浏览器配置和测试生成文件。不要创建无关归档或下载包。

正文缺漏回归在 `tests/capture-disclosures.test.mjs`、`tests/content-preparation.test.mjs`；导出在 `tests/core.test.mjs`；补采入口在 `tests/integration-panel.test.mjs`。先运行定向回归，再运行 `npm test`、源码/镜像/格式检查。脚本生成的本地页面、保存的真实 DOM 配合模拟点击、真实浏览器、真实设备、Windows 运行，是不同证据：明确说明用的是哪一种，不把前一种结果说成后一种。报告实际保存的参数行和完整样例，不以控件已点击或页面状态为成功判据。未经目标设备验证，不宣称目标设备漏采已完全解决。

公开源文件导出与 ZIP 打包使用 `scripts/prepare_public.py` 和 `scripts/package_release.py` 的文件白名单。新增运行文件须登记 `docs/modules.json`，新增文档和测试须同步公开白名单。公开适配器名称不是私有设备资料；私网地址、个人路径、设备网页和浏览器档案仍禁止发布。`npm run check:public` 只读检查，不生成副本或 ZIP；它不是通用秘密扫描，提交前仍须审核暂存内容。

每次交付更新 `docs/project-status.md`：问题现象、证据类型、当前状态、尚缺验证和下一步。`npm run check:handoff` 检查运行文件归属、静态模块依赖、回归文件和发布版本，不证明文档语义真实或设备功能正常。只有达到问题列出的关闭条件才可标为已解决；本地通过与设备通过分开记录。
