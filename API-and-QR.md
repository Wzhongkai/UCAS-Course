# API 与签到二维码实现说明

本文依据当前项目中实际的 `fetch(...)` 调用整理，描述的是**代码真正发出的 HTTP 请求**，不代表已验证 UCAS 线上接口当前仍可用。示例中的账号、课程 ID 和时间戳均为占位值。若要开发直接连接 UCAS 的功能，重点看第二节；第一节是浏览器调用本项目服务端的内部 API。

## 调用关系

```text
浏览器 ── GET  /api/course-uuid/timestamp ── UCAS 时间戳接口
       ├─ POST /api/course-uuid/query     ── UCAS 登录 → 查询课表
       ├─ 本地拼签到 URL → qrcode 生成图片（无二维码生成 API）
       └─ POST /api/course-uuid/sign      ── UCAS 登录 → 直接签到
```

服务端登录后取得的 `sessionId` 只用于服务端请求，不返回给浏览器。生成二维码本身不会发起签到请求；点击“直接签到”才会调用项目的签到接口。

## 一、项目提供给前端的 API

以下路径相对于网站基地址。本地开发时通常是 `http://127.0.0.1:3100`；当前服务器部署基地址是 `https://source.cskaoyan.cn/course`，因此例如查询课程的完整地址是 `https://source.cskaoyan.cn/course/api/course-uuid/query`。所有项目 API 都需要先通过网站访问密钥验证并携带 HttpOnly Cookie。

### 1. 查询课程：`POST /api/course-uuid/query`

请求头：`Content-Type: application/json`

```json
{
  "username": "<学号>",
  "password": "<密码>",
  "date": "20260914"
}
```

- `username`、`password` 必填。
- `date` 支持 `yyyyMMdd` 和 `yyyy-MM-dd`；代码会去掉连字符并检查是否为 8 位数字，但没有进一步校验日历日期是否合法。
- 服务端依次调用 UCAS 登录和课表接口。

成功响应结构：

```json
{
  "date": "20260914",
  "total": 1,
  "courses": [
    {
      "id": "1234567",
      "uuid": "<课程UUID>",
      "courseName": "<课程名>",
      "teacherName": "<教师名>",
      "weekDay": "<星期>",
      "classBeginTime": "<开始时间>",
      "classEndTime": "<结束时间>",
      "signStatus": "<签到状态>"
    }
  ]
}
```

代码位置：[`src/app/api/course-uuid/query/route.ts`](src/app/api/course-uuid/query/route.ts)、[`src/app/page.tsx`](src/app/page.tsx)。

### 2. 获取时间戳：`GET /api/course-uuid/timestamp`

无请求体。服务端转而向 UCAS 时间戳接口发起请求，成功时返回：

```json
{
  "success": true,
  "timestamp": 1789380000000
}
```

`timestamp` 是毫秒时间戳。前端用它估算与 UCAS 服务器的时钟偏差，并将偏差缓存 30 秒。获取失败时优先复用旧偏差，否则退回本机时间；这只是降级策略，不保证签到可用。

代码位置：[`src/app/api/course-uuid/timestamp/route.ts`](src/app/api/course-uuid/timestamp/route.ts)、[`src/app/page.tsx`](src/app/page.tsx)。

### 3. 直接签到：`POST /api/course-uuid/sign`

请求头：`Content-Type: application/json`

```json
{
  "username": "<学号>",
  "password": "<密码>",
  "courseSchedId": "1234567",
  "timestamp": 1789380000000
}
```

- `courseSchedId` 必填，当前服务端仅接受**7 位数字**。服务端也读取 `timeTableId` 作为字段别名，但同样按 7 位数字校验。
- `timestamp` 可选；只有传入有限的 JSON 数字才采用该值，否则使用服务端当前的 `Date.now()`。
- 服务端先登录，再调用 UCAS 签到接口，并在该上游请求中补充用户 `id` 和请求头 `sessionId`。
- 前端点击“直接签到”时优先采用当前二维码链接中的时间戳；没有可用时间戳时，使用校准后的当前时间减去 3 秒。

成功响应结构：

```json
{
  "success": true,
  "message": "签到成功",
  "upstreamStatus": "0",
  "result": {
    "stuSignId": "<签到记录ID>",
    "stuSignStatus": "1"
  }
}
```

只有上游 `STATUS === "0"` 且 `result.stuSignStatus === "1"` 时，项目才返回签到成功；状态存在但不是 `1` 时返回 HTTP 409，其余业务失败返回 HTTP 400。

代码位置：[`src/app/api/course-uuid/sign/route.ts`](src/app/api/course-uuid/sign/route.ts)、[`src/app/page.tsx`](src/app/page.tsx)。

### 常见 HTTP 状态

