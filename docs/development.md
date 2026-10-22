# 开发与代码结构

运行端是 Chrome Manifest V3 扩展，依赖浏览器本地存储与页面脚本，不需要 Node.js 服务。开发使用 Node.js 22+、Python 3、jsdom、fake-indexeddb 和隔离的 Playwright Chromium。

当前入口：[状态与未关闭问题](project-status.md) · [模块边界和调用路径](architecture.md) · [完整模块清单](modules.json)。以下版本段落是历史说明，不是新需求。

## 接手阅读顺序

本文按当前仓库文件核对职责；后面的版本段落保留历史设计背景。开始工作先确认用户报告的现象、预期行为和允许修改的范围，再沿对应调用链阅读。不要把历史说明中的旧界面控件、旧状态或曾经通过的测试恢复为当前要求。

1. 从 [README](../README.md) 了解用户入口、当前版本与目录总览；从 [CONTRIBUTING](../CONTRIBUTING.md) 确认最小修改与验证要求。
2. 读 [manifest.json](../extension/manifest.json)：后台入口是 `background.js`，控制页是 `panel.html` 加载的 `panel.js`。这是浏览器扩展，不需要启动 Node.js 服务。
3. 使用下面的文件表和问题表定位本次路径。先看入口如何调用，再看状态归谁持有、结果如何回到界面，避免只改报错文案。
4. 读相关测试、[功能状态](function-status.md)和[验证记录](validation.md)。真实站点证据、本地浏览器夹具和纯单元测试是不同证据；未做的验证必须标明。

### 三种位置，不要混淆

控制页负责展示和下达命令；扩展后台持有运行会话、任务调度和正常菜单轮换；被连接的来源标签页提供目录与正文，接收经过校验的导航操作。`runtime-client.js` 把控制页的命令发到后台；`browser-io.js` 把后台采集操作交给来源页中的脚本。关闭控制页只断开订阅，关闭来源页则使该来源无法继续读取；两种关闭不能用同一个清理动作处理。

数据库与运行会话也要区分：`background-runtime.js` 保存“哪个标签页绑定哪个任务”，`task-store.js` 保存任务、章节正文、配置、修订号和删除标记。例如移除一个来源应取消连接，不应调用删除档案；重新连接已受控页面应复用会话，不应重新建立一套目录规则。

## 运行文件逐项索引

下表以 `extension/` 为根，列出全部运行文件及重要入口。带页面全局对象名的文件由脚本注入执行，不能当作后台模块直接调用；它们只能读取被授权的来源页面。

