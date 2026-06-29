/* thecrux — client interactions: theme, command palette, keyboard nav */
(function () {
  "use strict";

  var root = document.documentElement;

  /* ---------------- Theme ---------------- */
  function setTheme(theme) {
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem("crux-theme", theme); } catch (e) {}
  }
  function toggleTheme() {
    setTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
  }

  /* ---------------- Helpers ---------------- */
  function isTyping(el) {
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }
  function fuzzy(hay, needle) {
    hay = hay.toLowerCase();
    needle = needle.toLowerCase();
    if (!needle) return true;
    var i = 0;
    for (var j = 0; j < hay.length && i < needle.length; j++) {
      if (hay[j] === needle[i]) i++;
    }
    return i === needle.length;
  }

  /* ---------------- Command palette ---------------- */
  var palette = document.getElementById("palette");
  var palInput = document.getElementById("palette-input");
  var palResults = document.getElementById("palette-results");
  var palItems = [];
  var palIndex = 0;
  var repoCache = null;

  var STATIC_ACTIONS = [
    { kind: "go", label: "Home — all repositories", href: "/" },
    { kind: "new", label: "New repository", href: "/new" },
    { kind: "cmd", label: "Toggle theme", run: toggleTheme },
  ];

  function fetchRepos() {
    if (repoCache) return Promise.resolve(repoCache);
    return fetch("/api/repos.json")
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) { repoCache = list || []; return repoCache; })
      .catch(function () { repoCache = []; return repoCache; });
  }

  function buildEntries(repos) {
    var entries = STATIC_ACTIONS.slice();
    repos.forEach(function (r) {
      var base = "/" + encodeURIComponent(r.owner) + "/" + encodeURIComponent(r.name);
      entries.push({
        kind: "repo",
        label: r.slug || r.owner + "/" + r.name,
        desc: r.description || "",
        href: base,
      });
    });
    return entries;
  }

  function renderPalette(entries, query) {
    var matched = entries.filter(function (e) {
      return fuzzy(e.label + " " + (e.desc || ""), query);
    });
    palResults.innerHTML = "";
    palItems = [];
    if (matched.length === 0) {
      var empty = document.createElement("li");
      empty.className = "palette-empty";
      empty.textContent = "no matches";
      palResults.appendChild(empty);
      return;
    }
    matched.forEach(function (e, i) {
      var li = document.createElement("li");
      li.className = "palette-item" + (i === 0 ? " is-active" : "");
      li.innerHTML =
        '<span class="pi-kind">' + e.kind + "</span>" +
        '<span class="pi-label"></span>' +
        '<span class="pi-desc"></span>';
      li.querySelector(".pi-label").textContent = e.label;
      li.querySelector(".pi-desc").textContent = e.desc || "";
      li.addEventListener("click", function () { exec(e); });
      li.addEventListener("mousemove", function () { setActive(i); });
      palResults.appendChild(li);
      palItems.push({ el: li, entry: e });
    });
    palIndex = 0;
  }

  function setActive(i) {
    if (!palItems.length) return;
    palIndex = (i + palItems.length) % palItems.length;
    palItems.forEach(function (it, idx) {
      it.el.classList.toggle("is-active", idx === palIndex);
    });
    palItems[palIndex].el.scrollIntoView({ block: "nearest" });
  }

  function exec(entry) {
    closePalette();
    if (entry.run) entry.run();
    else if (entry.href) window.location.href = entry.href;
  }

  var paletteEntries = [];
  function openPalette() {
    palette.hidden = false;
    palInput.value = "";
    palInput.focus();
    fetchRepos().then(function (repos) {
      paletteEntries = buildEntries(repos);
      renderPalette(paletteEntries, "");
    });
  }
  function closePalette() {
    palette.hidden = true;
  }
  function paletteOpen() { return !palette.hidden; }

  if (palInput) {
    palInput.addEventListener("input", function () {
      renderPalette(paletteEntries, palInput.value);
    });
  }
  if (palette) {
    palette.addEventListener("mousedown", function (e) {
      if (e.target === palette) closePalette();
    });
  }

  /* ---------------- Repo list keyboard nav (j/k) ---------------- */
  var navItems = Array.prototype.slice.call(document.querySelectorAll("[data-nav-item]"));
  var navIndex = -1;

  function visibleNav() {
    return navItems.filter(function (el) { return el.style.display !== "none"; });
  }
  function moveNav(delta) {
    var vis = visibleNav();
    if (!vis.length) return;
    navItems.forEach(function (el) { el.classList.remove("is-active"); });
    var curr = vis.indexOf(navItems[navIndex]);
    var next = curr === -1 ? 0 : (curr + delta + vis.length) % vis.length;
    var el = vis[next];
    navIndex = navItems.indexOf(el);
    el.classList.add("is-active");
    el.scrollIntoView({ block: "nearest" });
  }
  function openNav() {
    if (navIndex >= 0 && navItems[navIndex]) {
      var a = navItems[navIndex].querySelector("a");
      if (a) window.location.href = a.getAttribute("href");
    }
  }

  /* ---------------- Repo filter ---------------- */
  var filterInput = document.getElementById("repo-filter");
  var noResults = document.getElementById("repo-noresults");
  if (filterInput) {
    filterInput.addEventListener("input", function () {
      var q = filterInput.value.trim().toLowerCase();
      var anyShown = false;
      navItems.forEach(function (el) {
        var hay = el.getAttribute("data-name") || "";
        var show = !q || hay.indexOf(q) !== -1 || fuzzy(hay, q);
        el.style.display = show ? "" : "none";
        if (show) anyShown = true;
        el.classList.remove("is-active");
      });
      navIndex = -1;
      if (noResults) noResults.hidden = anyShown;
    });
  }

  /* ---------------- Copy buttons ---------------- */
  document.querySelectorAll("[data-copy]").forEach(function (row) {
    var btn = row.querySelector(".copy-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var text = row.getAttribute("data-copy");
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = "copied";
        btn.classList.add("copied");
        setTimeout(function () {
          btn.textContent = "copy";
          btn.classList.remove("copied");
        }, 1400);
      });
    });
  });

  /* ---------------- Blob rendered/source toggle ---------------- */
  (function () {
    var tabs = document.querySelectorAll("[data-blob-view]");
    if (!tabs.length) return;
    var rendered = document.getElementById("blob-rendered");
    var source = document.getElementById("blob-source");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var view = tab.getAttribute("data-blob-view");
        tabs.forEach(function (t) { t.classList.toggle("is-active", t === tab); });
        if (rendered) rendered.classList.toggle("is-hidden", view !== "rendered");
        if (source) source.classList.toggle("is-hidden", view !== "source");
      });
    });
  })();

  /* ---------------- User menu dropdown ---------------- */
  (function () {
    var root = document.querySelector("[data-usermenu]");
    if (!root) return;
    var toggle = root.querySelector("[data-usermenu-toggle]");
    var pop = root.querySelector("[data-usermenu-pop]");
    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
    });
    document.addEventListener("click", function (e) {
      if (!pop.hidden && !root.contains(e.target)) pop.hidden = true;
    });
    document.addEventListener("keydown", function (e) {
      if (!pop.hidden && e.key === "Escape") pop.hidden = true;
    });
  })();

  /* ---------------- Ref switcher dropdown ---------------- */
  (function () {
    var root = document.querySelector("[data-refswitch]");
    if (!root) return;
    var toggle = root.querySelector("[data-refswitch-toggle]");
    var menu = root.querySelector("[data-refswitch-menu]");
    var filter = root.querySelector("[data-refswitch-filter]");
    var empty = root.querySelector("[data-refswitch-empty]");
    var items = Array.prototype.slice.call(root.querySelectorAll("[data-refswitch-item]"));

    function open() {
      menu.hidden = false;
      if (filter) { filter.value = ""; applyFilter(); filter.focus(); }
    }
    function close() { menu.hidden = true; }
    function isOpen() { return !menu.hidden; }

    function applyFilter() {
      var q = (filter ? filter.value : "").trim().toLowerCase();
      var groups = {};
      var any = false;
      items.forEach(function (li) {
        var hay = li.getAttribute("data-refswitch-item") || "";
        var show = !q || hay.indexOf(q) !== -1 || fuzzy(hay, q);
        li.style.display = show ? "" : "none";
        if (show) any = true;
      });
      // Hide group headers whose lists are now empty.
      root.querySelectorAll(".refswitch-list").forEach(function (ul) {
        var visible = Array.prototype.some.call(ul.children, function (c) { return c.style.display !== "none"; });
        var header = ul.previousElementSibling;
        if (header && header.classList.contains("refswitch-group")) header.style.display = visible ? "" : "none";
      });
      if (empty) empty.hidden = any;
    }

    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      isOpen() ? close() : open();
    });
    if (filter) filter.addEventListener("input", applyFilter);
    document.addEventListener("click", function (e) {
      if (isOpen() && !root.contains(e.target)) close();
    });
    document.addEventListener("keydown", function (e) {
      if (isOpen() && e.key === "Escape") { close(); toggle.focus(); }
    });
  })();

  /* ---------------- Toolbar buttons ---------------- */
  document.querySelectorAll('[data-action="theme"]').forEach(function (b) {
    b.addEventListener("click", toggleTheme);
  });
  document.querySelectorAll('[data-action="palette"]').forEach(function (b) {
    b.addEventListener("click", openPalette);
  });

  /* ---------------- Global keyboard ---------------- */
  document.addEventListener("keydown", function (e) {
    // Command palette open/close (works anywhere)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      paletteOpen() ? closePalette() : openPalette();
      return;
    }

    if (paletteOpen()) {
      if (e.key === "Escape") { closePalette(); return; }
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "n")) { e.preventDefault(); setActive(palIndex + 1); return; }
      if (e.key === "ArrowUp" || (e.ctrlKey && e.key.toLowerCase() === "p")) { e.preventDefault(); setActive(palIndex - 1); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        if (palItems[palIndex]) exec(palItems[palIndex].entry);
        return;
      }
      return;
    }

    if (isTyping(document.activeElement)) {
      if (e.key === "Escape") document.activeElement.blur();
      return;
    }

    switch (e.key) {
      case "t": toggleTheme(); break;
      case "n": window.location.href = "/new"; break;
      case "/":
        if (filterInput) { e.preventDefault(); filterInput.focus(); }
        break;
      case "j": e.preventDefault(); moveNav(1); break;
      case "k": e.preventDefault(); moveNav(-1); break;
      case "g": window.location.href = "/"; break;
      case "Enter": openNav(); break;
    }
  });
})();