| 状态 | 含义 |
| --- | --- |
| 400 | 参数或上游签到业务失败 |
| 401 | 未通过网站访问验证，或 UCAS 登录失败 |
| 403 | 请求携带的 `Origin` 与网站 `Host` 不一致 |
| 409 | 上游接受了请求，但签到状态不是完成态 |
| 415 | 请求的 `Content-Type` 不是 JSON |
| 429 | 触发项目的 IP 限流，响应含 `Retry-After` |
| 502 / 504 | 上游异常 / 请求超时 |
| 500 | 项目内部异常 |

## 二、项目实际向外发出的请求

下列是运行时源码中的真实请求。所列请求头是**代码明确设置的请求头**；运行环境可能自动添加其他标准请求头。UCAS 接口基地址为 `https://iclass.ucas.edu.cn:8181`。

### 1. 登录 UCAS

查询课表和直接签到都会各自先发出这一请求：

```http
POST https://iclass.ucas.edu.cn:8181/app/user/login.action
Content-Type: application/x-www-form-urlencoded
User-Agent: student_5.0.1.2_android_12_20__110000

phone=<学号>&password=<密码>&verificationType=1&verificationUrl=<模板URL>&userLevel=1
```

请求体实际由 `URLSearchParams` 编码，不是直接拼接上面这一行；对应代码的构造方式是：

```ts
new URLSearchParams({
  phone: username,
  password,
  verificationType: "1",
  verificationUrl: "http://iclass.ucas.edu.cn:88/ve/webservices/mobileCheck.shtml?method=mobileLogin&username=${0}&password=${1}&lx=${2}",
  userLevel: "1"
}).toString()
```

其中 `verificationUrl` 的原始字段值是：

```text
http://iclass.ucas.edu.cn:88/ve/webservices/mobileCheck.shtml?method=mobileLogin&username=${0}&password=${1}&lx=${2}
```

这个 `:88` 地址**仅作为登录请求的表单字段值发出**，项目没有对它执行独立的 `fetch`。登录成功时，代码要求上游返回 `STATUS === "0"`，并从 `result.id`、`result.sessionId` 提取后续请求所需的值。[查询路径的登录请求](src/app/api/course-uuid/query/route.ts) · [签到路径的登录请求](src/app/api/course-uuid/sign/route.ts)

### 2. 查询当天课程

只有调用项目的 `/api/course-uuid/query` 且登录成功后才会发出：

```http
GET https://iclass.ucas.edu.cn:8181/app/course/get_stu_course_sched.action?id=<登录返回的result.id>&dateStr=<yyyyMMdd>
sessionId: <登录返回的result.sessionId>
User-Agent: student_5.0.1.2_android_12_20_100000000000000_110000
```

`id` 和 `dateStr` 经 `encodeURIComponent` 放入查询字符串；无请求体。项目期望上游 `STATUS === "0"`，再读取 `result` 课程数组并只返回第一节列出的字段。[实际请求代码](src/app/api/course-uuid/query/route.ts)

### 3. 直接签到

只有调用项目的 `/api/course-uuid/sign` 且登录成功后才会发出：

```http
GET https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action?courseSchedId=<7位课程ID>&timestamp=<毫秒时间戳>&id=<登录返回的result.id>
sessionId: <登录返回的result.sessionId>
User-Agent: student_5.0.1.2_android_12_20_100000000000000_110000
```

`courseSchedId` 和 `id` 经 `encodeURIComponent` 放入查询字符串；无请求体。上游响应中，项目读取 `STATUS`、`result.stuSignId`、`result.stuSignStatus`，并按第一节所述转换为项目 API 响应。[实际请求代码](src/app/api/course-uuid/sign/route.ts)

### 4. 获取 UCAS 时间戳

只有调用项目的 `/api/course-uuid/timestamp` 时才会发出：

```http
POST https://iclass.ucas.edu.cn:8181/app/common/get_timestamp.do?id=<0到999999的随机整数>
User-Agent: student_5.0.1.2_android_12_20_100000000000000_110000
Connection: Keep-Alive
```

无请求体。虽然本项目对浏览器暴露的是 **GET** `/api/course-uuid/timestamp`，它请求 UCAS 时用的是 **POST**；`id` 仅用于避免中间节点缓存。项目要求上游 `STATUS === "0"` 且 `timestamp` 为数字。[实际请求代码](src/app/api/course-uuid/timestamp/route.ts)

页面已移除原仓库信息展示，运行时不会再请求 GitHub API。

## 三、二维码中保存的链接格式

以下是代码**构造但不会由项目自动发送**的 URL 文本。项目将它编码成二维码图片；扫码后的请求由扫码方发起，不属于本项目代码中的 `fetch`：

**查询课程后选课，或手动输入数字 ID：**

```text
https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action?courseSchedId=<课程ID>&timestamp=<毫秒时间戳>
```

**手动输入 32 位十六进制 UUID：**

```text
https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action?timeTableId=<大写UUID>&timestamp=<毫秒时间戳>
```

