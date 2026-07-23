import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { marked } from "marked";

const outputDir = new URL("../dist/", import.meta.url);
const postsDir = new URL("../content/posts/", import.meta.url);

marked.use({
  gfm: true,
  headerIds: false,
  mangle: false,
});

const escapeHtml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const stripLeadingDocumentTitle = (markdown) => markdown.replace(/^\uFEFF?#\s+.+\r?\n(?:\r?\n)?/, "");

const slugify = (value) => {
  const slug = value
    .toLowerCase()
    .replace(/[：:，,。.!！?？、（）()]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
};

const renderMarkdown = (markdown) => {
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

  return {
    html: marked.parse(markdown, { renderer }),
    tableOfContents: headings
      .map(({ depth, id, text }) => `<a class="toc-link toc-level-${depth}" href="#${escapeHtml(id)}">${escapeHtml(text)}</a>`)
      .join("\n"),
    headingCount: headings.length,
  };
};

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
<nav class="quick-navigation" aria-label="页面快速导航">
  ${pageClass === "article-page" ? `<a class="quick-nav-control article-list-shortcut" href="${pathPrefix}#post-cards" aria-label="返回文章列表" title="返回文章列表">${icon("list")}</a>` : ""}
  <button class="quick-nav-control" type="button" data-scroll-target="top" aria-label="返回页面顶部" title="返回顶部">${icon("up")}</button>
  <button class="quick-nav-control" type="button" data-scroll-target="bottom" aria-label="前往页面底部" title="前往底部">${icon("down")}</button>
</nav>
<script src="${pathPrefix}assets/site.js" defer></script>
</body>
</html>`;

const icon = (name) => {
  const paths = {
    sun: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"></path>',
    arrow: '<path d="m15 18-6-6 6-6"></path>',
    clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"></path><path d="M4 6h.01M4 12h.01M4 18h.01"></path>',
    up: '<path d="m6 15 6-6 6 6"></path><path d="M12 9v10"></path>',
    down: '<path d="m6 9 6 6 6-6"></path><path d="M12 5v10"></path>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
};

const header = (prefix = "") => `<header class="site-header">
  <a class="brand" href="${prefix}" aria-label="嵌入式软件笔记首页"><span class="brand-mark">Yu</span><span>嵌入式软件笔记</span></a>
  <button class="icon-button theme-toggle" type="button" aria-label="切换深浅主题" title="切换深浅主题">${icon("sun")}</button>
</header>`;

const categoryNames = {
  debugging: "调试笔记",
  kernel: "内核与底层",
  software: "软件与工具链",
};

const directoryEntries = await readdir(postsDir, { withFileTypes: true });
const posts = (
  await Promise.all(
    directoryEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const sourceFile = new URL(`./${entry.name}/${entry.name}.md`, postsDir);
        const metadataFile = new URL(`./${entry.name}/post.json`, postsDir);
        const imagesDir = new URL(`./${entry.name}/images/`, postsDir);
        const markdown = await readFile(sourceFile, "utf8");
        const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
        const firstLine = markdown.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
        if (firstLine !== `# ${metadata.title}`) {
          throw new Error(`${entry.name}: Markdown H1 must match post.json title.`);
        }
        return { directoryName: entry.name, metadata, markdown, hasImages: await exists(imagesDir) };
      }),
  )
)
  .filter(({ metadata }) => !metadata.draft)
  .sort((a, b) => b.metadata.date.localeCompare(a.metadata.date));

if (!posts.length) throw new Error("No published articles found.");

const postCards = posts
  .map(({ metadata }) => {
    const categoryName = categoryNames[metadata.category] ?? metadata.category;
    const displayDate = metadata.date.replaceAll("-", ".");
    return `<a class="post-card" href="articles/${metadata.slug}/"
        data-category="${escapeHtml(metadata.category)}">
        <div class="post-card-body">
          <div class="post-meta">
            <span class="post-category">${escapeHtml(categoryName)}</span>
            <time datetime="${metadata.date}">${displayDate}</time>
          </div>
          <h3>${escapeHtml(metadata.title)}</h3>
          <p>${escapeHtml(metadata.summary)}</p>
          <span class="read-link">阅读全文 <span aria-hidden="true">→</span></span>
        </div>
      </a>`;
  })
  .join("\n");

const categoryFilters = [
  `<button class="filter-btn active" data-filter="all" data-type="category">全部</button>`,
  ...Object.entries(categoryNames).map(
    ([key, name]) => `<button class="filter-btn" data-filter="${escapeHtml(key)}" data-type="category">${escapeHtml(name)}</button>`
  ),
].join("\n");

const profile = `<aside class="profile-card">
  <img class="profile-avatar" src="https://github.com/Yuyc2099.png" alt="头像" width="96" height="96">
  <div class="profile-info">
    <p class="profile-motto">知易行难</p>
    <nav class="profile-links" aria-label="联系方式">
      <a href="https://github.com/Yuyc2099" target="_blank" rel="noopener" aria-label="GitHub">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
        GitHub
      </a>
      <a href="mailto:yuyc2099@gmail.com" aria-label="Gmail">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
        yuyc2099@gmail.com
      </a>
      <a href="mailto:yuyc2099@qq.com" aria-label="QQ邮箱">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
        yuyc2099@qq.com
      </a>
    </nav>
  </div>
</aside>`;

