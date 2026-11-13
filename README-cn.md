# Codex 技能路由器

[English](README.md)

路由器使用现有 Codex 登录和提供商，为每个会话的首个任务排列已安装的技能。后续消息不会重复排序。任务变化时，Codex 可调用 `search_skills` 搜索当前项目的技能。

## 安装

需要 Node.js 22+ 和支持插件钩子、app-server 的 Codex CLI（已在 0.166.0 验证）。插件自带打包脚本，无需另配 API 密钥、安装 npm 依赖或手动注册 MCP。

```sh
codex plugin marketplace add https://github.com/alexalok/jev-skill-router.git
codex plugin add jev-skill-router@jev-skill-router
```

在 Codex 的 config.toml 中设置以下内容，再通过 `/hooks` 检查并信任插件命令。升级后请重新检查信任状态。

```toml
[skills]
include_instructions = false
```

每次提交消息时，钩子都会检查任务目录的持久化有效配置。无法确认上述值时会阻止提交并说明原因。只有原生设置不兼容时才提示修改 TOML；其他错误会指出无法验证的原因。输入损坏、路由配置无效、找不到 Codex 也会阻止提交。桌面应用找不到 Codex 时，请把 `codexBin` 设为可执行文件的绝对路径。

若钩子未启用或未受信任、缺少 Node、进程崩溃或钩子超时，Codex 仍可能放行消息。钩子看不到调用方临时传入的 `-c skills.include_instructions=true`、`--profile` 或应用内覆盖值。`JEV_SKILL_ROUTER_DISABLED=1` 可跳过钩子及检查。停用插件后请恢复原生技能说明。

## 路由与搜索

辅助模型仅接收任务、技能名称和简短描述。插件不读取 SKILL.md 正文；只检查策略元数据，排除禁止隐式调用、已禁用、重复或失效的技能。每批评分使用全新空目录中的临时只读线程，关闭工具。用户级提供商、自定义 base URL 和全局指令仍有效；项目级提供商覆盖不适用。任务和描述会发送给该提供商。

仅含图片或空白的消息通过检查后不会消耗首次排序机会。长消息只取前 24,000 个 UTF-8 字节中的完整字符供辅助模型评分；Codex 仍收到完整消息。钩子支持最多 8 MiB 的 JSON 输入。

主线程按相关性从高到低收到完整条目：`- 名称: 描述 (file: /路径/SKILL.md)`。首次注入没有最低分或数量限制。预算优先取 `skills.max_context_tokens`，否则取当前会话模型上下文窗口的 2%（读取自 Codex 模型目录），仅显式设置的预算上限为 10,000 个 token；上下文大小未知时用 8,000 个字符。每行按每四个 UTF-8 字节约一个 token 估算。末尾提示省略数量。用户点名的技能仍须使用。

若要让某个技能无论相关性如何都出现在首次注入中，请在其 `agents/openai.yaml` 中设置 `policy.skill_router_always_injected_in_initial_turn: true`。这类技能不经辅助模型评分，排在列表最前，且不会因预算被省略（其开销仍计入预算）。该标志对仅限手动调用的技能（`allow_implicit_invocation: false`）同样生效；`search_skills` 仍会跳过仅限手动调用的技能。

子代理通过 `SubagentStart` 钩子继承父会话的列表，无需调用模型（Codex 不向子代理发送 `UserPromptSubmit`）。父会话尚无列表时，子代理得到未排序的目录。恢复会话不重新注入，分叉会话重新排序。根会话压缩后从缓存恢复，无需调用模型，可能在下一轮生效；Codex 不向子代理发送此事件。缓存保存 30 天。评分失败时按目录顺序注入、缓存并提示错误码；目录读取失败则在下一次提交时重试。

任务变化时可调用 `search_skills`，传入 `task_description`（1–24,000 个 UTF-8 字节）和 `cwd`（任务目录的绝对路径）。工具检查同一配置，按阈值过滤，再返回指定数量的结果。无匹配与调用错误分别提示。

## 配置与面板

可选配置：`~/.config/jev-skill-router/config.json`。参见 [config.example.json](config.example.json)。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| model | gpt-6-luna | 提供商支持的辅助模型 |
| reasoningEffort | medium | 模型支持的推理强度 |
| searchMaxResults | 10 | 搜索结果上限，1–50 |
| searchMinRelevance | 0.8 | 搜索最低相关性，0–1，含端点 |
| timeoutMs | 45000 | 一次请求共享的 app-server 时限，1,000–120,000 毫秒 |
| codexBin | codex | 可执行文件名或绝对路径 |
| recordSelections | true | 写入本地历史 |
| dashboardAutoStart | true | 自动启动面板 |
| dashboardPort | 4318 | 本地端口，1–65535 |
| dataDir | ~/.local/share/jev-skill-router | 历史和缓存目录；自定义值必须是绝对路径 |

`JEV_SKILL_ROUTER_CONFIG`、`JEV_SKILL_ROUTER_DATA_DIR` 和 `JEV_CODEX_BIN` 分别覆盖对应路径。未知键会报错。旧键 `apiKey`、`threshold`、`maxSkills` 会被忽略，并通过 `--list` 提示；旧 `jev-*` 模型名回退至默认值。

运行 `node "<插件根目录>/scripts/router.mjs" --list` 查看可用技能。[本地只读面板](http://127.0.0.1:4318) 显示来源、列出和省略的数量、相关性及耗时。支持新旧两版 JSONL 历史，不记录消息或搜索文本。关闭记录不会删除历史或禁用会话缓存。

`--dashboard [--port 端口]` 手动启动面板；macOS 下用 `--install-app-startup` / `--remove-app-startup` 管理 LaunchAgent。升级后请重新安装其独立脚本。自动启动的服务空闲 30 分钟后退出。其他平台可使用钩子启动面板。

开发：依次执行 `npm ci`、`npm run build`、`npm test`。测试使用模拟 Codex 进程。`npm run dashboard:demo` 使用独立模拟数据启动面板。