手动 UUID 可以带连字符；前端先去掉连字符，确认剩余部分是 32 位十六进制字符，再转为大写。手动数字 ID 接受任意长度的纯数字，但项目的“直接签到”API 只接受 7 位数字。二维码 URL 本身也不带用户 `id` 或 `sessionId`；它与服务端发起的直接签到请求不是完全相同的请求格式。

图片由浏览器本地的 `qrcode` 包生成，关键调用如下：

```ts
const { default: QRCode } = await import("qrcode");
const imageDataUrl = await QRCode.toDataURL(signUrl, {
  width: 320,
  margin: 1,
  errorCorrectionLevel: "M"
});
```

页面将生成的 Data URL 显示为二维码，或通过浏览器下载为 PNG；不依赖第三方二维码生成服务。[二维码生成与下载代码](src/app/page.tsx)

### 时间戳与刷新

1. 浏览器通过项目时间戳 API 校时，并估算请求往返延迟的一半。
2. 页面显示的二维码采用“校准后的当前时间 − 3 秒”作为 URL 的 `timestamp`。注释说明这是为了补偿 UCAS 时间戳接口与签到接口之间的服务器时钟偏差。
3. 页面每 5 秒重新生成一次二维码及其 URL。
4. 点击下载时另行生成图片，其 URL 使用“校准后的当前时间 + 10 秒”作为 `timestamp`。页面将其标为“10 秒有效”，但代码没有验证上游实际有效期。

## 四、与现有 README 的差异及使用提醒

- README 中的直接签到示例使用 32 位 UUID `timeTableId`，但**当前签到路由只接受 7 位数字**。要调用 `POST /api/course-uuid/sign`，应使用数字 `courseSchedId`。
- 生成二维码只是生成签到链接和图片，并不证明已经签到成功；应以上游签到响应中的状态为准。
- 网页正常链路中，学号和密码由浏览器提交给项目服务端，再由项目服务端用于登录 UCAS；测试脚本则会直接向 UCAS 发送凭据。开发时应保护请求与部署环境，避免把真实凭据写入示例、日志或版本库。

## 五、本项目新增的自动签到接口

本项目包含自动签到设置和后台任务。网站入口先使用 `UCAS_ACCESS_KEY` 建立 HttpOnly Cookie；自动签到页不再单独要求管理密钥。以下接口只供同一网页使用，它们**不是 UCAS 的接口**：

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/access` | 提交 `{ "key": "<网站访问密钥>" }`，验证后设置 7 天有效的 HttpOnly Cookie |
| `DELETE /api/access` | 清除网站访问 Cookie |
| `GET /api/automation` | 读取账号列表、分账号后台计划和最近 100 条日志；已认证时返回学号，不返回密码 |
| `POST /api/automation` | 提交 `{ "action": "add", "username": "<学号>", "password": "<密码>" }` 添加并启用账号，返回新账号的 `id` |
| `POST /api/automation` | 提交 `{ "action": "toggle", "accountId": "<账号ID>", "enabled": false }` 暂停或启用指定账号 |
| `POST /api/automation` | 提交 `{ "action": "password", "accountId": "<账号ID>", "password": "<新密码>" }` 更新密码 |
| `POST /api/automation` | 提交 `{ "action": "timing", "accountId": "<账号ID>", "timing": { "mode": "fixed", "fixedMinutes": 10 } }` 设置固定提前时间 |
| `POST /api/automation` | 提交 `{ "action": "timing", "accountId": "<账号ID>", "timing": { "mode": "random", "minMinutes": 10, "maxMinutes": 20 } }` 设置随机提前区间 |
| `POST /api/automation` | 提交 `{ "action": "refresh", "accountId": "<账号ID>" }` 重新查询指定账号课表 |
| `POST /api/automation` | 提交 `{ "action": "remove", "accountId": "<账号ID>" }` 移除账号并停止其后续任务 |

自动签到后台进程不通过项目的 `/api/course-uuid/query`、`/api/course-uuid/sign` 代理，而是复用第二节列出的 UCAS 登录、课表、时间戳、签到请求格式，直接在服务器端发送。每个账号独立使用自己的登录会话和签到时间配置；固定模式按指定提前分钟数开始，随机模式则为每个账号和课程生成稳定的区间内时间点。到达计划时间后每隔至少 10 秒尝试签到。实测课表接口会用 HTTP 200、`STATUS="2"` 且不返回 `result` 表示当天无课；该响应以及成功的空数组都会标记为“今日无课”，直接等待次日 06:00。登录、网络、响应格式或其他业务状态错误才会在 5 分钟后重试。某账号所有课程都成功后停止该账号当天的尝试，第二天继续自动查询。同名且起止时间完全相同的多条课表记录会合并为一个目标，后台轮换其 `courseSchedId`，任意一个返回成功即停止整个目标；起止时间有任一不同就作为独立目标。[后台代码](src/worker-multi.mjs) · [接口代码](src/app/api/automation/route.js)
