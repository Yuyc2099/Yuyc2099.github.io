# 技术手记

一个无需后端的静态技术博客，当前收录《STM32F4 总线架构：Cortex-M4、AHB 与 APB》。

文章位于 `content/posts/<slug>/<slug>.md`，文章专属图片放在同目录的 `images/` 中，并在 Markdown 内使用相对路径引用。

## 本地预览

Windows 可以直接双击项目根目录的 `preview.cmd`。脚本会自动重新构建、启动本地服务，并在浏览器打开：

<http://127.0.0.1:4173/>

也可以在终端运行：

```powershell
.\preview.cmd
```

首次运行时如果依赖尚未安装，脚本会自动执行安装。

预览服务已启动时，再次运行脚本会重新构建并复用现有服务。结束预览可在启动服务的窗口按 `Ctrl+C`。

构建结果位于 `dist/`，可直接部署到任意静态网站托管服务。

## 发布说明

推送到 `main` 分支后，GitHub Actions 会自动构建并发布到：

<https://yuyc2099.github.io/>
