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

每次提交符合路由条件的消息时，钩子都会检查任务目录的持久化有效配置。无法确认上述值时会阻止提交并说明原因。只有原生设置不兼容时才提示修改 TOML；其他错误会指出无法验证的原因。输入损坏、路由配置无效、找不到 Codex 也会阻止提交。桌面应用找不到 Codex 时，请把 `codexBin` 设为可执行文件的绝对路径。

若钩子未启用或未受信任、缺少 Node、进程崩溃或钩子超时，Codex 仍可能放行消息。钩子看不到调用方临时传入的 `-c skills.include_instructions=true`、`--profile` 或应用内覆盖值。`JEV_SKILL_ROUTER_DISABLED=1` 可跳过钩子及检查。停用插件后请恢复原生技能说明。

## 路由与搜索

当 `UserPromptSubmit` 的 `transcript_path` 为 null 或缺失，或转录首行 `session_meta` 标识守护审查线程时，直接返回 `{}`。识别字段为 `payload.thread_source: "guardian_review"`，兼容信号为 `payload.source.subagent.other: "guardian"`。这些内部线程不参与技能路由，因此跳过配置及原生技能说明检查，不调用排序模型、不写会话缓存或选择历史，也不启动仪表盘。

只读取转录首行（最多 256 KiB），不读取应用数据库。文件不可读、元数据损坏、过大或类型未知时，保留正常路由及配置检查。普通聊天、子代理、旁支对话、分叉、自动化和 `create_thread` 创建的聊天仍可路由；`PreToolUse`、搜索及压缩恢复路径保持不变。

辅助模型仅接收任务、技能名称和简短描述。插件不读取 SKILL.md 正文；只检查策略元数据，排除禁止隐式调用、已禁用、重复或失效的技能。每批评分使用全新空目录中的临时只读线程，关闭工具。用户级提供商、自定义 base URL 和全局指令仍有效；项目级提供商覆盖不适用。任务和描述会发送给该提供商。

仅含图片或空白的消息通过检查后不会消耗首次排序机会。长消息只取前 24,000 个 UTF-8 字节中的完整字符供辅助模型评分；Codex 仍收到完整消息。钩子支持最多 8 MiB 的 JSON 输入。

主线程按相关性从高到低收到完整条目：`- 名称: 描述 (file: /路径/SKILL.md)`。非固定技能的评分须达到 `initialMinRelevance`（默认 0.8），数量不限。若无技能达标，仍列出固定技能，并提示可调用 `search_skills`。预算优先取 `skills.max_context_tokens`，否则取当前会话模型上下文窗口的 2%（读取自 Codex 模型目录），仅显式设置的预算上限为 10,000 个 token；上下文大小未知时用 8,000 个字符。每行按每四个 UTF-8 字节约一个 token 估算。末尾仅提示因预算而省略的技能数量；历史记录的省略数量还包括未达到阈值的技能。用户点名的技能仍须使用。

若要让某个技能无论相关性如何都出现在首次注入中，请在其 `agents/openai.yaml` 中设置 `policy.skill_router_always_injected_in_initial_turn: true`。这类技能不经辅助模型评分，排在列表最前，且不会因预算被省略（其开销仍计入预算）。该标志对仅限手动调用的技能（`allow_implicit_invocation: false`）同样生效；`search_skills` 仍会跳过仅限手动调用的技能。

Codex 默认把每个钩子的 `additionalContext` 限制在约 2,500 个 token（每四个 UTF-8 字节约一个 token）。超出时，Codex 把全文存入临时文件，模型只看到开头和结尾，排序列表的中间部分被截掉。因此随插件提供的 `hooks.json` 在每个处理器上把 `additionalContextLimit` 设为 `0`（不限制），上述预算是唯一的限制。自行注册钩子时请设置相同的值。

子代理在启动前按自己的任务排序：`PreToolUse` 仅改写 `message`，保留其余参数。支持已验证的桌面钩子名 `collaborationspawn_agent` 和文档中的 `spawn_agent`（`Agent` 是匹配别名）。目录发现使用子代理显式 `cwd`，相对路径以钩子的 cwd 为基准；未指定时使用调用者 cwd。预算使用子代理请求的模型，否则使用调用者模型。相关性阈值、固定 skills、预算和评分失败回退策略与初始排序相同。父代理缓存不被读取或修改；历史来源为 `subagent`，不保存任务文本。

新上下文与完整历史子代理均收到自己的目录，附带说明取代历史中的父目录。已移除 `SubagentStart` 注册。附加标记避免重试重复注入；任务、cwd 或模型变化时替换旧目录。如果客户端也为附加目录后的开场消息发送 `UserPromptSubmit`，仅在可识别的独立子代理身份下保存缓存，不再排序或注入。启动前尚无子代理 id，因此无法提前写入子代理缓存；不发送开场提示或压缩事件的客户端依赖任务消息保留目录，后续提示可能再次排序。

恢复会话复用缓存，普通分叉重新排序。根会话压缩后从缓存恢复，无需模型调用，可能在下一轮生效；缓存保存 30 天。评分失败按目录顺序注入并提示安全错误码。子代理配置或目录读取失败时提示警告，原任务保持不变。未知工具路径和非字符串任务不改写，钩子不可见的角色或 profile 覆盖无法解析。参见 [Codex 钩子文档](https://learn.chatgpt.com/docs/hooks#tool-coverage)。

任务变化时可调用 `search_skills`，传入 `task_description`（1–24,000 个 UTF-8 字节）和 `cwd`（任务目录的绝对路径）。工具检查同一配置，按阈值过滤，再返回指定数量的结果。无匹配与调用错误分别提示。

## 配置与面板

可选配置：`~/.config/jev-skill-router/config.json`。参见 [config.example.json](config.example.json)。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| model | gpt-6-luna | 提供商支持的辅助模型 |
| reasoningEffort | medium | 模型支持的推理强度 |
| searchMaxResults | 10 | 搜索结果上限，1–50 |
| initialMinRelevance | 0.8 | 首轮非固定技能的最低相关性，0–1，含端点 |
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

### `create_thread` 新会话

父会话的 `PreToolUse` 钩子按新会话的 `prompt` 排序技能并追加目录，保留其他参数，
避免重复追加和污染父会话缓存。无项目会话仅使用中立临时目录发现的 user/system/admin
技能。本地项目通过桌面应用只读 `list_projects` 解析项目 ID，再读取来源目录。
新 worktree 使用所选项目的主/来源工作区；目标目录无需已存在，并明确附加：
"Skills were taken from the main worktree and, in rare cases, may have drifted from this worktree."
此目录不代表已验证的目标 worktree 内容。远程、云端及无法解析的项目不注入本地目录。
查找依赖 `CODEX_APP_TOOLS_PIPE_PATH` 和随应用提供的内部协议；协议可能随版本变化，
不会读取应用私有状态文件。首次 `UserPromptSubmit` 未触发时，无法预先填充未知子会话的压缩缓存。
