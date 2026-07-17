# 技术手记

一个无需后端的静态技术博客，当前收录《M内核总线矩阵：AHB与APB仲裁》。

## 本地运行

```bash
npm install
npm run build
npm run serve
```

构建结果位于 `dist/`，可直接部署到任意静态网站托管服务。

## 发布说明

推送到 `main` 分支后，GitHub Actions 会自动构建并发布到：

<https://yuyc2099.github.io/>
