# UCAS Course

UCAS 课程查询、签到二维码和自动签到管理工具。项目提供一个统一网页，可查询课表、生成签到链接或二维码、手动发起签到，并为多个账号安排每日自动签到。

使用 QQ 机器人前，先看 [机器人创建与配置](QQ机器人配置_需要人工操作.md)；启动、绑定和指令见 [QQ 本地调试说明](QQ-LOCAL-DEBUG.md)。

> 本项目仅供学习、研究和个人使用。请遵守学校规章及相关系统的使用约定。签到受课程状态、网络、服务器时间和上游接口影响，程序不能保证每次成功，请以课程页面和教师要求为准。

## 功能

- QQ 机器人私聊绑定学号，普通用户按本人绑定管理课程；管理员可进入管理员模式，按学号添加、删除和管理账号。
- 一个 QQ 只能绑定一个学号，同一学号可绑定多个 QQ；通知偏好与解绑各自独立，课表和打卡设置共享。
- QQ 课表查询实时读取后台当天课程，返回课程名称、教师、时间、教室、计划签到时间和当前状态。
- QQ 支持固定或随机提前时间、单课停用/恢复、通知全部/仅失败/关闭。
- QQ 签到成功通知会显示实际使用的方法：`UUID` 或 `courseSchedId`；仅从课表确认已签到时标为方式未知。
- QQ 私聊可查询雁栖馆余座，也可订阅三层中厅自助学习区的余座变化，无需绑定学号。

- 使用学号、密码和日期查询课程。
- 在浏览器本地生成动态二维码，优先使用课表的 32 位 UUID，缺少有效 UUID 时使用 7 位课程场次 ID。
- 网页直接签到和后台自动签到也使用同一规则：优先传 UUID；缺少有效 UUID 才传 7 位课程场次 ID。
- 在同一个网页维护最多 20 个自动签到账号，可分别启用、暂停、配置签到时间、更新密码、刷新课表或移除。
- 显示每个账号当天的课程计划、签到状态、尝试次数和最近 100 条后台记录。
- 使用统一的网站访问密钥保护页面和内部 API；自动签到页面不再设置第二层管理密钥。
- 使用 AES-256-GCM 加密保存自动签到账号凭据。

## 自动签到规则

- 每天 06:00（`Asia/Shanghai`）查询各个已启用账号的当天课表。若程序在 06:00 后启动或账号刚启用，会立即补查；失败后每 5 分钟重试。
- 每个账号可选择固定提前 1～120 分钟，或在指定的提前分钟区间内为每节课生成一个随机时间点。旧账号默认固定提前 10 分钟；同一账号、同一天、同一课程的随机结果在后台重启后保持不变。
- 每个自动签到账号都可以设置不打卡课程名单。名单按完整课程名精确匹配（会统一全角字符、首尾空格、连续空白和英文字母大小写）；名单内课程不会生成签到计划，也不会发起签到请求，留空表示该账号的全部课程正常签到。
- 到达该课程的计划时间后开始尝试。一次请求完成后至少等待 10 秒再试；遇到 HTTP 429 时遵守上游的 `Retry-After`。
- 只有上游返回 `STATUS="0"` 且 `result.stuSignStatus="1"`，或课表已经显示该课程已签到，才记录为成功。
- 成功后停止该课程的后续请求；一个账号当天所有课程都完成后，停止该账号当天的签到尝试，次日仍会正常查询课表。
- 课程名称、开始时间和结束时间完全相同的多条记录视为同一节课的多个入口。后台优先轮换有效的 UUID；整组都没有有效 UUID 时才轮换 7 位场次 ID。任一入口成功后整组停止。
- 开始时间或结束时间不同的记录均作为独立课程，不合并相邻或连续时间段。
- 到课程结束时间仍未成功时停止自动请求，并在网页中提示人工核查。
- 签到前通过 UCAS 时间戳接口校时，并沿用 3 秒时间缓冲。
- UCAS 课表接口返回成功空数组，或返回其无课状态 `STATUS="2"` 且没有错误信息和结果时，记录为“今日无课”，当天不再重复查询；只有登录、网络、响应格式或其他上游错误才会每 5 分钟重试。

## 环境要求

- Node.js 20.9 或更高版本。
- 一台可以持续运行并访问 UCAS 接口的机器。自动签到不适合无常驻进程和无持久磁盘的 Serverless 环境。
- 生产环境应使用 HTTPS，并限制能够访问网站的人。

## 本地运行

```bash
git clone https://github.com/<your-account>/UCAS-Course.git
cd UCAS-Course
npm ci
cp .env.local.example .env.local
```

生成两个不同的随机值：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

填写 `.env.local`：

```dotenv
# 必须是 64 位十六进制字符串，用于加密保存 UCAS 凭据
AUTO_SIGN_SECRET=

# 至少 16 个字符，用于验证整个网站的访问者
UCAS_ACCESS_KEY=
```

然后启动开发环境：

```bash
npm run dev
```

