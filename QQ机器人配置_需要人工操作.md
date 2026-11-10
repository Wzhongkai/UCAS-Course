# QQ 机器人创建与配置

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，记录该机器人的 AppID 和 AppSecret，并按平台要求开通私聊测试。
2. 在项目根目录运行 `npm ci` 和 `npm run qq:setup`。打开生成的 `qq.local.env`，填写 `QQ_BOT_APP_ID` 和 `QQ_BOT_APP_SECRET`。此文件只保存在本机，不要提交到仓库。
3. 执行 `npm run dev:qq`，在 QQ 私聊中发送 `帮助`。能收到回复后，再发送 `我的ID` 取得自己的 OpenID。
4. 如需管理全部学号，将该 OpenID 填入 `QQ_BOT_ADMIN_OPENIDS`，重启本地进程后发送 `管理员帮助` 验证。多个管理员 OpenID 用逗号分隔。

常用指令、学号绑定、通知偏好和故障排查见 [QQ 本地调试说明](QQ-LOCAL-DEBUG.md)。QQ 官方接入细节见 [QQ 机器人开发文档](https://bot.q.qq.com/wiki/develop/api-v2/)。
