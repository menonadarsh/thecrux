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
      entries.push({
        kind: "repo",
        label: r.name,
        desc: r.description || "",
        href: "/" + encodeURIComponent(r.name),
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
