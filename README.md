# AGY Docker

在 Docker 中启动真正的官方 Antigravity CLI（`agy`），通过网页或受保护接口提交文本任务。CLI 自行完成 Google 认证与上游通信；项目不读取、复制或转发 OAuth Token，也不实现 Google 内部生成接口。

## 当前功能

- 多账号独立 HOME / XDG 目录；模型目录来自各账号的 `agy models`，不维护模型名单。
- 新任务在已启用且支持指定模型的账号之间轮询；可显式指定账号。失败不会自动换号重放，也不会重新执行已提交的生成。
- 全局并发由 `MAX_CONCURRENCY` 配置（1–16，默认1），同一账号始终串行，队列默认最多32项；断开客户端会取消排队或终止正在执行的 CLI 进程组；执行超时默认 180 秒。
- 管理页添加、改名、启用、停用、移除账号；登录说明与错误就近展示。移除只删除记录，保留登录目录。
- 原生文本任务接口及 OpenAI 兼容文本 Chat Completions，`stream=true` 提供等待心跳与完成后输出，响应头 `x-stream-mode: buffered` 明确区分真正增量流。
- 默认保留7天、最多2000条请求元数据、各账号请求数与 CLI 报告 Token、网关和 CLI 独立 RSS。CLI 自身可能保存会话/日志，数据目录应视为敏感文件。

## 群晖安装

项目路径建议 `/volume1/docker/agy-docker`。需要 Container Manager 与 Docker Compose v2；支持 amd64/arm64。镜像固定官方 CLI 1.5.3，并核对官方发布产物 SHA-256。不是完整桌面或浏览器容器。

生产环境直接拉取版本镜像，不需要 Node、Git 或本地编译。将 `compose.yaml` 和 `.env.example` 放入项目目录，复制 `.env.example` 为 `.env`，填写两个不同的长随机密码：`ADMIN_PASSWORD` 和 `API_KEY`。

```sh
docker compose pull
docker compose up -d
```

本NAS使用 Dockhand 默认模板：改用仓库中的 `compose.nas.yaml`，加入现有共享入口和 `postgres-network`。在Dockhand中编辑 `.env` 后部署；命令行执行 `docker compose --env-file ../all/global.env --env-file .env -f compose.nas.yaml pull` 和相同参数的 `up -d`。

通用模板通过 `.env` 的 `DATA_PATH` 指定数据目录（兼容默认 `/volume1/docker/agy-data`）；NAS模板直接使用 `./data:/data`，实际是 `/volume1/docker/agy-docker/data`，不是命名卷。升级时保留现有挂载，不要切到另一份空目录。首次部署需创建目录并使UID/GID 1000可读写；不要递归修改其他应用目录权限。

| 变量 | 默认/用途 |
| --- | --- |
| `IMAGE_TAG` | `0.2.0`，发布版本；按需升级 |
| `ADMIN_PASSWORD` | 管理页登录密码，至少20字符 |
| `API_KEY` | 客户端Bearer密钥，至少20字符，须与管理密码不同 |
| `PORT` / `BIND_ADDRESS` | `18861` / `0.0.0.0`，宿主机访问入口 |
| `DATA_PATH` | `/volume1/docker/agy-data`，持久化目录 |
| `MAX_CONCURRENCY` | `1`，范围1–16；不同账号可并行，同账号串行 |
| `QUEUE_LIMIT` | `32`，范围1–1000 |
| `TASK_TIMEOUT_SECONDS` | `180`，任务执行超时 |
| `TRAEFIK_SUBDOMAIN` / `TRAEFIK_CONTAINER_PORT` | NAS模板入口与内部18861端口 |

管理密码与API密钥保存在项目 `.env`，Google授权保存在数据目录，由官方CLI管理。修改环境变量后需重新部署容器。更新不会删除数据；回退只修改 `IMAGE_TAG` 并重新部署，保留原数据备份。

宿主机环境中的 `BIND_ADDRESS` 控制发布网卡；局域网部署可设 `0.0.0.0`。不要直接将管理端口暴露公网；需要公网时由反向代理提供 HTTPS，代理保留原始 Host。无需 PUBLIC_ORIGIN，内网地址与外网域名均可登录，仍校验来源和 CSRF。

## 添加与登录账号

在“账号与额度”页添加账号，点击当前行“登录 agy”。程序自动完成官方首次菜单设置；用户只需打开 Google 官方授权页并粘贴一次性授权码。Google密码只在Google页面输入。授权码提交后清空、不落盘，完整CLI登录日志仅当前管理会话可见。自动校验包括读取模型目录与一次小规模真实生成；成功后可启用账号。菜单变化时可展开手动控制。

登录最长10分钟，与模型任务互斥，可以取消。同一管理会话切换页面后返回可恢复进行中的登录；服务重启后未完成的登录需重试，已持久化账号不受影响。仅自动信任各账号独立的空 `login-workspace`。账号目录为容器 `/data/accounts/<账号ID>`，按账号隔离HOME、D-Bus和GNOME Keyring。

