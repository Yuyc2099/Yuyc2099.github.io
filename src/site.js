// Category filter
const filterBtns = [...document.querySelectorAll(".filter-btn")];
const postCards = [...document.querySelectorAll("#post-cards .post-card")];
const postCount = document.getElementById("post-count");

if (filterBtns.length) {
  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      filterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const { filter } = btn.dataset;
      let visible = 0;
      postCards.forEach((card) => {
        const show = filter === "all" || card.dataset.category === filter;
        card.style.display = show ? "" : "none";
        if (show) visible++;
      });
      if (postCount) postCount.textContent = String(visible).padStart(2, "0") + " 篇";
    });
  });
}

const themeToggle = document.querySelector(".theme-toggle");

themeToggle?.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem("theme", nextTheme);
});

const progress = document.querySelector(".reading-progress");

if (progress) {
  const updateProgress = () => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const value = scrollable > 0 ? window.scrollY / scrollable : 0;
    progress.style.transform = `scaleX(${Math.min(1, Math.max(0, value))})`;
  };
  updateProgress();
  window.addEventListener("scroll", updateProgress, { passive: true });
}

const tocLinks = [...document.querySelectorAll(".toc-link")];
const sections = tocLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

if (sections.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.find((entry) => entry.isIntersecting);
      if (!visible) return;
      tocLinks.forEach((link) => link.classList.toggle("active", link.hash === `#${visible.target.id}`));
    },
    { rootMargin: "-15% 0px -75%", threshold: 0 },
  );
  sections.forEach((section) => observer.observe(section));
}

const quickNavigation = document.querySelector(".quick-navigation");
const scrollButtons = [...document.querySelectorAll("[data-scroll-target]")];

if (quickNavigation && scrollButtons.length) {
  const articleListShortcut = quickNavigation.querySelector(".article-list-shortcut");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const updateQuickNavigation = () => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const canScroll = scrollable > 4;
    const atTop = window.scrollY <= 4;
    const atBottom = window.scrollY >= scrollable - 4;

    quickNavigation.hidden = !canScroll && !articleListShortcut;
    scrollButtons.forEach((button) => {
      button.hidden = !canScroll;
      button.disabled = button.dataset.scrollTarget === "top" ? atTop : atBottom;
    });
  };

  scrollButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const top = button.dataset.scrollTarget === "top" ? 0 : document.documentElement.scrollHeight;
      window.scrollTo({ top, behavior: reducedMotion.matches ? "auto" : "smooth" });
    });
  });

  updateQuickNavigation();
  window.addEventListener("scroll", updateQuickNavigation, { passive: true });
  window.addEventListener("resize", updateQuickNavigation);
}