| 文件                      | 重要函数、对象或入口                                                                                       | 职责与修改边界                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `manifest.json`           | `background.service_worker`、`permissions`、`version`                                                      | 扩展清单、权限和版本；不是采集规则                                                       |
| `background.js`           | `chrome.action.onClicked`、`chrome.runtime.onMessage` 监听器                                               | 工具栏点击后查找或建立工作台、交付来源；启动后台运行管理                                 |
| `background-runtime.js`   | `createBackgroundRuntime()`、`request()`、`ensure()`、`persist()`                                          | 真正运行的来源会话、名额检查、后台恢复绑定和命令分派                                     |
| `runtime-client.js`       | `createRemoteSession()`、`listBackgroundSources()`、`createRemoteRotationController()`                     | 控制页与后台通信、同步状态；代理自身不承担采集调度                                       |
| `source-connector.js`     | `parseSourceURL()`、`connectionKey()`、`connectGranted()`、`waitForLoadedTab()`                            | 校验输入地址、请求网站授权、查找已有标签或开页、等待加载；不扫描正文                     |
| `source-controls.js`      | `setupSourceControls()`、`submit()`、`refresh()`                                                           | 顶部连接表单和来源下拉框；按当前栏目展示来源                                             |
| `batch.js`                | `setupBatch()`、`addSource()`、`removeSource()`、`startableSessions()`                                     | 多来源列表、分页、批量开始/暂停、移除确认；生产环境持有后台代理                          |
| `session.js`              | `SourceSession.connect/initialize/scanDirectory/start/pause/close`                                         | 单来源的规则、任务状态、扫描与恢复，连接和采集分开处理                                   |
| `panel.html`              | 表单、按钮、区域 ID、模块脚本入口                                                                          | 控制页结构；改 ID 前核对 `panel.js`、连接控件和界面测试                                  |
| `panel.css`               | 窗口、面板、列表和预览样式                                                                                 | 固定整页、列表分页布局、内部预览滚动；不负责任务状态                                     |
| `panel.js`                | `showMode()`、`selectSession()`、`scanSelected()`、`rotationTrial()`、`library()`                          | 栏目选择、校准草稿、试运行、预览与资料库；仍含兼容执行路径，不能把全部状态误认为后台状态 |
| `bind-check.js`           | `classifyBind()`、`loginURL()`                                                                             | 打开旧任务前的地址范围与登录页检查；不注入页面、不执行采集                               |
| `profiles.js`             | `validateProfile()`、`normalizeDocumentURL()`、`cleanChapter()`、`ruleSignature()`、`selectSavedProfile()` | 规则校验、章节身份、手册范围和历史匹配；不能为续采随意放宽范围                           |
| `sangfor-rules.js`        | `normalizeURL()`、`validateLocator()`、`mergeLinks()`                                                      | 已知手册链接和 Ext 树定位格式的兼容规则；名字不代表所有网站只能走这套规则                |
| `browser-io.js`           | `createBrowserIO()`、`install()`、`capture()`、`prepare()`、`recover()`                                    | 注入 `tree.js`、`manual-adapters.js`、`capture.js`，导航章节、等待正文切换、恢复前核对   |
| `manual-adapters.js`      | `SecurityManualAdapters`：`detect/bindings/discover/open/verify/current/pick`                              | 页面中的通用识别、区域绑定、章节定位、手动点选；Ext 树交给 `tree.js`                     |
| `tree.js`                 | `SangforTree`：`directoryRoots/scan/open/current/verify`                                                   | 限定 Ext 树目录范围、识别分支与路径、确认当前章节；正文参数网格不能混入目录              |
| `capture.js`              | `ManualCapture.capture/readState/prepareContent`；`buildHTML()`、`embedImages()`                           | 正文就绪状态、文字/表格/图片提取与清理；不负责整本任务排程                               |
| `engine.js`               | `createTask()`、`ImportEngine.merge/scan/run/checkpoint`                                                   | 章节队列、逐章推进、暂停、失败处理和检查点提交                                           |
| `task-store.js`           | `saveTask()`、`loadTask()`、`restoreWholeTask()`、`deleteTask()`、`subscribeTasks()`                       | IndexedDB 持久化、修订检查、删除标记和跨页面通知；正文的持久化依据                       |
| `recovery.js`             | `classifyRecoveryError()`、`scheduleRecovery()`、`pushFault()`、`collectionMessage()`                      | 错误分类、重试计划、脱敏记录和停止原因；不把所有失败都当作网络问题                       |
| `auto-retry.js`           | `AutoRetryClock`                                                                                           | 按已保存恢复状态安排自动重试，用户暂停后取消；不负责章节提取                             |
| `archive.js`              | `parseArchive()`、`mergeArchive()`                                                                         | 导入档案的格式校验、内容清理和冲突合并；不自动启动采集                                   |
| `core.js`                 | `contentHash()`，兼容转发身份与导出函数                                                                    | 内容哈希与历史入口；导出实现在 exports.js                                                |
| `exports.js`              | `archiveFor()`、`hasMissingExamples()`、`markdownBody()`、`buildExports()`                                 | 已保存正文的字段筛选、缺漏提示、四种格式生成；无浏览器和存储操作                         |
| `library-view.js`         | `renderLibrary()`、`libraryPageSize()`                                                                     | 资料库条目与容量，只回调打开/导出/删除；确认、锁和持久化留在 panel.js                    |
| `openapi.js`              | `parseSpecification()`、`SpecificationError`                                                               | 把 OpenAPI / Swagger 规范解析为本地任务；不执行规范中的接口                              |
| `rotation-controller.js`  | `createRotationController()`、`start()`、`stop()`、`snapshot()`、`resumeData()`                            | 后台正常菜单轮换的定时、来源锁、计数及恢复；不依赖当前栏目                               |
| `navigation-discovery.js` | `SecurityNavigationDiscovery`、`discover()`                                                                | 在来源页识别可用管理导航和菜单标签                                                       |
| `navigation-rotation.js`  | `SecurityNavigationRotation`：`prepare/execute/stopManaged`                                                | 在来源页执行经过校验的导航点击，支持管理运行及旧入口；不等同于后台调度器                 |
| `vendor/yaml.js`          | `parseDocument`                                                                                            | 由 esbuild 生成的本地 YAML 解析库；修改依赖时重建，勿手工改压缩产物                      |
| `vendor/yaml.LICENSE.txt` | 第三方许可证                                                                                               | 随 YAML 解析库分发，必须保留                                                             |

## 仓库配套文件

| 路径                                                | 用途、入口与注意事项                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                         | 用户和维护者总入口、安装概览、仓库结构和版本日志                                                                            |
| `使用说明.md`                                       | 用户操作细节；界面变化时核对相关步骤，不据旧文案恢复已移除功能                                                              |
| `CONTRIBUTING.md`                                   | 修改范围、源码与镜像关系、验证及交付约定                                                                                    |
| `docs/development.md`                               | 本文：文件职责、调用关系、定位与开发方法                                                                                    |
| `docs/function-status.md`                           | 功能实现状态与边界，不是通过测试的证明                                                                                      |
| `docs/validation.md`                                | 按时间记录执行过的测试、证据位置和未验证事项；数字属于当时的源码                                                            |
| `package.json`                                      | 开发依赖及 `scripts` 命令；当前 `test` 只匹配 `tests/*.test.mjs`                                                            |
| `package-lock.json`                                 | 锁定依赖版本；修改依赖或项目版本时核对，不能只改顶层清单                                                                    |
| `.editorconfig`                                     | 编辑器统一缩进、换行与字符编码                                                                                              |
| `.prettierrc.json`、`.prettierignore`               | Prettier 格式选项与排除范围；不要格式化 vendor、镜像或本机报告                                                              |
| `.gitignore`                                        | 本机依赖、日志、临时资料及生成报告的版本控制排除规则                                                                        |
| `LICENSE`                                           | 本项目 MIT 许可证                                                                                                           |
| `ci/check.yml`                                      | Continuous Integration（持续集成）模板，含检查、测试及打包步骤；当前不在 `.github/workflows/`，不能声称 GitHub 自动运行了它 |
| `skill/import-security-manuals/SKILL.md`            | 可选技能的使用入口；安装技能与安装扩展是两件事                                                                              |
| `skill/import-security-manuals/agents/openai.yaml`  | 技能的显示名称、说明与默认提示词                                                                                            |
| `skill/import-security-manuals/references/usage.md` | 技能内的当前使用参考；单独安装技能时也须保留能力限制和未验证项                                                              |
| `skill/import-security-manuals/assets/extension/`   | 运行源码的生成镜像，逐项对应上表；不能单独维护或当作第二个开发入口                                                          |
| `node_modules/`、`internal/`、`docs/` 下生成报告    | 本机依赖与验证产物；未纳入版本控制的文件在新克隆中可能不存在，不能伪造或补写历史结果                                        |
| `.git/`、`.DS_Store`、`.workbuddy/memory/`          | 分别是版本元数据、系统文件、已有工具的历史笔记；不是产品运行源码，也不是本任务的清理范围                                    |

