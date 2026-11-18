# JHerdr

把 Herdr 左侧导航组织为 **Project → Worktree → Worker**。项目固定保留，分支与执行者放在同一棵树里；沿用原有聊天、终端、文件和改动面板。

这是 Herdr 桌面扩展，不是 Herdr fork，也不替换 herdr-core。可基于 `main` 或 `shepherdr` 布局安装。

## 使用

- 项目会从已打开的工作空间、终端和 Agent 所在 Git 仓库自动发现，并固定保存。
- 点击「项目」右侧的文件夹图标可打开项目、从 URL 克隆、新建项目或从模板开始。打开本机仓库或 linked worktree 会固定项目并进入对应工作树；普通目录在「其他工作空间」中打开。
- 克隆、新建和从模板创建的项目默认保存在 `~/repos/<项目名>`，可以点击「保存位置」为本次操作更换目录。克隆支持 HTTPS、SSH 和 `git@host:owner/repo.git`，可沿用仓库名或自定目录名。新建项目初始化 `main` 分支，模板可选静态网页或 Node.js 命令行。
- 项目下列出 `git worktree list` 返回的工作目录，不要求先打开 Space。
- 项目／工作树箭头：展开或收起；点击工作树名称：打开已有工作空间或创建对应的终端空间。
- 点主工作区右上角（Files、Changes 旁）的 **Zed**，打开当前标签页中所选终端所在的工作树；普通目录直接打开。本机需能运行 `zed`，远程项目通过同名 SSH Host 在本机 Zed 中打开。参见 [Zed 远程开发文档](https://zed.dev/docs/remote-development)。
- 点击 Worker：已有 pane 时直接切换；后台 Worker 直接接入主工作区的标签页，不弹出预览，也不会重新启动它。
- 鼠标移到工作树行时，该行显示对应机器已安装的 Agent 图标。点击图标即可启动，移出后分支名称重新占满该行。侧栏较窄时图标换到分支名下方，右键或按空格也可打开操作菜单。
- 点击「项目」右侧的齿轮打开 **Agent 设置**。勾选要使用的 Agent、编辑启动命令或添加自定义程序，然后保存。启用开关作用于 JHerdr 工作树图标、右键菜单和仓库的命令行启动入口。可执行程序须在目标机器上可用。命令按程序名和参数解析，支持引号分组，直接按参数执行。取消会放弃本次编辑。
- Herdr 的「新建 Agent」和工作树菜单都使用应用配置目录的 `programs.json`。仓库内的 `config/programs.json` 提供本机 Agent 的 YOLO 启动参数；在新机器上，将其中的 `programs` 条目合并到应用同名文件即可。Codex 的这一模式会同时关闭命令审批和沙箱。Kimi 的原生 `--yolo` 仍会询问高风险操作，Pi 沿用默认工具权限。
- 在本仓库运行 `npm run agent -- agy` 可按相同配置启动后台 Worker；也可以传入初始问题，例如 `npm run agent -- agy -i "请向我提一个问题"`。输出中的终端地址可用于 `hc read`、`hc send` 和 `hc wait`。直接调用 `hc run` 时，需自行传入相应参数。
- 项目行右侧的 **＋** 打开 Herdr 原生「新建工作树」。输入分支名后按 Enter，即在该项目所在机器创建 checkout 并打开对应工作空间。新分支从主工作树当前的 HEAD 创建，已有的可用分支可直接检出。目标目录遵循 Herdr 的 `worktrees.directory` 设置。
- 项目图标自动使用 GitHub 仓库所属组织或用户的头像，优先识别 origin。头像缓存在 Mac 或运行 JHerdr 的本机。无可用头像时显示文件夹。项目右侧 **…** 或右键菜单提供「置顶项目」「取消置顶」和手动上移／下移。「项目」标题旁的排序按钮可选手动顺序、名称升序或名称降序。置顶项目优先显示，置顶和排序偏好会保存。
- 拖动项目名称或头像，在同组另一个项目行的上半部或下半部松开，即可插到它前面或后面。有效拖放会保存为手动顺序；按 Esc 或移出项目列表可取消。
- 项目菜单里的「从侧栏移除」可撤销，只隐藏入口，保留目录和会话。
- 搜索支持项目、路径、分支、Worker 名称和状态。搜索期间展开匹配项，清空后恢复原来的折叠状态。
- 进入侧栏后，`↑↓` 导航、`←→` 折叠／展开、`Enter` 打开、`Space` 或 `F10` 打开操作菜单、`Tab` 返回搜索。Herdr 的 `pane.go` 也能聚焦侧栏。

远程项目通过已连接的 Herdr Space 自动发现；机器名参与项目身份计算，因此不同机器上的同一路径不会混在一起。离线时保留已有项目与工作树，并明确标记离线。

## 安装与回退

需要 Node.js 22+、Git，以及已运行并初始化过的 Herdr App。开发和验证使用本机 Herdr 的 `herdr.d.ts` / `gpui-kit.d.ts` 接口；不需要安装 npm 依赖。

```sh
npm test
npm run check

# 预览目标文件，不写入
npm run install:herdr -- --dry-run

# 安装并启用，默认基于 main；原布局不改动
npm run install:herdr -- --activate

# 使用 Shepherdr 的聊天与任务面板作为右侧工作区
npm run install:herdr -- --base shepherdr --activate

```

Herdr 自带的 `main`、`terminals`、`win98` 布局始终保留。JHerdr 不自动删除其他布局；此前的自动清理规则会在安装时关闭，`--only-layout` 与 `--delete-other-layouts` 已移除。下载的自定义布局按明确名称单独处理，不使用全删规则。

安装只写入 `~/.config/herdr-app/mods/jherdr-projects/`、`layouts/jherdr.json`、预览图和 `data/jherdr/` 下的创建脚本与安装记录。重装会先备份本扩展旧文件；遇到不属于本扩展的同名文件会停止。源码保留在当前仓库，修改后重新运行安装即可热更新。

恢复原布局不影响运行中的 Agent：

```sh
herdr-app do layout.switch '{"name":"main"}'
# 或切回 shepherdr；也可以用 Herdr 的布局切换器

# 卸载扩展文件；固定项目与折叠状态仍保留
npm run uninstall:herdr
```

`--app-home <directory>` 支持向隔离目录生成安装文件；不会启动第二个 Herdr 实例。`--skip-check` 仅供没有原生运行时的隔离测试使用。不要通过更换 HOME 启动 Herdr 测试。

## 代码

| 文件 | 职责 |
|---|---|
| `mods/jherdr-projects/main.js` | GPUI 原生侧栏、搜索、菜单、键盘操作、会话跳转 |
| `mods/jherdr-projects/model.js` | Git worktree 解析、项目身份、Worker 归属、树与过滤 |
| `mods/jherdr-projects/controller.js` | 有界并发发现、缓存、刷新与错误保留 |
| `scripts/layout.mjs` | 从既有布局生成独立 JHerdr 布局 |
| `scripts/install.mjs` | 安装、更新备份、激活与卸载 |
| `design/layout-preview.svg` | Herdr 布局选择器的预览图 |
| `test/` | 真实 Git 工作树、状态、边界与隔离安装测试 |

项目身份是 `machine + git-common-dir`；Worker 按当前 pane cwd 优先、其次 terminal cwd，匹配同机器下最长的工作树目录前缀。固定项目、顺序和折叠状态使用 Herdr 的 shared state，键为 `jherdr.projects.v1`。终端状态直接来自 Herdr，不从文本猜测。

发现与刷新最多同时执行三个 Git 查询任务，每个进程超时 10 秒；工作树列表约每 30 秒刷新，未登记目录约每两分钟重新探测，刷新按钮可立即重试。读取失败保留上次结果，项目行显示失败并可悬停查看原因。没有对应 Git 项目的 Space 保留在“其他工作空间”。

## 验证与范围

已在 macOS 的真实 Herdr 窗口验证项目展示、搜索、键盘折叠、操作菜单、排序持久化及 Worker 查看。自动测试覆盖特殊字符／换行路径、未提交过的仓库、detached／locked worktree、嵌套仓库、跨机器身份隔离、错误缓存和安装回退。

新建工作树复用 Herdr 原生对话框。工作树上的 Agent 图标启动普通会话。当前交付范围为桌面原生布局。

远程在线运行与 Windows／Linux 桌面尚未实机验证。远程离线、路径隔离通过数据层测试覆盖。