const renderAllPostLinks = (prefix = "", currentSlug = "") =>
  posts
    .map(({ metadata }) => {
      const current = metadata.slug === currentSlug ? ' aria-current="page"' : "";
      return `<a href="${prefix}articles/${metadata.slug}/"${current}>${escapeHtml(metadata.title)}</a>`;
    })
    .join("\n");

const allPosts = `<nav class="all-posts-card" aria-label="全部文章">
  <div class="all-posts-heading">
    <h2>全部文章</h2>
    <span>${String(posts.length).padStart(2, "0")}</span>
  </div>
  <div class="all-posts-list">
    ${renderAllPostLinks()}
  </div>
</nav>`;

const home = shell({
  title: "嵌入式软件笔记",
  description: "记录嵌入式系统、底层原理与工程实践。",
  pathPrefix: "",
  pageClass: "home-page",
  body: `${header()}
  <main class="home-layout">
    <div class="home-left">
      <div class="filter-bar">
        <div class="filter-group">${categoryFilters}</div>
      </div>
      <section class="post-list" aria-label="文章列表">
        <div class="section-heading">
          <h2>文章</h2>
          <span id="post-count">${String(posts.length).padStart(2, "0")} 篇</span>
        </div>
        <div class="post-cards" id="post-cards">
          ${postCards}
        </div>
      </section>
    </div>
    <div class="home-right">
      ${profile}
      ${allPosts}
    </div>
  </main>
  <footer class="site-footer"><span>嵌入式软件笔记</span></footer>`,
});

const articlePages = posts.map(({ directoryName, metadata, markdown, hasImages }) => {
  const { html, tableOfContents, headingCount } = renderMarkdown(stripLeadingDocumentTitle(markdown));
  const categoryName = categoryNames[metadata.category] ?? metadata.category;
  const displayDate = metadata.date.replaceAll("-", ".");
  const htmlPage = shell({
    title: `${metadata.title} | 嵌入式软件笔记`,
    description: metadata.summary,
    pathPrefix: "../../",
    pageClass: "article-page",
    body: `<div class="reading-progress" aria-hidden="true"></div>
    ${header("../../")}
    <main class="article-shell">
      <article>
        <a class="back-link" href="../../">${icon("arrow")} 返回文章列表</a>
        <header class="article-header">
          <div class="post-meta"><span>${escapeHtml(categoryName)}</span><time datetime="${metadata.date}">${displayDate}</time><span class="reading-time">${icon("clock")} 约 ${metadata.readingTime} 分钟</span></div>
          <h1>${escapeHtml(metadata.title)}</h1>
          <p>${escapeHtml(metadata.summary)}</p>
        </header>
        <div class="article-layout">
          <div class="article-content">${html}</div>
          <aside class="toc"><div class="toc-inner">
            <p>本文目录</p>
            <nav>${tableOfContents}</nav>
            <div class="toc-all-posts">
              <p>全部文章</p>
              <nav class="all-posts-list" aria-label="全部文章">${renderAllPostLinks("../../", metadata.slug)}</nav>
            </div>
          </div></aside>
        </div>
      </article>
    </main>
    <footer class="site-footer"><span>嵌入式软件笔记</span><a href="../../">返回首页</a></footer>`,
  });
  return { directoryName, metadata, htmlPage, headingCount, hasImages };
});

await rm(outputDir, { recursive: true, force: true });
await mkdir(new URL("./assets/", outputDir), { recursive: true });
await Promise.all(
  articlePages.map(({ metadata }) => mkdir(new URL(`./articles/${metadata.slug}/`, outputDir), { recursive: true })),
);
await Promise.all([
  writeFile(new URL("./index.html", outputDir), home),
  writeFile(new URL("./404.html", outputDir), home),
  writeFile(new URL("./.nojekyll", outputDir), ""),
  cp(new URL("../src/site.css", import.meta.url), new URL("./assets/site.css", outputDir)),
  cp(new URL("../src/site.js", import.meta.url), new URL("./assets/site.js", outputDir)),
  cp(new URL("../src/favicon.svg", import.meta.url), new URL("./assets/favicon.svg", outputDir)),
  ...articlePages.flatMap(({ directoryName, metadata, htmlPage, hasImages }) => {
    const articleDir = new URL(`./articles/${metadata.slug}/`, outputDir);
    return [
      writeFile(new URL("./index.html", articleDir), htmlPage),
      ...(hasImages
        ? [cp(new URL(`./${directoryName}/images/`, postsDir), new URL("./images/", articleDir), { recursive: true })]
        : []),
    ];
  }),
]);

const headingCount = articlePages.reduce((total, article) => total + article.headingCount, 0);
console.log(`Built ${articlePages.length} articles with ${headingCount} table-of-contents entries.`);