## 管理台页面

- **概览**：可点击的指标、保留范围内的每日趋势、账号与模型排行、网关和CLI内存。
- **账号与额度**：搜索、批量启停、就近编辑与官方授权；直接显示5小时和周剩余额度、北京时间重置时间。
- **模型目录**：来自各账号实际目录，支持搜索、可用性筛选与复制ID。
- **任务调试**：选择账号和模型执行真实任务，支持取消与复制结果。
- **请求记录**：按账号、密钥、模型、状态和时间筛选、分页、查看详情、导出匹配JSON与清理。
- **API密钥**：创建、改名、停用、删除、可选到期、就近查看/复制、New API导入和累计消耗。
- **接口接入**：当前入口、复制示例和明确的兼容范围。
- **设置**：日志保留天数、记录上限、额度缓存时间、分页和Docker日志级别；并发与超时仍由.env控制。

页面使用独立 `/panel/...` URL，支持直接访问、刷新和浏览器前进后退；提供手机导航、深浅色主题与本地项目图标。动态数据仍需管理会话，静态页面不包含账号或凭据。

额度通过官方 `agy --print /usage --output-format json` 查询，不进行模型生成，不计入模型请求消耗。后台逐账号刷新，默认缓存300秒，页面先展示缓存；手动刷新可跳过缓存。保持官方原始分组，Gemini 4等独立组不会被合并。缺失值显示“未提供”，0%才表示耗尽。查询失败保留旧快照并标记时间，不误判账号失效。

统计口径：概览趋势和排行基于保留的请求记录，清理或超出保留范围后不代表完整历史；账号累计计数独立保留。密钥累计统计从创建/导入开始，总密钥从0.2.0启用后开始，不回填无法归属的历史请求。未上报Token不估算。

项目密钥保存在权限受限的 `/data/state.json`，仅管理员显式查看时返回完整值；不使用额外加密密钥，备份应视为敏感文件。New API支持每行 `名称<TAB>密钥` 或JSON数组 `[{"name":"项目","key":"原密钥"}]`；导入后客户端可继续用原密钥。`.env`中的API_KEY继续兼容，管理密码不能作为模型API密钥。

## 接口

- `GET /health`：公开存活检查，不访问 Google。
- `GET /v1/models`：Bearer API_KEY，读取已启用账号缓存的真实模型目录，不额外查询 Google。
- `POST /v1/chat/completions`：Bearer API_KEY。支持文本 messages、model、stream、account_id，以及客户端 function tools/tool_choice/parallel_tool_calls、assistant.tool_calls 和 tool 结果消息。工具通过官方 --json-schema 结构化输出适配，由客户端执行；不是CLI原生工具透传，也不会在NAS运行客户端工具。支持reasoning_effort映射到官方 --effort。图片/音频暂不支持。
- `POST /api/tasks`：管理会话与CSRF，用于网页原生任务提交。
- `/api/accounts` 与 `/api/status`：仅管理会话；API密钥不能访问。

OpenAI 文本会话会序列化为文字交给 agy，而不是原始模型协议。agy 自身有系统指令和权限策略，不是裸模型 API；不能承诺外部 Agent 的所有行为兼容。客户端函数工具通过结构化输出适配；并非原生工具透传。

## 安全与资源

- 默认非root、只读容器根文件系统、无Docker Socket、去除Linux capabilities、禁止提权；只挂载 `/volume1/docker/agy-data:/data`。
- CLI严格工具审批，超出工作区访问关闭；程序不给CLI传管理密码或客户端API密钥，不使用 `--dangerously-skip-permissions`。
- 通过 `spawn` 参数数组和结构化 stdin 传内容，不拼接shell；显式拒绝 CLI 本地文件引用，内容应由客户端直接提交。账号ID、模型、正文大小、输出、队列均有边界。
- 管理会话为随机HttpOnly Cookie，空闲30分钟、绝对12小时，HTTPS地址启用Secure；修改需同源与CSRF。登录失败每来源10分钟最多10次，不信任客户端X-Forwarded-For。
- Compose内存上限2GiB，仅作为保护上限，并非预先占用。程序按配置限制并发，同账号串行。实际占用由页面及 `docker stats` 查询；账号目录不等于常驻CLI，只有执行任务时启动进程。
- 本程序对提示词/回答只做返回，不写进元数据记录；官方CLI仍可能在自己的目录写日志/会话。不要将data/.env或授权文件提交Git。

Google当前FAQ说明：消费订阅下将agy包装到第三方应用或自动账号轮换不受支持；真实官方进程及Docker隔离都不构成防封保证。参照 https://antigravity.google/docs/faq/ 。

## 开发和验证

Node.js22，依赖由npm锁文件固定。`npm test` 使用临时目录、真实子进程和本机HTTP验证认证、账号隔离、轮询、超时、取消及输出解析；模拟CLI不能视为真实Google生成验证。官方协议说明：https://antigravity.google/docs/cli/headless/ 。

该项目独立于 agy2api-workers；不复用其D1/DO、密钥或Google凭证。