默认地址是 `http://127.0.0.1:3100`。通过访问密钥验证后，即可使用全部功能。

## Windows、macOS、Linux 免安装便携包

便携包内含对应系统的 Node.js 运行时，使用者无需安装 Node.js 或运行 `npm ci`。**每种系统和 CPU
架构需要分别在对应的原生系统上构建**，不能把 Windows ZIP 直接复制到 macOS/Linux 使用。

先在构建机器上执行 `npm ci`，再运行对应命令：

| 构建机器 | 命令 | 输出 |
| --- | --- | --- |
| Windows x64 | `npm run build:windows` | `dist/UCAS-Course-Portable.zip` |
| macOS x64/arm64 | `npm run build:portable` | `dist/UCAS-Course-Portable-macos-<架构>.tar.gz` |
| Linux glibc x64/arm64 | `npm run build:portable` | `dist/UCAS-Course-Portable-linux-<架构>.tar.gz` |

也可以在 GitHub Actions 中手动运行 **Build portable packages**，由原生运行器分别生成五种包，
在该次运行的 Artifacts 中下载。便携包仍是本地网页：解压后 Windows 双击 `Start-UCAS-Course.cmd`；
macOS 双击 `Start-UCAS-Course.command` 或从终端运行 `./Start-UCAS-Course.sh`；Linux 从终端
运行 `./Start-UCAS-Course.sh`。macOS 包未经过 Apple 签名，首次打开可能需要用户自行确认。

在 Windows + WSL 上，从项目根目录运行 `wsl -- bash ./scripts/build-linux-from-wsl.sh`，
可在隔离的 Linux 临时目录构建 Linux 包并复制回项目的 `dist/`。

便携版固定只监听 `127.0.0.1`，就绪后尝试自动打开浏览器；它使用本地桌面模式，不需要网站访问
密钥。自动签到数据、日志和首次生成的加密密钥位于各系统的用户数据目录，详见包内
`README-PORTABLE.txt`。**启动器窗口须保持运行**，关闭浏览器不会停止后台；关闭启动器或按
`Ctrl+C` 会清理网页和后台进程。便携包不能作为公网服务部署。

构建会校验官方 Node.js 运行时 SHA256，并审计打包目录，拒绝把 `.env.local`、`data` 和本机密钥
带入包内。`LOCAL_DESKTOP_MODE=1` 仅供便携启动器使用，且只有在 `APP_HOST` 与 `HOSTNAME` 同时为
`127.0.0.1` 时才有效；普通开发和生产部署仍要求 `UCAS_ACCESS_KEY`。

## QQ 机器人

QQ 接入使用官方 WebSocket 和 HTTP API，不依赖 Agent 或大模型。完整配置、管理员模式、绑定流程和指令清单见 [QQ 本地调试说明](QQ-LOCAL-DEBUG.md)。

本地调试：

```powershell
npm run qq:setup
# 在 qq.local.env 中填写 QQ_BOT_APP_ID、QQ_BOT_APP_SECRET
npm run dev:qq
```

普通用户绑定后可直接发送 `查询课表`、`开启打卡`、`停止打卡 高等数学`、`签到时间 所有 随机 5 10`、`通知 全部`。管理员默认按本人模式操作；发送 `进入管理员模式` 后，账号指令必须带学号，并可使用 `添加学号` 和 `删除学号`。

多个 QQ 可以分别验证同一个学号的密码并绑定，课程仍只生成一份打卡任务，通知按各 QQ 的偏好分别发送。普通模式下的 `通知` 和 `解绑` 只影响自己；修改课程时间或打卡开关则对共享该学号的全部 QQ 生效。管理员也只能绑定一个学号，管理其他学号通过管理员模式完成。

图书馆指令：`查询图书馆座位` 查看雁栖馆余座；`订阅自助区` 或 `启动订阅` 开启三层中厅自助学习区的余座变化提醒；`关闭订阅` 停止提醒。机器人每分钟检查一次，图书馆订阅与课程签到通知分开管理。

生产环境需要同时运行网页、自动签到 worker 和 QQ 进程，并把 `QQ_BOT_ENABLED`、`QQ_BOT_APP_ID`、`QQ_BOT_APP_SECRET`、`QQ_BOT_ADMIN_OPENIDS` 放入受保护的环境文件。不要把 `qq.local.env`、`.env.local`、`data/` 或服务器环境文件提交到 Git。

## 自动签到使用

1. 打开“自动签到”，填写学号和密码并添加账号。新账号默认启用，并采用固定提前 10 分钟。
2. 在账号卡片的“签到时间”中选择“固定提前”或“随机区间”，填写 1～120 分钟并保存。随机区间填写的是“最少提前”和“最多提前”，例如 10～20 分钟。
3. 后台获取课表后，“今日签到计划”会显示每节课实际的开始尝试时间。随机模式精确到区间内的时间点，并在同一天保持稳定。
4. 可以单独暂停账号、更新密码或要求立即刷新课表。关闭浏览器不会停止任务，但运行 `npm start` 的后台进程必须保持在线。