### 开发与档案脚本

| 脚本                                                       | 重要函数或入口                                                            | 读取与写入、何时使用                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/check-handoff.mjs`                                | `inventory()`、版本/归属/依赖检查                                         | 只读检查 modules.json 全覆盖、跨模块静态导入、回归路径和发布版本                                                                 |
| `scripts/check-source.mjs`                                 | 顶层遍历、`node --check`                                                  | 只解析 `extension/`、`scripts/`、`tests/` 顶层 JavaScript；不启动页面、不验证业务行为                                            |
| `scripts/sync-assets.mjs`                                  | `sync()`、`--check`                                                       | 默认将 `extension/` 同步到技能镜像；`--check` 只检查内容一致性。只改文档不需要同步                                               |
| `scripts/build-openapi-vendor.mjs`                         | 顶层 `build()`                                                            | 从本地 `yaml` 依赖生成 `extension/vendor/yaml.js` 和许可证；只在依赖或打包需求变化时运行                                         |
| `scripts/package_release.py`                               | `checked_path()`、`check_public_content()`、`runtime_hashes()`、`build()` | 检查明确清单，重建技能镜像，写入 `docs/release-extension.sha256.json` 和根目录版本 ZIP；会删除再重建镜像，不是普通验证命令       |
| `scripts/prepare_public.py`                                | `collect()`、`export()`、`--check`                                        | `--check` 只读核验；默认检查公开文件并导出独立目录；更新已有导出需标记文件。会写入指定目标，严格限定仓库内工作时不能运行外部导出 |
| `skill/import-security-manuals/scripts/inspect_archive.py` | `inspect()`、`main()`、`_embedded_images()`                               | 读取 schemaVersion 1/2 的已导出档案，统计保存与缺失项、检索章节并输出到终端；不访问来源网站、不执行正文中的命令                  |

## 按问题选择源码与回归

先跑能重现所报问题的最小测试，再按受影响边界补验。表中浏览器回归使用本地合成页面；不等于真实设备验收。下列文件都位于 `tests/`。

| 用户现象                                                   | 优先追踪的源码                                                                                            | 对应测试文件                                                                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展图标反复打开控制页、来源交付丢失                       | `background.js`                                                                                           | `background.test.mjs`                                                                                                                           |
| 顶部下拉框错误、重复开来源页、满额无法复用、移除后仍占名额 | `source-controls.js` → `source-connector.js` → `batch.js` → `background-runtime.js`                       | `source-controls.test.mjs`、`source-connector.test.mjs`、`batch.test.mjs`、`background-runtime.test.mjs`                                        |
| 刷新控制页中断、多个来源互相影响、恢复绑定不对             | `runtime-client.js` → `background-runtime.js` → `session.js`                                              | `runtime-client.test.mjs`、`session.test.mjs`、`background-runtime.test.mjs`、`runtime.browser.mjs`、`workspace.browser.mjs`                    |
| 栏目切换、草稿丢失、按钮启用、旧档案绑定失败               | `panel.js`、`bind-check.js`、`profiles.js`                                                                | `integration-panel.test.mjs`、`panel-bind.test.mjs`、`integration-profiles.test.mjs`、`workspace.browser.mjs`                                   |
| CLI 或 API 目录识别不到、参数表混入目录、扫描慢            | `manual-adapters.js` → `tree.js`；`session.js` 扫描调用                                                   | `manual-adapters.test.mjs`、`directory-scan.test.mjs`、`recognition.browser.mjs`、`scan-workspace.browser.mjs`；API 与 CLI 两种结构都要保留回归 |
| 章节没有真正切换、抓到旧正文、表格或图片丢失               | `browser-io.js` → `manual-adapters.js` / `tree.js` → `capture.js`                                         | `browser-io.test.mjs`、`capture.test.mjs`、`generic-capture.test.mjs`、`universal.browser.integration.mjs`                                      |
| 正文参数“+”或请求／返回样例遗漏                            | `browser-io.js` → `capture.js`                                                                            | `capture-disclosures.test.mjs`、`content-preparation.test.mjs`                                                                                  |
| 手册范围或章节身份错误、配置互相覆盖                       | `profiles.js`、`sangfor-rules.js`、`session.js`                                                           | `profiles.test.mjs`、`core.test.mjs`、`integration-profiles.test.mjs`、`session.test.mjs`                                                       |
| 采集停止、重复重试、暂停后又自动运行                       | `session.js` → `engine.js` → `recovery.js` / `auto-retry.js`                                              | `engine.test.mjs`、`recovery.test.mjs`、`auto-retry.test.mjs`、`engine-recovery.integration.mjs`、`engine-recovery.chromium.mjs`                |
| 保存不同步、旧进度覆盖新进度、删除后复活                   | `task-store.js`、`engine.js`、`background-runtime.js`                                                     | `task-store.test.mjs`、`engine.test.mjs`、`engine-recovery.integration.mjs`                                                                     |
| 资料库导入、导出或档案检索有误                             | `archive.js`、`core.js`、`task-store.js`、`inspect_archive.py`                                            | `archive-restore.test.mjs`、`archive.test.mjs`、`universal-archive.test.mjs`、`universal-export.test.mjs`、`core.test.mjs`                      |
| OpenAPI / Swagger 导入失败                                 | `openapi.js`、`profiles.js`、`panel.js` 规范入口                                                          | `openapi.test.mjs`，浏览器分支用 `npm run test:openapi:browser`                                                                                 |
| 菜单找不到、试运行结果丢失、正常轮换停下                   | `panel.js` 试运行与草稿 → `rotation-controller.js` → `navigation-discovery.js` / `navigation-rotation.js` | `navigation-discovery.test.mjs`、`navigation-rotation.test.mjs`、`rotation-controller.test.mjs`、`workspace.browser.mjs`、`runtime.browser.mjs` |
| 窗口滚动、列表溢出、预览区域布局                           | `panel.html`、`panel.css`、`panel.js` 分页                                                                | `layout.browser.mjs`、`library-layout.browser.mjs`                                                                                              |

`npm test` 不会自动运行名字为 `*.browser.mjs`、`universal.browser.integration.mjs`、`engine-recovery.integration.mjs` 或 `engine-recovery.chromium.mjs` 的文件。浏览器主流程的脚本命令见下文；后两个独立恢复检查分别用 `node --test tests/engine-recovery.integration.mjs` 和 `node --test tests/engine-recovery.chromium.mjs` 执行。Chromium 检查使用真实浏览器存储和锁，但正文输入受测试控制，不代表真实站点采集；其默认浏览器路径与本机有关，跨机器应先配置已有可用的测试浏览器。

## 接手时要保留的行为与交付内容

连接文档进入识别与校准，连接本身不自动采集；顶部栏目切换只清空 URL 输入，不丢来源配置；已受控页面可复用，关闭来源与关闭控制页区别处理；菜单轮换与文档采集独立运行。已保存正文、删除标记和已确认的章节身份不能为“让按钮能点”而绕过。这些行为由现有回归保护，改动相关路径时要一起检查。

一次交付应写明问题复现证据、实际修改文件、执行的检查及未验证事项。功能或修复版本同步 `package.json`、`package-lock.json` 的根版本和根包版本、`extension/manifest.json`、`extension/panel.html` 与配套镜像，并补 README 日志；仅文档说明调整不改变运行版本。已有工作区改动不属于本次清理范围，不批量还原，不擅自创建导出副本、归档或测试资料目录。

## 工作台与任务

`background.js` 的扩展按钮处理器查找已有工作台，把用户点击时授权的源标签页交给它；首次打开期间使用待接收列表与 ready 消息握手。它通过扩展消息找到工作台，不枚举用户浏览记录，不申请全站权限。

`batch.js` 的 `setupBatch()` 管理来源列表、分页和开始/暂停操作；`addSource(tabId, {purpose})` 按标签页去重并拒绝跨用途复用；轮换来源不参与采集列表和批量操作；`startableSessions()` 只选择已识别、有验证条件及待采集章节的文档，排除正在运行的任务并按任务编号去重；`removeSource()` 只移除空闲连接；`selectSource()` 将指定会话交给校准界面；`dispose()` 只断开当前界面的订阅。运行会话由扩展后台持有，没有按来源创建控制页或隐藏工作页。

`background-runtime.js` 的 `createBackgroundRuntime()` 创建后台来源会话和轮换控制器；`request()` 分派有白名单的控制指令，采集开始立即确认后独立执行；`persist()` 串行保存来源绑定和轮换进度；启动时恢复原任务和未结束轮换。浏览器闹钟每分钟唤醒检查，正在执行任务时维持后台活动。手动暂停、删除标记、来源范围检查和两个互斥锁仍有效。Chrome 后台可被终止，因此不能仅依靠内存计时器；参见 [Chrome 生命周期文档](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。

`runtime-client.js` 的 `createRemoteSession()` 提供界面使用的会话代理，`request()` 发送控制消息，更新时从本机数据库读取正文，消息中不重复传输整本正文；`createRemoteRotationController()` 代理开始、停止和快照；`listBackgroundSources()` 在控制页重开时恢复来源列表。代理的 `dispose()` 仅移除订阅，不能停止后台任务；`close()` 仅显示来源已关闭，由后台标签页事件执行一次停止，避免两个页面重复暂停争用任务锁。`AutoRetryClock` 的原生计时器通过全局对象调用，避免后台环境中的 `Illegal invocation`。

`session.js` 的 `SourceSession` 独立持有一个来源的规则、任务、输入输出、引擎和恢复计时器。`connect()` 只读取标签页信息，不建立采集任务；`initialize()` 在用户选择手册操作后恢复匹配任务或快速发现目录；`scanDirectory()` 以来源自身的锁、状态和取消序号读取目录，保存成功后才替换会话任务；`createFreshTask()` 在明确新建时避开已删除任务的旧身份，保留删除标记；`start()` 验证规则后采集；`captureCurrent()` 保存当前章；`pause()` 取消后续操作和恢复；`refresh()` 从本地数据库更新空闲会话；`adopt()` 接收手动校准结果。`getState()` 分开整本开始、批量开始（`canStartBatch`）与当前章记录能力，零章节显示需要校准；已有默认提取规则仅在验证签名和两章样本有效时复用。源标签页锁避免同一页面被同时导航，任务锁避免不同来源同时写同一任务。

`source-connector.js` 的 `parseSourceURL()` 校验完整地址，`resolveSourcePurpose()` 根据已知入口路径确定文档或管理用途（未知地址使用当前栏目），`connectSourceURL()` 在点击手势内申请该网站权限，优先复用已受控且地址匹配的标签页，再查找其他匹配页；没有匹配页且仍有名额时才打开新页，等待加载并拒绝跨源跳转。连接失败不删除标签页。`source-controls.js` 的 `setupSourceControls()` 绑定 URL 表单和来源选择，不调用采集引擎；连接用途由输入和加载后的已知地址判定，图标、初始来源和待处理来源也使用同一规则；未知地址使用当前栏目；文档连接后选择“识别与校准”的识别设置，管理页仍选择菜单轮换；`refresh()` 按当前栏目筛选来源列表，`dispose()` 移除监听。可选权限仅声明可请求的地址范围，实际请求由用户输入的网站确定。

`panel.js` 负责当前来源的识别、校准、规范文件、正文预览和资料库。`selectSession()` 只切换文档来源，不隐式识别；`scanSelected()` 将快速识别、目录扫描、规则选择和导入交给来源会话，完成时只刷新仍被选中的来源；`rememberDocumentDraft()` 保留各来源未提交的校准和示例，`refreshDocumentDraft()` 与 `refreshProfileInputs()` 将后台已确认的定位更新到未编辑字段，`renderSamples()` 单独更新样例提示以免覆盖手输选择器；`applyDocumentResult()` 在返回文档栏目时显示扫描结果；`selectRotationSession()` 独立保留管理页与轮换草稿，`verifyAndSave()` 保存两章验证结果，`openTask()` 只读打开运行中的任务，`library()` 搜索与分页，`renderChapters()` 按页生成章节节点。采集不依赖界面一次渲染全部目录。`showMode()` 在切换分区时清空顶部 URL 输入与临时全局提示，保留来源配置；`clearError()` 同时清除错误文本和隐藏横幅，CSS 另保证空横幅不占空间；来源识别错误留在对应卡片及 `renderRecognition()` 的校准提示中，不复制到全局横幅；无规则时通过 `showOperation()` 展示识别设置，只在没有草稿的空白面板同步会话已有任务。`locked()` 仅在操作成功后将校准结果交给会话；`invalidateRotation()` 在菜单改变后同步验证状态和提示，`stopRotation()` 仅取消正在进行的试运行，不抹掉普通保存期间的已完成验证；`rotationTrial()` 在收尾停止完成并复核取消序号后才提交成功；`rememberRotationDraft()`、`restoreRotationDraft()` 按来源会话保留未保存的菜单配置与验证结果，`rotationInScope()` 限定复用的站点和路径。

`rotation-controller.js` 的 `createRotationController()` 在扩展后台按标签页管理正常轮换；`start()` 获取来源锁，`snapshot()` 返回运行状态，`stop()` 取消调度、清理页面执行器并释放锁，后续 `start()` 等待旧停止清理完成，`resumeData()` 提供重建所需的运行编号、下一项和计数；`dispose()` 仅用于终止整个控制器。页面脚本只执行经过验证的单步点击；后台保留并持久化顺序和计数，控制页刷新不销毁调度。`rotationChanged()` 更新跨栏目可见的运行提示。`rotationTrial()` 使用同一页面执行器的 `prepare()`、`execute()` 依次执行有限的一轮，工作台等待每次点击结果，不启动来源页循环计时器，也不轮询瞬时计数。`rotationCall()` 在读取来源与脚本注入后再次检查取消序号；结束时以本次编号调用 `stopManaged()` 清理，清理完成后才确认通过。

## 连接、复用与退出：按一次操作追踪代码

例如工作台已经连接了 7 个文档页和 1 个轮换管理页，再粘贴其中 API 手册的入口地址，应该选回原来的受控页；关闭其中一个来源标签页后，应该可以连接新的第 8 个来源。这里的上限指尚未关闭的来源连接，两个用途合计计算，与“已保存”资料库中的手册数量无关。

| 操作环节       | 源文件与主要函数                                                                                       | 负责什么                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 点击连接       | `source-controls.js`：`submit()`、`refresh()`                                                          | 读取输入、传入已连接标签页编号、更新选择；查找旧页之前不因满额拒绝                               |
| 查找已有页面   | `source-connector.js`：`parseSourceURL()`、`connectionKey()`、`connectGranted()`、`waitForLoadedTab()` | 校验地址、在已授权网站的打开标签页中匹配；优先已有受控页，没有匹配且有名额才开页；不导航已有页   |
| 加入界面列表   | `batch.js`：`addSource()`、`sourceCount()`、`connectSession()`                                         | 按标签页编号复用连接，统计未关闭来源；连接失败撤回空记录                                         |
| 向后台请求     | `runtime-client.js`：`request()`、`createRemoteSession()`                                              | 将连接、暂停、移除等操作发给后台，把后台结果同步给界面；不自己运行采集                           |
| 后台确认与恢复 | `background-runtime.js`：`request()`、`ensure()`、`connect()`、`persist()`                             | 最终检查名额，持有真正的来源会话；保存有效来源绑定；失效连接不占名额，已关闭来源不再写入恢复列表 |
| 退出来源       | `session.js`：`close()`、`pause()`；`batch.js`：`removeSource()`                                       | 关来源页会停止该来源并释放名额；手动移除先等待后台确认，拒绝时保留界面项；不删除章节             |

地址匹配有明确边界：`adocs.php` 和 `cdocs.php` 在同一协议、主机、端口和路径下，允许入口无参数或只有合法的 `index`、`dataID` 章节参数，因而同一手册换章后仍能找到原标签页。API 与 CLI 不互相合并；其他网站仍按完整网址匹配，不能仅凭同一个网站就认为是同一本文档。这里复用的是浏览器页面，不是凭名字合并两份历史档案。

“暂停”只停止采集，保留连接和名额以便继续；“移除”在采集工作台操作，管理页使用“移除管理页”，须先停止当前操作。后台确认移除成功后才从界面消失，来源网页本身不会被关闭。直接关闭来源标签页也会释放名额；当前界面可暂留带“已关闭”标识的记录供查看或移除，但它不占名额，也不会在下次恢复时重新连接。刷新或关闭 ManualDock 控制页只是断开界面订阅，不等于退出来源。

章节在 `task-store.js` 中独立保存。退出来源移除的是连接或恢复绑定；需要删除档案时才使用“已保存”中的删除操作。相关回归位于 `tests/batch.test.mjs`、`tests/source-connector.test.mjs` 和 `tests/background-runtime.test.mjs`，覆盖满额复用、关页后再连接、移除确认失败和存档保留。

## 采集与持久化

| 文件                                                | 主要函数或对象                                                                         | 职责                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `profiles.js`                                       | `validateProfile`、`cleanChapter`、`jobKey`、`selectSavedProfile`、`profilesForSource` | 规则校验、章节身份和已有任务匹配                        |
| `manual-adapters.js`、`tree.js`                     | `detect`、`bindings`、`directoryRoots`、`discover`、`current`、`open`、`verify`        | 发现目录，限定页面范围，证明当前章节身份                |
| `browser-io.js`                                     | `createBrowserIO`、`capture`、`verifySamples`、`recover`、`prepare`、`boundCurrent`    | 操作已授权源标签页，等待章节切换及稳定正文              |
| `capture.js`                                        | `readState`、`prepareContent`、`capture`、`buildHTML`、`embedImages`                   | 提取正文、清理危险内容、保存可读取的图片                |
| `engine.js`                                         | `ImportEngine.merge/scan/run/checkpoint`                                               | 队列推进、单章采集、失败隔离、逐章原子保存              |
| `task-store.js`                                     | `saveTask`、`saveWholeTask`、`restoreWholeTask`、`deleteTask`、`subscribeTasks`        | IndexedDB 存储、修订冲突检查、删除标记、本机更新通知    |
| `recovery.js`、`auto-retry.js`                      | `classifyRecoveryError`、`taskHasRetryableWork`、`AutoRetryClock`                      | 区分可恢复错误、用户暂停与不可自动恢复的问题            |
| `archive.js`                                        | `parseArchive`、`mergeArchive`                                                         | 校验导入档案、清理 HTML、补齐缺失正文并保留本机冲突内容 |
| `openapi.js`、`core.js`                             | `parseSpecification`、`buildExports`                                                   | 规范解析与四种离线导出格式                              |
| `navigation-discovery.js`、`navigation-rotation.js` | `discover`、`start/stop/snapshot`                                                      | 独立管理页导航发现与轮换，默认关闭                      |

`manual-adapters.js` 的 `detect()` 过滤隐藏区域和包含目录的正文外壳；重新注入时通过 `dispose()` 清理旧点选监听并替换旧适配器，避免“重新识别”仍执行旧版代码。更早的版本没有清理接口且仍有点选覆盖层时会保留旧实例并写明阻止原因；`browser-io.js` 的 `install()` 显式检查该结果，要求用户取消旧点选或刷新页面后再操作。

`manual-adapters.js` 的 `branchLoaded()` 直接识别已到达的 Ext 子节点，`expand()` 不点击已加载的折叠分支，`detect()` 对已确认的 Ext 目录跳过无用的通用遍历；未加载分支仍受等待与完整性诊断约束。通用目录的 `verify()` 使用 `locate()` 重新确认当前路径唯一性，避免动态出现重复节点后误认正文。`tree.js` 的 `rowLabels()`、`rowTitle()` 统一直接文本标签与唯一目录链接标题；扫描、点击、当前章和手选示例使用相同路径。省略空子列表仅在明确叶子且无其他子树时接受，目录链接的原生跳转也限定在原手册内。

`bindings()` 只读检查目录、正文、框架选择器的匹配数量；错误指出区域、选择器与数量。`bindingCandidate()` 保留原任务的网址范围，仅对缺失的目录或正文提出替代；框架变化、适配器变化、普通目录或正文的多个匹配不自动处理；Ext 目录允许明确选择多个树根。`boundCurrent()` 用候选区域只读确认已选章节，交给 `matchesBoundChapter()` 核对它在旧队列中唯一存在，解决换章后旧定位失效导致后台无法接入的问题；这一步不验证或保存新规则。`prepare()` 在定位变更或 Ext 树目录续采前核对完整旧队列，验证两个不同正文（多根目录取首末章），再扫描核对换章后的完整目录，才返回可提交的规则。自动更换目录选择器时，候选章节集合必须与原队列等价，不能仅以包含原章节为由扩大范围。`SourceSession.run()` 用受取消检查保护的临时任务保存成功后更新内存，不重建任务、不覆盖已保存正文。正常采集和导航后的正文验证仍逐章执行。

`tree.js` 的 `directoryRoots()` 统一解析明确配置的目录容器或 Ext 树根集合；`inspect()`、`scan()`、`current()`、`open()` 和 `verify()` 都使用该范围。仅旧版无配置入口保留整页树扫描。`manual-adapters.js` 的 `context()`、`expand()`、`pick()` 和 `capture.js` 的扫描入口传递同一目录范围，自动识别正文时排除与任一目录根重叠的容器。章节路径或节点标识仍来自实际页面；根数量本身不代表歧义，也不代表整册完整。

每个检查点把任务元数据与该章正文放在同一事务中提交。保存修订号阻止旧快照覆盖新进度；删除事务一并移除正文和恢复关联，并留下删除标记，阻止未退出的采集器重新写回。跨页面通知只触发重新读取数据库，通知本身不是数据权威。扫描可给 `saveTask()` 传入取消检查，在尚未执行写入的事务中拒绝暂停后的迟到结果；已提交的事务不会被回滚。

## 开发命令与脚本

```sh
npm ci
# 仅格式化本次改动的文件；下面两个路径只是示例，按实际改动替换
node node_modules/prettier/bin/prettier.cjs --write extension/source-connector.js tests/source-connector.test.mjs
npm run sync:assets
npm run check
npm test
npm run test:openapi:browser
npm run test:browser
npm run test:workspace
npm run test:scan:browser
npm run test:layout
npm run test:recognition
npm run test:runtime
```

`scan-workspace.browser.mjs` 的 `defaultRotationRoutesKnownManuals()` 覆盖默认轮换页面直接粘贴、首次来源和工具栏回调的文档分配；`bulkStartsOnlyPrepared()` 验证已识别与未识别来源混合时只采集前者，并核对错误仅显示在所属来源；`scanningDoesNotOwnSelection()` 验证懒加载扫描中连接另一个来源，`deletedLargeTaskAndManualRules()` 验证删除后新建采集及规则隔离，`connectDocument()` 与 `detectCurrent()` 操作实际界面；`waitTasks()` 读取持久化结果。所有页面均为本地合成夹具。

`npm run format` 会重写多处源码，只适合明确授权的全仓格式整理；日常修复使用上面的显式文件路径。`check-source.mjs` 逐个解析运行脚本、开发脚本和测试；`sync-assets.mjs` 同步运行目录到 Skill 资产，`--check` 只检查一致性。生成的 vendor 文件不参与格式重写。

`build-openapi-vendor.mjs` 通过 esbuild 把 YAML 解析器打包到已有 `extension/vendor/` 并保留许可证。`package_release.py` 的 `checked_path()` 拒绝逃逸路径和符号链接，`check_public_content()` 检查个人路径与私有设备地址，`build()` 按明确清单生成发行包。`prepare_public.py` 的 `collect()` 检查公开源文件，`export()` 仅更新经过标记的导出目录；除非确需准备独立公开副本，否则不要运行此导出脚本。

浏览器测试可以设置 `MANUALDOCK_CHROMIUM_EXECUTABLE`。使用 `TMPDIR` 指定仓库内现有临时目录，可将测试 profile、下载与中间文件限定在仓库内。`ci/check.yml` 是原有工作流模板，未移动到新目录。测试范围及实测结果见 [validation.md](validation.md)。

## 通用识别与恢复边界（0.2.10）

`manual-adapters.js` 的 `detect()` 优先使用导航和正文语义；缺少导航标记时，检查含多个不同链接、主要由链接文本组成的嵌套列表；缺少正文标记时，检查目录外含标题和段落、代码或表格的独立区域。多个独立正文候选不自动猜选。`selectorFor()` 避免生成式组件编号，优先唯一的结构类。已登录 CLI 实测确认 `.af-api-body` 在说明页和命令页之间保持稳定，内部 `.af-api-body-container` 并非每章都有。`tree.js` 仍按完整标题路径定位，不推算 URL 的 index 参数。

`recovery.js` 的 `scheduleRecovery()` 保存连续失败次数，按 5、15、30、60、180 秒安排重试；已有章节再次成功保存后重置间隔。登录失效继续等待用户，存储失败、范围越界和定位歧义不循环重试。`browser-io.js` 的 `checkSource()` 先确认浏览器错误页的 pendingUrl 仍属于该手册，再归为网络故障，避免误判为用户离开网站。`session.js` 的手动继续和自动继续都会在可恢复故障后重新连接，只处理未完成章节。

`runtime.browser.mjs` 使用 12 章本地手册、真实扩展后台和 30 秒菜单周期，检查刷新控制页、通过浏览器协议终止后台、恢复进度和手动停止。整个脚本上限 120 秒，浏览器临时资料均在仓库内并自动清理；它不代表真实设备长时间采集结果。

## 历史配置与当前识别（0.2.11）

`SourceSession.initialize({taskId})` 在后台重建时优先采用明确保存的来源任务绑定；`savedRecovery()` 同样优先读取指定任务，其他旧任务的自动重试关联不能覆盖当前绑定。没有明确绑定且历史匹配存在歧义时重新检测；历史配置缺区域时允许使用新的完整定位结果建立独立任务，不将旧编号和正文改写成另一份配置。缺少目录或正文、扫描失败仍保留待校准状态。

`scanDirectory({detect:true})` 将当前页面检测与历史选择分开：相同结构及已知章节可以复用原任务，历史记录无法唯一确认时使用新的身份。`matchesBoundChapter()` 用同站同路径、合法页面范围和当前唯一选中的目录节点，确认点击型树目录中的已知章节；它只用于已绑定任务，不凭同名手册或相同正文选择器合并其他历史任务。普通链接仍按已知章节 URL 匹配。不同结构、未知目录节点和已删除任务不会沿用旧任务身份。

`panel.js` 的 `scanSelected()` 在没有配置时执行快速检测，扫描按钮不再依赖历史选择。只有诊断中存在未加载分支时，普通扫描才请求展开。0.2.11 曾用 `profileList()` 展示历史配置，0.2.12 已移除此列表及选择事件。界面提供扫描状态和停止入口，停止通过会话取消序号阻止迟到结果提交。

`recognition.browser.mjs` 的本地服务生成 447 章树形手册，并预存三份含正文的旧档案；`connect()` 操作实际连接表单，`progress()` 同时读取后台状态和已保存任务，`wait()` 使用有截止时间的条件等待。它检查旧配置修复、歧义历史、单章记录、整本开始、换章重识别、后台终止后恢复，以及旧档案不被改写。报告包含运行文件哈希；全脚本上限 120 秒，临时扩展和浏览器资料只存放在仓库内并在结束时清理。这些是本地合成页面的回归，不能代替目标网站验证。

## 0.2.12 连接入口与停止原因

`setupSourceControls()` 以当前栏目提供默认用途，保留已知文档和管理入口的识别。没有第二个用途下拉框；按钮显示“连接管理页”或“连接文档页”。历史识别配置的列表与选择事件已移除，任务内部仍保存已验证的定位配置，以支持后台恢复和手动校准。

`SourceSession.run()` 和面板的兼容执行路径在任务级故障后先调用 `io.recover()`。成功后 `resetInterruptedChapters()` 只将因任务级故障中断、且没有已存正文的章节恢复为待处理；恢复失败保持剩余队列原样。登录、范围、权限、校准和存储保护仍保留，不能仅为继续采集而绕过。`ImportEngine.run()` 对返回错误、异常和存档失败都写入有界错误记录；`getState()` 公开已持久化的停止原因，`collectionMessage()` 在采集按钮旁解释原因和下一步。正文重复只标记待核对，不触发停止。

### 0.3.4–0.3.6 正文折叠内容

`capture.js` 的 `bodyDisclosures()` 仅匹配独立正文中已支持的参数树和样例面板；`prepareContent()` 点击展开，等待内层参数表及样例正文实际显示。普通按钮、目录、表单及编辑区域不属于展开目标。每章上限 200 次点击、12 秒，每个控件等待最多 2 秒；未展开、控件替换或章节变化返回明确失败。`browser-io.js` 先证明目标章节切换完成，再准备正文并重新等待稳定；提取后仍复核章节、文档身份和正文签名。0.3.6 将完整性检查放在 `capture()` 读取入口：旧调用方未单独准备正文时补做展开，等待稳定后核对地址、文档及正文根；`requireExpanded` 只表示调用方已准备过，不能绕过最终检查。内部 `pre` 必须可见且非空，外层面板展开不代表样例已读取。只读预览显式传 `previewOnly`，不点击控件，返回 `preview` 状态而非可存档的 `ok`。诊断保留 `extractorVersion` 和 `disclosures.checked/clicked`，后台追加点击数时保留这些字段。

两份用户保存网页支持的结构是 `af-api-panel` 的箭头/标题/代码容器，以及 Ext 参数行后面的嵌套子表。相邻示例 `code` 块在净化副本中补分隔换行，树控制图片不占正文图片额度。用户保存的 JS/CSS 实际是登录响应，离线测试只使用真实 DOM 与模拟展开事件；不能当作设备端回调已验证。已保存的旧缺漏章节不会自动重采。`core.js` 的 `hasMissingExamples()` 只检测净化 HTML 中已知的空样例容器，导出附上缺漏警告；面板的兼容路径与后台路径均通过现有“重试问题项”提示确认，再把对应已保存章节置为待采。成功后替换正文，失败保留原文；正常续采不会改写这些章节。也可使用“采集当前章”补采指定章。未知弹窗不在此检测范围内，详见 [维护边界](../AGENTS.md)。

## 0.3.8 正文展开与计时注释

正文链路的中文注释位于 `browser-io.js`、`capture.js`、`engine.js`、`recovery.js` 和 `exports.js`，解释操作来源页、读取、队列保存、故障分类和导出的边界。`capture.js` 的 `prepareContent()` 不再按 200 次点击截断，`MAX_CONTENT_PREPARATION_TIME` 为 60000 毫秒；单项 2 秒及同控件保护保留。上文 0.3.4–0.3.6 段落中的 200 次／12 秒为历史限制。

`browser-io.js` 的单章 `capture()` 仍以 45 秒限制换章及相关等待，但将 `prepareContent()` 调用耗时补回该期限，保证 55 秒成功的展开不会被误判为换章超时。该调用只准备一次，随后正文仍须重新稳定，并在 `capture.js` 的最终入口检查完整性；预算放宽没有增加对晚出现控件的第二轮展开。预算行为回归位于 `tests/capture-disclosures.test.mjs` 和 `tests/content-preparation.test.mjs`，使用虚拟时钟，不以一分钟真实等待测量设备性能。
