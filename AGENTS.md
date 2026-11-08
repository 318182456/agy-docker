# 项目约定

- 这是独立的 agy-docker 项目，与 agy2api-workers 的数据库、账号和部署无关。
- `npm test` 为本机核心测试；生产环境使用版本化GHCR镜像，NAS用 `docker compose -f compose.nas.yaml up -d`；源码构建仅用于开发。
- 只通过原版 `agy` 子进程执行任务，不加入Google内部生成API或OAuth Token提取逻辑。
- 正常请求轮询，全局并发由MAX_CONCURRENCY配置（1–16），同账号串行，登录排他；失败不自动换账号重放；停用/登录失效需明确处理。
- 新增网页接口必须在统一register入口声明public/read/mutation/api权限，保持管理会话与API密钥分离。
- 调用CLI时不能使用shell=true、拼接命令或任意用户CLI参数；提示词使用标准输入；保持严格审批。
- 凭据、.env、data、账号授权状态、会话正文与临时验证文件不得提交Git。验证成果应明确区分模拟CLI、本机真实CLI和NAS真实Google调用。
- 界面遵循DESIGN.md和全局design-md-reference；修改后用Playwright MCP检查真实操作、保存与重载。
