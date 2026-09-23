UCAS Course Windows x64 便携版
==============================

1. 解压整个目录后，双击“Start-UCAS-Course.cmd”。不要单独移动 runtime、scripts
   或 .next 目录中的文件。
2. 启动器会固定让网页和后台任务只监听 127.0.0.1，并在服务就绪后自动打开浏览器。
   如果浏览器未能自动打开，命令窗口会明确显示需要手动打开的本地网址。
3. 第一次启动会在 %LOCALAPPDATA%\UCAS-Course\secrets.env 生成一个本地加密密钥；
   自动签到数据、状态和日志保存在 %LOCALAPPDATA%\UCAS-Course\data\。便携包不需要、
   也不会生成或显示网站访问密钥。
4. 关闭命令窗口或按 Ctrl+C 会清理网页进程和后台进程。浏览器窗口本身不会保持后台任务。

安全提示
--------

- 本版本只适合本机使用。不要修改 LOCAL_DESKTOP_MODE、APP_HOST 或 HOSTNAME 来尝试
  对外提供服务；启动器会覆盖这些值，并且桌面模式只在三者均为 127.0.0.1 时生效。
- 不要把 secrets.env、data 目录或其中的文件复制回项目目录、上传到 Git 或发送给他人。
- 如果 secrets.env 已存在但格式异常，启动器会停止并保留原文件，不会覆盖它。
- 便携包内置的 Node.js 是官方 Windows x64 运行时；构建时按 Node.js 发布页的 SHA256
  校验了压缩包，校验信息见 portable-manifest.json。

课程查询和签到仍会访问 UCAS 接口；请遵守学校规定和相关系统的使用约定。