课表查询结果会按下面的方式处理：

| 页面状态 | UCAS 响应或异常 | 后续行为 |
| --- | --- | --- |
| 有课程 | `STATUS="0"` 且 `result` 是非空数组 | 生成当天签到计划，次日 06:00 再查 |
| 今日无课 | `STATUS="0"` 且 `result` 是空数组，或 `STATUS="2"` 且没有错误信息和结果 | 当天不再查询，次日 06:00 再查 |
| 查询失败 | 登录、网络、超时、异常业务状态或结果格式错误 | 保留错误信息，5 分钟后重试 |

## 配置项

| 变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `AUTO_SIGN_SECRET` | 自动签到必需 | 无 | 64 位十六进制加密密钥。更换后无法解密此前保存的账号 |
| `UCAS_ACCESS_KEY` | 是 | 无 | 整个网站的访问密钥，至少 16 个字符 |
| `AUTO_SIGN_DATA_DIR` | 否 | `data` | 自动签到配置、状态和日志的持久化目录 |
| `APP_HOST` | 否 | `127.0.0.1` | Next.js 监听地址 |
| `APP_PORT` | 否 | `3100` | Next.js 监听端口 |
| `APP_BASE_PATH` | 否 | 空 | 网站路径前缀，例如 `/course`；构建和运行时必须保持一致 |

`AUTO_SIGN_ADMIN_TOKEN` 仅用于兼容旧配置，新部署应使用 `UCAS_ACCESS_KEY`。

## 生产部署

下面以网站挂载在 `/course`、应用监听本机 3100 端口为例：

```bash
npm ci
APP_BASE_PATH=/course npm run build
APP_BASE_PATH=/course APP_HOST=127.0.0.1 APP_PORT=3100 npm start
```

部署时还需要：

1. 使用 systemd、容器编排或其他进程管理器保持 `npm start` 运行。该命令会同时启动网页和自动签到后台。
2. 使用 Nginx 等反向代理将 `/course` 原样转发到应用端口，并传递 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。
3. 为站点启用 HTTPS。访问 Cookie 仅在应用收到 HTTPS 转发信息时设置 `Secure` 属性。
4. 持久化 `AUTO_SIGN_DATA_DIR`，并确保只有应用账号可以读取该目录和环境变量。
5. 只运行一个自动签到实例。不同服务器上的多个实例无法共享进程锁，可能产生重复请求。

`deploy/` 中包含通用的 systemd 和 Nginx 模板。运行 `deploy/start-app.sh` 前必须通过环境变量明确传入 `ENV_FILE`、`DATA_DIR` 和 `RUN_USER`；可选传入 `PROJECT_DIR`、`NODE_BIN`、`NPM_BIN`、`APP_BASE_PATH`、`APP_PORT` 和 `SERVICE_FILE`。运行 `deploy/install-nginx.sh` 前必须传入 `PROJECT_DIR` 与 `NGINX_SITE_FILE`，并根据现有站点结构设置可选的 `NGINX_INSERT_BEFORE`。脚本不会再假定维护者的域名、账号或文件路径。

更新已有部署时，可先在与目标系统兼容的环境中构建（例如在本机 WSL 构建 Linux 版本），上传到独立版本目录并校验构建包。保留环境配置和持久化目录，停止服务后备份数据，再在同一文件系统上原子替换 `current` 符号链接并启动服务。检查网页、签到后台和 QQ 连接；若启动失败，可切回保留的上一版。不要用新文件覆盖或删除上一版目录。

## 数据与安全

- 自动签到账号保存在 `AUTO_SIGN_DATA_DIR/automation.json`，密码使用 `AUTO_SIGN_SECRET` 加密；网页和管理 API 不返回密码。
- 普通课程查询和手动签到所填写的密码不会写入自动签到配置。
- `.env.local`、`data/`、构建目录和依赖目录已被 Git 忽略，不应提交到版本库。
- 网站访问密钥会建立有效期 7 天的 HttpOnly、SameSite=Strict Cookie。它用于防止未经授权访问，但不能替代 HTTPS、防火墙和服务器权限控制。
- `LOCAL_DESKTOP_MODE=1` 不是通用免鉴权开关：应用只有在 `APP_HOST=127.0.0.1` 且 `HOSTNAME=127.0.0.1` 时才会启用它；普通开发或生产环境不会跳过访问密钥校验。
- 请备份 `AUTO_SIGN_SECRET` 与持久化数据。密钥丢失后只能删除旧配置并重新录入账号。

## 开发与验证

```bash
npm test
npm run lint
npm run build
```

自动化测试使用模拟响应，不会真实登录 UCAS 或发起签到。项目实际发送的 UCAS 请求、内部 API 以及二维码链接格式见 [API-and-QR.md](API-and-QR.md)。

## 许可证

本项目使用 [GNU Affero General Public License v3.0](LICENSE)。