## 下载受限时的离线构建

安装器也接受构建上下文根目录中的 `.agy-offline.tgz`。仅从官方固定版本下载与NAS架构一致的归档，放在系统临时构建目录中，连同源码一起构建；安装器会执行同一固定SHA-256校验。该文件不进入最终镜像，不应保留在源码仓库。在线构建仍从官方GitHub附件API下载。

## NAS Dockhand 模板

NAS Compose 参考现有默认模板：继承 `/volume1/docker/all/compose-presets.yml` 的 `web-sso-bridge-model-api` 共享入口，加入外部 `postgres-network`，继承全局代理变量。应用名称、端口和数据卷保持本项目配置；不复制模板中的 Hindsight 端口或数据库。内网 `http://sa6400:18861`，外网 `https://agy-docker.wangxy.host:8443`。CLI 命令行部署时用 `docker compose --env-file ../all/global.env --env-file .env -f compose.nas.yaml up -d`；Dockhand 使用页面全局变量。

## 镜像发布与开发

GitHub Actions先运行测试，再构建linux/amd64和linux/arm64并发布到GHCR。版本标签 `v0.2.0` 对应镜像 `0.2.0`；main分支构建 `edge`，避免普通提交覆盖稳定版本。开发时使用 `docker compose -f compose.yaml -f compose.dev.yaml up --build`。

镜像首次发布后，GHCR包需设为Public才能匿名拉取（GitHub默认Private）；私有部署使用有read:packages权限的凭据登录GHCR。官方CLI归Google所有，本仓库不改变其条款或订阅限制。

## Linux登录与代理

镜像提供D-Bus及GNOME Keyring，按账号隔离会话总线、密钥环和HOME。授权状态由官方CLI存入账号自己的持久化目录；临时总线及守护进程在最后一个使用者结束后退出。密钥环解锁材料由程序生成并存于账号目录，不能提交Git。HTTP代理会作为HTTPS_PROXY的默认值，支持Google授权码交换。管理页完整显示CLI登录日志和原始错误，日志仅当前会话内存可见、不写入应用日志文件；取消和校验不会隐藏原始错误。
网页登录自动选择Google OAuth、默认主题并关闭可选互动数据收集；用户只需在Google官方页面授权并粘贴一次授权码，程序随后自动执行小规模真实调用校验。当前终端画面与完整CLI日志分别显示，未知新菜单可展开手动控制。
NAS迁移或复制数据后，目录和文件需归属容器用户UID/GID 1000:1000。若启动日志出现 /data/state.json 的 EACCES，先核对实际挂载目录，再修复该目录归属；不要将所有文件改为777，也不要用另一份空数据覆盖账号。

客户端兼容说明：

- temperature、top_p、max_tokens、max_completion_tokens、seed、stop 可兼容接收，但官方CLI没有等价控制，不生效项会列在响应头 x-agy-ignored-parameters 和非流式响应 agy.ignored_parameters 中。不会据此声称严格截断输出或采用指定采样策略。
- 工具名称和参数按客户端的JSON Schema校验，支持Draft7/2019-09/2020-12及本地引用；无效参数或未知工具返回明确错误，不把不完整结果当成成功。工具调用流为缓冲SSE，支持stream_options.include_usage。
- n只支持1；response_format及旧functions/function_call尚不支持，返回明确错误。CLI原生工具审批仍保持严格；用户传入的客户端函数只生成调用请求，不由网关执行。
- 管理页“支持模型”汇总账号实际返回的模型目录，可搜索、筛选可调用模型及复制ID；未启用账号的模型仍会显示，但可用账号数为0。模型清单在登录自动校验后同步刷新。
- 首次工作区确认仅自动信任本账号的login-workspace独立空目录，不信任保存登录状态的home或客户端指定目录。

官方结构化输出参考：https://antigravity.google/docs/cli/headless/

## Docker日志与Compose选项

默认stdout输出JSON事件，可用 `docker compose logs -f --tail=100 app` 或Dockhand日志页查看。记录请求进入、排队、开始、成功/失败、请求ID、账号/模型、执行耗时、排队耗时及Token；官方授权只记录阶段，额度查询单独记录。API准备阶段的错误也关联请求ID，不再只有启动日志。不会将请求正文、回答、密码、API密钥、OAuth授权码或完整授权链接写进Docker日志。

日志级别默认info，可在设置页修改；显式设置环境变量LOG_LEVEL时以部署环境为准。网页元数据保留由设置管理，Dockerstdout轮转由Compose的logging管理，两者独立。

NAS模板保留共享SSO入口、代理和postgres-network，删除冗余hostname与CPU权重。`init`负责回收CLI子进程；`restart`控制异常重启；`env_file`加载配置；端口和bind目录提供访问与持久化；`read_only`配合/tmp临时目录以及cap_drop/security_opt提供加固；`mem_limit`防止内存失控；日志最多2个5MiB文件，防止长期运行占满磁盘。加固和资源限制不是所有Docker服务的必需项，但适合启动CLI子进程的本项目。
