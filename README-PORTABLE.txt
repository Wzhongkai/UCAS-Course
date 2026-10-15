UCAS Course 免安装便携版
=======================

1. 解压整个目录，不要单独移动 runtime、scripts 或 .next 目录中的文件。
   Windows：双击 Start-UCAS-Course.cmd。
   macOS：双击 Start-UCAS-Course.command；如果系统拦截未签名脚本，请在终端中运行
          ./Start-UCAS-Course.sh，并按系统提示确认。仅运行来自可信来源的包。
   Linux：在终端中运行 ./Start-UCAS-Course.sh；桌面环境还需要 xdg-open 才能自动打开浏览器。
2. 启动器会固定让网页和后台任务只监听 127.0.0.1，并在服务就绪后自动打开浏览器。
   如果浏览器未能自动打开，命令窗口会明确显示需要手动打开的本地网址。
3. 首次启动会在当前用户的数据目录创建 secrets.env，加密密钥、自动签到数据与日志不会写回便携包。
   Windows：%LOCALAPPDATA%\UCAS-Course\
   macOS：~/Library/Application Support/UCAS-Course/
   Linux：${XDG_DATA_HOME:-~/.local/share}/UCAS-Course/
   便携包不需要、也不会生成或显示网站访问密钥。
4. 保持启动器的终端窗口运行，自动签到才能持续工作。关闭窗口或按 Ctrl+C 会清理网页和后台进程；
   单独关闭浏览器不会停止后台任务。

安全提示
--------

- 本版本只适合本机使用。不要修改 LOCAL_DESKTOP_MODE、APP_HOST 或 HOSTNAME 来尝试
  对外提供服务；启动器会覆盖这些值，并且桌面模式只在三者均为 127.0.0.1 时生效。
- 不要把 secrets.env、data 目录或其中的文件复制回项目目录、上传到 Git 或发送给他人。
- 如果 secrets.env 已存在但格式异常，启动器会停止并保留原文件，不会覆盖它。
- 便携包内置对应系统和 CPU 架构的官方 Node.js；构建时校验运行时 SHA256。

课程查询和签到仍会访问 UCAS 接口；请遵守学校规定和相关系统的使用约定。
