# UCAS Course

一个通过网页管理的 UCAS 课程查询、签到二维码、手动签到和多账号自动签到应用。页面不再依赖原项目仓库接口，所有功能均由本项目和 UCAS 接口完成。

## 自动签到规则

- 后台进程每天 **06:00（北京时间）**分别查询每个已启用账号的当天课表。如果程序在 06:00 之后才启动或才启用账号，会立即补查当天课表；查询失败则每 5 分钟重试。网页可单独刷新某个账号的课表。
- 按每组课程第一节的开始时间，在**课前 10 分钟**发起签到。失败后每次请求完成至少间隔 **10 秒**再试；若 UCAS 返回 HTTP 429，则尊重 `Retry-After`。
- 只有 UCAS 返回 `STATUS="0"` 且 `result.stuSignStatus="1"` 才认定成功。成功或课表已显示“已签到”后停止重试；若仍未成功，第一节课结束时停止并提示人工核查。
- 某账号当天所有目标课程都已签到后，停止该账号当天的签到尝试；后台进程仍保持运行，以便第二天自动查询新课表。多个账号互不影响。
- 同名且上课、下课时间完全一致，但教师或课程 ID 不同的记录视为同一节课的多个签到入口。后台每次重试时依次轮换入口，任意入口成功后整组停止；网页会同时显示这些课程 ID。
- 只要开始时间或结束时间不同，就视为另一节课并单独安排签到，不再合并相邻时间段。
- 签到时间戳沿用原项目的 UCAS 校时和减去 3 秒缓冲策略。时间统一按 `Asia/Shanghai` 计算。

## 本地启动

需要 Node.js 20.9 或更新版本。建议在 Ubuntu/WSL 终端中运行：

```bash
cd UCAS-Course
npm install
test -f .env.local || cp .env.local.example .env.local
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

将上面生成的两个不同随机值分别填入 `.env.local` 中的 `AUTO_SIGN_SECRET` 和 `UCAS_ACCESS_KEY`，然后启动：

```bash
npm run dev
```

这两个配置的用途分别是：

- `AUTO_SIGN_SECRET`：64 位十六进制字符串，仅用于加密保存 UCAS 凭据。
- `UCAS_ACCESS_KEY`：至少 16 个字符，是整个网站的访问密钥。通过验证后，课程查询、二维码、手动签到和自动签到管理都可直接使用；自动签到页没有第二层密钥。

启动后在浏览器访问 `http://127.0.0.1:3100`（可用 `APP_PORT` 修改端口），先输入网站访问密钥，然后即可在同一页面添加、暂停或移除多个学号，也可以单独更新密码、刷新课表。页面按学号展示当天计划、尝试次数和结果，并显示最近 100 条运行日志。手动查询、二维码及手动签到也可使用。

UCAS 凭据不会写入 `.env.local`；网页提交后使用 AES-256-GCM 加密保存在 `data/automation.json`。接口可以返回学号，但永不返回密码，日志使用脱敏学号。`data/` 和 `.env.local` 已加入 `.gitignore`。请备份 `AUTO_SIGN_SECRET`：丢失或更换后，原有凭据将无法解密，需要重新设置。旧变量 `AUTO_SIGN_ADMIN_TOKEN` 仅为兼容已有本地配置，新部署请使用 `UCAS_ACCESS_KEY`。

## 部署到服务器

这是需要**常驻进程**的应用，不适合没有持久后台进程的 Serverless 部署。生产构建必须带上访问前缀：

```bash
APP_BASE_PATH=/course npm ci
APP_BASE_PATH=/course npm run build
APP_BASE_PATH=/course APP_HOST=127.0.0.1 APP_PORT=3110 npm start
```

项目内置 `deploy/start-app.sh`。它使用服务器的 Node.js 24 构建应用，并安装会自动重启、随服务器启动的 systemd 服务；同时提供向现有 `source.cskaoyan.cn` HTTPS 站点添加 `/course` 的 Nginx 配置和安装脚本。部署后的访问地址为：

```text
https://source.cskaoyan.cn/course
```

默认只监听 `127.0.0.1:3110`，避免与服务器已有的旧课程工具冲突，由 Nginx 对外提供 `/course`。请确保只有一个应用实例负责调度，并将自动签到数据持久化；可用 `AUTO_SIGN_DATA_DIR` 指定数据目录。

当前服务器的部署约定：

```text
项目目录：/srv/ucas-course
私密配置：/etc/ucas-course.env
持久数据：/var/lib/ucas-course
服务名称：ucas-course.service
```

更新应用可依次执行 `bash deploy/start-app.sh` 和 `bash deploy/install-nginx.sh`。服务器已经持有 `source.cskaoyan.cn` 的有效 HTTPS 证书，安装脚本只会为现有站点增加 `/course` 转发，不会重新申请证书。

部署后可执行 `bash deploy/verify-app.sh`，在不输出访问密钥的情况下检查访问验证、首页、后台进程和开机任务。

服务器部署时应启用 HTTPS，妥善保护访问密钥和加密密钥。服务器关机、进程退出、断网或 UCAS 接口改变时，无法保证自动签到成功。可在网页状态和日志中核查结果。

## 验证

```bash
cd /mnt/d/UCAS-Course
npm test
npm run build
```

自动化测试使用模拟 UCAS 响应，不会真实登录或签到。接口格式及二维码说明见 [API-and-QR.md](API-and-QR.md)。
