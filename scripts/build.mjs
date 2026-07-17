import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { marked } from "marked";

const outputDir = new URL("../dist/", import.meta.url);
const articleDir = new URL("./articles/bus-matrix/", outputDir);
const sourceFile = new URL("../总线矩阵.md", import.meta.url);

marked.use({
  gfm: true,
  headerIds: false,
  mangle: false,
});

const escapeHtml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const slugify = (value) => {
  const slug = value
    .toLowerCase()
    .replace(/[：:，,。.!！?？、（）()]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
};

const markdown = await readFile(sourceFile, "utf8");
const headings = [];
const usedIds = new Map();
const renderer = new marked.Renderer();

renderer.heading = ({ tokens, depth }) => {
  const text = renderer.parser.parseInline(tokens);
  const plainText = tokens.map((token) => token.text ?? token.raw ?? "").join("");
  const baseId = slugify(plainText);
  const count = usedIds.get(baseId) ?? 0;
  usedIds.set(baseId, count + 1);
  const id = count ? `${baseId}-${count + 1}` : baseId;
  if (depth >= 2 && depth <= 3) headings.push({ depth, id, text: plainText });
  return `<h${depth} id="${escapeHtml(id)}"><a class="heading-anchor" href="#${escapeHtml(id)}" aria-label="链接到本节">${text}</a></h${depth}>`;
};

const articleHtml = marked.parse(markdown, { renderer });
const tableOfContents = headings
  .map(({ depth, id, text }) => `<a class="toc-link toc-level-${depth}" href="#${escapeHtml(id)}">${escapeHtml(text)}</a>`)
  .join("\n");

const shell = ({ title, description, pathPrefix, pageClass, body }) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#f4f2ed">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="${pathPrefix}assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${pathPrefix}assets/site.css">
  <script>document.documentElement.dataset.theme=localStorage.getItem("theme")||"light";</script>
</head>
<body class="${pageClass}">
${body}
<script src="${pathPrefix}assets/site.js" defer></script>
</body>
</html>`;

const icon = (name) => {
  const paths = {
    sun: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"></path>',
    arrow: '<path d="m15 18-6-6 6-6"></path>',
    clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
};

const header = (prefix = "") => `<header class="site-header">
  <a class="brand" href="${prefix}" aria-label="技术手记首页"><span class="brand-mark">T</span><span>技术手记</span></a>
  <button class="icon-button theme-toggle" type="button" aria-label="切换深浅主题" title="切换深浅主题">${icon("sun")}</button>
</header>`;

const home = shell({
  title: "技术手记",
  description: "记录嵌入式系统、底层原理与工程实践。",
  pathPrefix: "",
  pageClass: "home-page",
  body: `${header()}
  <main>
    <section class="home-intro">
      <p class="eyebrow">EMBEDDED SYSTEMS · NOTES</p>
      <h1>把复杂的底层原理，<br><span>拆开讲清楚。</span></h1>
      <p class="intro-copy">关于嵌入式系统、总线协议与工程实践的个人记录。</p>
    </section>
    <section class="post-list" aria-labelledby="latest-title">
      <div class="section-heading">
        <h2 id="latest-title">最新文章</h2>
        <span>01 篇</span>
      </div>
      <a class="post-card" href="articles/bus-matrix/">
        <div class="post-cover"><img src="assets/bus-matrix-cover.png" alt="总线矩阵与芯片连接的技术插图"></div>
        <div class="post-card-body">
          <div class="post-meta"><span>嵌入式</span><time datetime="2026-06-23">2026.06.23</time></div>
          <h3>M内核总线矩阵：AHB与APB仲裁</h3>
          <p>Cortex-M 多层总线矩阵如何让主设备并发访问不同从设备，以及 AHB 与 APB 之间如何协同。</p>
          <span class="read-link">阅读全文 <span aria-hidden="true">→</span></span>
        </div>
      </a>
    </section>
  </main>
  <footer class="site-footer"><span>技术手记</span><span>专注底层，持续记录。</span></footer>`,
});

const article = shell({
  title: "M内核总线矩阵：AHB与APB仲裁 | 技术手记",
  description: "深入理解 Cortex-M 多层总线矩阵、AHB 与 APB 仲裁及常见工程问题。",
  pathPrefix: "../../",
  pageClass: "article-page",
  body: `<div class="reading-progress" aria-hidden="true"></div>
  ${header("../../")}
  <main class="article-shell">
    <article>
      <a class="back-link" href="../../">${icon("arrow")} 返回文章列表</a>
      <header class="article-header">
        <div class="post-meta"><span>嵌入式</span><time datetime="2026-06-23">2026.06.23</time><span class="reading-time">${icon("clock")} 约 18 分钟</span></div>
        <h1>M内核总线矩阵：AHB与APB仲裁</h1>
        <p>Cortex-M 多层总线矩阵、Flash 竞争、AHB 与 APB 仲裁，以及日常开发中的典型异常。</p>
      </header>
      <figure class="article-cover"><img src="../../assets/bus-matrix-cover.png" alt="总线矩阵与芯片连接的技术插图"></figure>
      <div class="article-layout">
        <div class="article-content">${articleHtml}</div>
        <aside class="toc"><div class="toc-inner"><p>本文目录</p><nav>${tableOfContents}</nav></div></aside>
      </div>
    </article>
  </main>
  <footer class="site-footer"><span>技术手记</span><a href="../../">返回首页</a></footer>`,
});

await rm(outputDir, { recursive: true, force: true });
await mkdir(articleDir, { recursive: true });
await mkdir(new URL("./assets/", outputDir), { recursive: true });
await Promise.all([
  writeFile(new URL("./index.html", outputDir), home),
  writeFile(new URL("./index.html", articleDir), article),
  writeFile(new URL("./404.html", outputDir), home),
  writeFile(new URL("./.nojekyll", outputDir), ""),
  cp(new URL("../src/site.css", import.meta.url), new URL("./assets/site.css", outputDir)),
  cp(new URL("../src/site.js", import.meta.url), new URL("./assets/site.js", outputDir)),
  cp(new URL("../src/favicon.svg", import.meta.url), new URL("./assets/favicon.svg", outputDir)),
  cp(new URL("../assets/bus-matrix-cover.png", import.meta.url), new URL("./assets/bus-matrix-cover.png", outputDir)),
]);

console.log(`Built 2 pages with ${headings.length} table-of-contents entries.`);
