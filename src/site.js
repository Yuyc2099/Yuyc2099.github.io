// Relative timestamps
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const relativeTimeFormatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

document.querySelectorAll("[data-relative-time]").forEach((element) => {
  const [year, month, day] = element.dataset.relativeTime.split("-").map(Number);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const target = Date.UTC(year, month - 1, day);
  const days = Math.round((target - today) / millisecondsPerDay);
  const unit = Math.abs(days) < 30 ? "day" : Math.abs(days) < 365 ? "month" : "year";
  const divisor = unit === "day" ? 1 : unit === "month" ? 30 : 365;
  element.textContent = relativeTimeFormatter.format(Math.round(days / divisor), unit);
});

// Category filter
const filterBtns = [...document.querySelectorAll(".filter-btn")];
const postCards = [...document.querySelectorAll("#post-cards .post-card")];
const postCount = document.getElementById("post-count");
const postSortButtons = [...document.querySelectorAll("[data-post-sort]")];
const postSortLists = [...document.querySelectorAll("#post-cards, .all-posts-list")];
const savedPostSort = localStorage.getItem("postSort") === "updated" ? "updated" : "date";

const applyPostSort = (sort) => {
  postSortLists.forEach((list) => {
    [...list.children]
      .sort((a, b) => b.dataset[sort].localeCompare(a.dataset[sort]))
      .forEach((item) => list.append(item));
  });
  postSortButtons.forEach((button) => {
    const active = button.dataset.postSort === sort;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
};

applyPostSort(savedPostSort);
postSortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    localStorage.setItem("postSort", button.dataset.postSort);
    applyPostSort(button.dataset.postSort);
  });
});

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

// Post title search
document.querySelectorAll("[data-post-search]").forEach((input) => {
  const scope = input.closest("[data-post-search-scope]");
  const links = [...scope.querySelectorAll(".all-posts-list a")];
  const count = scope.closest(".all-posts-card")?.querySelector("[data-post-search-count]");
  const empty = scope.querySelector("[data-post-search-empty]");

  input.addEventListener("input", () => {
    const query = input.value.trim().toLocaleLowerCase("zh-CN");
    let visible = 0;

    links.forEach((link) => {
      const show = link.textContent.toLocaleLowerCase("zh-CN").includes(query);
      link.hidden = !show;
      if (show) visible++;
    });

    if (count) count.textContent = String(visible).padStart(2, "0");
    empty.hidden = visible > 0;
  });
});

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
  .map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))))
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
