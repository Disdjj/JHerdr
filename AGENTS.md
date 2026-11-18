# JHerdr 开发约定

- 始终使用简体中文沟通。
- 这是 Herdr 原生 GPUI mod，不能使用 DOM、Node API 或浏览器定时器；Node 仅用于 scripts 和 test。
- Herdr 公共接口以本机 `~/.config/herdr-app/herdr.d.ts` 和 `gpui-kit.d.ts` 为准。编辑前阅读该目录的 `AGENTS.md`。
- 修改源码在本仓库进行，通过 `npm run install:herdr` 安装；不要直接修改官方布局或官方 mod。
- 不把用户的项目路径、终端 ID、会话内容或 shared.json 提交进仓库。
- 项目顺序不随运行状态自动排序；关闭会话不删除项目；移除入口不删除文件或停止 Agent。
- `herdr-app check` 会执行 init，必须用 `checking()` 阻止发现、持久化和进程副作用。
- 修改后运行 `npm test`、`npm run check`、`herdr-app check "$PWD/mods/jherdr-projects"`，再验证真实窗口。不要通过更改 HOME 启动额外 Herdr 实例。
- 纯数据与 Git 归属逻辑放在 model.js，异步读取放在 controller.js，交互放在 main.js。
- 在本项目通过 Herdr 新启动 Agent，默认用 `npm run agent -- <程序> [参数]` 复用桌面的 YOLO 配置。用户指定其他权限模式时，以用户指定的模式启动。
