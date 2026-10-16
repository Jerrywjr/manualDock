# 模块与接手路径

先读 [当前状态和未关闭问题](project-status.md)，再读 [维护边界](../AGENTS.md)。本文说明当前实现如何分工；逐文件的重要函数见 [开发索引](development.md#运行文件逐项索引)。可检查的完整文件归属、跨模块依赖和回归入口在 [modules.json](modules.json)，执行 `npm run check:handoff` 可发现漏登记和依赖变动。目录布局保持原样。

## 状态由谁持有

例如在工作台连接两份手册：`source-controls → source-connector` 找到已打开的标签，`batch → runtime-client → background-runtime` 注册来源。每个来源对应一个 `SourceSession`，由它管理识别、采集、暂停和恢复；`ImportEngine` 推进队列，每章通过 `browser-io` 读取后交给 `task-store` 保存。控制页刷新只断开显示订阅；来源标签关闭才使该来源停止读取。移除来源和删除档案是不同操作。

| 模块       | 输入、输出与状态                                                         | 主要入口                                                                      |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 界面       | 后台快照和用户命令；本地草稿、栏目及分页。资料库展示只接收列表与动作回调 | `panel.js`、`library-view.js`                                                 |
| 来源连接   | URL、授权和已连接标签 → 可复用的来源；不能以满额为由拒绝复用已有来源     | `source-controls.js`、`source-connector.js`、`batch.js`                       |
| 后台通信   | 控制页请求 → 来源快照；后台拥有来源注册和恢复绑定                        | `background-runtime.js`、`runtime-client.js`                                  |
| 来源会话   | 每来源识别状态、任务、取消与恢复；用户暂停优先于重试时钟                 | `session.js`、`recovery.js`、`auto-retry.js`                                  |
| 采集执行   | 已验证章节队列 → 保存结果或明确错误；检查点逐章提交                      | `engine.js`、`browser-io.js`                                                  |
| 页面脚本   | 已校准区域 → 目录、身份、清理后的正文；不读取认证存储                    | `tree.js`、`manual-adapters.js`、`capture.js`                                 |
| 身份与配置 | URL/配置 → 章节键、规则身份、校验和内容哈希                              | `profiles.js`、`bind-check.js`、`sangfor-rules.js`、`core.js`                 |
| 持久化     | 任务、修订、删除标记；档案恢复保留本机冲突正文                           | `task-store.js`、`archive.js`                                                 |
| 导出       | 已清理的任务快照 → Markdown、HTML、JSON、报告字符串；无页面或数据库操作  | `exports.js`；`core.js` 兼容转发旧入口                                        |
| 规范解析   | 本地规范文本 → 队列及正文；不调用描述的接口                              | `openapi.js`、`vendor/yaml.js`                                                |
| 轮换       | 管理页配置 → 后台调度及来源页点击；独立于文档采集                        | `rotation-controller.js`、`navigation-discovery.js`、`navigation-rotation.js` |

页面脚本是注入来源页的经典脚本，不是 ES 模块：`browser-io.install()` 按顺序注入目录、适配器和正文脚本，分别提供 `SangforTree`、`SecurityManualAdapters`、`ManualCapture`。轮换页面脚本由轮换路径注入。`modules.json` 的 `dependsOn` 检查 ES 静态导入；这些注入顺序和全局对象不能仅靠静态导入表证明，必须跑浏览器操作回归。

## 这次实际拆分与保留的边界

0.3.7 将导出生成从 `core.js` 移到 `exports.js`，保留原导出 API；将资料库 DOM 渲染和容量计算从 `panel.js` 移到 `library-view.js`。`renderLibrary()` 只接收文档、任务项、格式化函数和打开/导出/删除回调，`libraryPageSize()` 只读取布局；确认框、任务锁、删除和当前任务清理仍由控制页负责。四种输出格式、页面布局、连接和轮换行为不变。`capture.js` 仍使用已验证的 0.3.6 读取器实现，诊断中的 `extractorVersion` 是读取器版本，不是扩展版本。

部分大文件仍未进一步拆分：`panel.js` 保留旧单来源兼容流程与多来源接线，`capture.js` 保留页面状态、清理与提取，`session.js` 管理完整来源生命周期。没有为了缩短行数批量搬动这些高风险路径；遇到相关问题时先补回归，再按独立输入、输出和状态所有权拆分。不得声称整个代码已经彻底解耦，也不能把本段当作下一位 agent 可以自行大改的授权。

## 修改前后都要更新的入口

1. 明确用户现象和范围，在 `project-status.md` 登记问题、证据、尚缺的验证与下一步；历史测试通过不能关闭新报告。
2. 用 `modules.json` 找文件、依赖和测试，再查 `development.md` 的重要函数。运行文件新增或职责变化时同步两处；新增跨模块依赖必须解释原因。
3. 修改源文件后同步镜像；行为或运行代码版本变化时同步清单、界面、package/lock、README 日志和当前状态。纯文档变动不升级版本。
4. 定向回归后执行 `npm run check`、`npm test`；影响界面或注入路径时再跑对应浏览器测试。记录日期、命令、结果、证据类型及失败限制。
5. 提交前运行 `npm run check:public`，审核暂存差异；不能 `git add .` 把个人历史或现场证据混进去。发布是单独动作，只有用户授权才 push。

`check:handoff` 防止版本、文件归属及静态依赖漂移，不能判断文字是否真实或设备是否兼容。`check:public` 只读校验发布白名单和常见隐私数据，不是通用秘密扫描。提交仍需人工检查。现有 `ci/check.yml` 是模板，GitHub 尚未自动执行它。
