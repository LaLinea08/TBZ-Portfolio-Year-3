/* =========================================================
   Portfolio – public site logic
   Vanilla JS, no build step. Entries come from data/entries.json
   at runtime; nothing about an entry is hardcoded in HTML.
   ========================================================= */
(function () {
  'use strict';

  var ENTRIES_URL = 'data/entries.json';
  var TAGS_URL = 'data/tags.json';
  var THEME_KEY = 'portfolio-theme';
  var LOCALE = 'en-GB';   // dates follow the page language, not the visitor's browser

  var state = {
    entries: [],      // all entries, newest first
    tagColors: {},    // { tag: colour name }, from data/tags.json
    query: '',        // live search text
    subject: '',      // selected subject ('' = all)
    tag: ''           // selected tag ('' = all)
  };

  var el = {};

  /* ---------------------------------------------------------
     Theme (light / dark)
     --------------------------------------------------------- */

  function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* private mode */ }
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(stored || (prefersDark ? 'dark' : 'light'));
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'light' : 'dark');
  }

  /* ---------------------------------------------------------
     Small helpers
     --------------------------------------------------------- */

  function $(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Date-only ISO strings ("2026-08-19") must not be parsed as UTC, or the
  // displayed day slips by one in western time zones. Build a local Date.
  function parseDate(iso) {
    if (!iso) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDate(iso) {
    var d = parseDate(iso);
    if (!d) return '';
    return d.toLocaleDateString(LOCALE, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function sortKey(entry) {
    var d = parseDate(entry.date);
    return d ? d.getTime() : 0;
  }

  // Wrap search hits in <mark>. Input is escaped first, so this is safe.
  function highlight(text, query) {
    var safe = escapeHtml(text);
    if (!query) return safe;
    var needle = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      return safe.replace(new RegExp('(' + needle + ')', 'gi'), '<mark>$1</mark>');
    } catch (e) {
      return safe;
    }
  }

  function show(node, visible) {
    if (node) node.hidden = !visible;
  }

  // Give an element its tag's colour. Tags without one simply stay neutral,
  // which is also what happens if data/tags.json is missing entirely.
  function paintTag(node, tag) {
    var colour = state.tagColors[tag];
    if (colour) node.setAttribute('data-tag-color', colour);
    return node;
  }

  /* ---------------------------------------------------------
     Motion helpers
     Every effect below is decorative: if the browser lacks the API, or
     the visitor asked for reduced motion, the page still works exactly
     the same — it just arrives without the movement.
     --------------------------------------------------------- */

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  var revealObserver = null;

  // Fade elements up as they scroll into view, staggered by their index.
  function observeReveal(nodes) {
    if (!nodes.length) return;

    if (prefersReducedMotion() || !window.IntersectionObserver) {
      nodes.forEach(function (n) { n.classList.add('is-in'); });
      return;
    }

    if (!revealObserver) {
      revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          revealObserver.unobserve(entry.target); // reveal once, then forget
        });
      }, { rootMargin: '0px 0px -40px 0px', threshold: 0.05 });
    }
    nodes.forEach(function (n) { revealObserver.observe(n); });
  }

  // Feed the pointer position to the card under the cursor, so its
  // highlight follows the mouse. One delegated listener, rAF-throttled.
  function initPointerSheen() {
    if (prefersReducedMotion()) return;
    var pending = null;

    el.grid.addEventListener('pointermove', function (ev) {
      var card = ev.target.closest && ev.target.closest('.card');
      if (!card) return;
      if (pending) return;
      pending = requestAnimationFrame(function () {
        pending = null;
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', ((ev.clientX - r.left) / r.width * 100) + '%');
        card.style.setProperty('--my', ((ev.clientY - r.top) / r.height * 100) + '%');
      });
    }, { passive: true });
  }

  // Condense the header once the page is scrolled.
  function initHeaderScroll() {
    var header = document.querySelector('.site-header');
    var ticking = false;
    function update() {
      ticking = false;
      header.classList.toggle('is-scrolled', window.scrollY > 12);
      updateReadProgress();
    }
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }, { passive: true });
    update();
  }

  // Fill the progress line according to how far down the entry we are.
  function updateReadProgress() {
    var bar = el.readProgress;
    if (!bar || bar.hidden) return;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    bar.firstElementChild.style.setProperty('--p', p);
  }

  // Cross-fade between views where the browser supports it.
  function withTransition(fn) {
    if (document.startViewTransition && !prefersReducedMotion()) {
      document.startViewTransition(fn);
    } else {
      fn();
    }
  }

  // Placeholder cards so the grid has shape while entries load.
  function showSkeletons(count) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < count; i++) {
      var sk = document.createElement('div');
      sk.className = 'skeleton';
      sk.innerHTML = '<div class="skeleton-bar sk-cover"></div>' +
                     '<div class="skeleton-bar sk-line short"></div>' +
                     '<div class="skeleton-bar sk-line"></div>' +
                     '<div class="skeleton-bar sk-line mid"></div>';
      frag.appendChild(sk);
    }
    el.grid.innerHTML = '';
    el.grid.setAttribute('aria-busy', 'true');
    el.grid.appendChild(frag);
  }

  /* ---------------------------------------------------------
     Loading entries
     --------------------------------------------------------- */

  function loadEntries() {
    show(el.stateLoading, false);
    show(el.stateEmpty, false);
    show(el.stateError, false);
    show(el.stateNomatch, false);
    showSkeletons(6);

    // Tag colours are optional: a missing or broken file just means no
    // colours, so it must never block the entries from rendering.
    fetch(TAGS_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : {}; })
      .then(function (map) {
        state.tagColors = (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
      })
      .catch(function () { state.tagColors = {}; })
      .then(function () { buildFilters(); render(); });

    // GitHub Pages caches aggressively — bust it on every load.
    return fetch(ENTRIES_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
        return res.text();
      })
      .then(function (text) {
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw new Error('Invalid JSON in ' + ENTRIES_URL + ': ' + e.message);
        }
        // Accept either a plain array or { entries: [...] }.
        var list = Array.isArray(data) ? data : (data && Array.isArray(data.entries) ? data.entries : null);
        if (!list) throw new Error(ENTRIES_URL + ' must contain an array of entries.');

        state.entries = list.filter(isUsableEntry).sort(function (a, b) {
          return sortKey(b) - sortKey(a); // newest first
        });

        show(el.stateLoading, false);
        buildFilters();
        render();
      })
      .catch(function (err) {
        show(el.stateLoading, false);
        el.grid.innerHTML = '';
        el.grid.removeAttribute('aria-busy');
        el.errorDetail.textContent = err.message;
        show(el.stateError, true);
        el.resultCount.textContent = '';
      });
  }

  // Tolerate half-finished entries rather than blowing up the whole page.
  function isUsableEntry(entry) {
    return entry && typeof entry === 'object' && (entry.title || entry.slug);
  }

  function entryKey(entry) {
    return String(entry.slug || entry.id || '');
  }

  /* ---------------------------------------------------------
     Filters
     --------------------------------------------------------- */

  function buildFilters() {
    // Subject dropdown
    var subjects = [];
    state.entries.forEach(function (e) {
      if (e.subject && subjects.indexOf(e.subject) === -1) subjects.push(e.subject);
    });
    subjects.sort(function (a, b) { return a.localeCompare(b); });

    el.subjectFilter.innerHTML = '<option value="">All subjects</option>';
    subjects.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      el.subjectFilter.appendChild(opt);
    });
    if (subjects.indexOf(state.subject) === -1) state.subject = '';
    el.subjectFilter.value = state.subject;

    // Tag chips
    var tags = [];
    state.entries.forEach(function (e) {
      (e.tags || []).forEach(function (t) {
        if (t && tags.indexOf(t) === -1) tags.push(t);
      });
    });
    tags.sort(function (a, b) { return a.localeCompare(b); });
    if (tags.indexOf(state.tag) === -1) state.tag = '';

    el.tagBar.innerHTML = '';
    tags.forEach(function (t) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag-chip';
      btn.textContent = '#' + t;
      btn.setAttribute('aria-pressed', state.tag === t ? 'true' : 'false');
      paintTag(btn, t);
      btn.addEventListener('click', function () {
        state.tag = (state.tag === t) ? '' : t;   // click again to unset
        buildFilters();
        render();
      });
      el.tagBar.appendChild(btn);
    });
  }

  function matches(entry) {
    if (state.subject && entry.subject !== state.subject) return false;
    if (state.tag && (entry.tags || []).indexOf(state.tag) === -1) return false;
    if (!state.query) return true;

    var haystack = [
      entry.title, entry.summary, entry.body, entry.subject,
      (entry.tags || []).join(' ')
    ].join(' ').toLowerCase();

    // every whitespace-separated word must appear somewhere
    return state.query.toLowerCase().split(/\s+/).filter(Boolean).every(function (word) {
      return haystack.indexOf(word) !== -1;
    });
  }

  function resetFilters() {
    state.query = '';
    state.subject = '';
    state.tag = '';
    el.search.value = '';
    show(el.searchClear, false);
    buildFilters();
    render();
  }

  /* ---------------------------------------------------------
     List rendering
     --------------------------------------------------------- */

  function render() {
    var visible = state.entries.filter(matches);

    el.grid.innerHTML = '';
    show(el.stateEmpty, false);
    show(el.stateNomatch, false);

    if (state.entries.length === 0) {
      el.resultCount.textContent = '';
      show(el.stateEmpty, true);
      return;
    }

    if (visible.length === 0) {
      el.resultCount.textContent = '';
      show(el.stateNomatch, true);
      return;
    }

    el.resultCount.textContent = visible.length === state.entries.length
      ? state.entries.length + (state.entries.length === 1 ? ' entry' : ' entries')
      : visible.length + ' of ' + state.entries.length + ' entries';

    var frag = document.createDocumentFragment();
    var cards = visible.map(function (entry, i) {
      var card = buildCard(entry);
      card.classList.add('reveal');
      card.style.setProperty('--i', Math.min(i, 8)); // cap the stagger so long lists stay snappy
      frag.appendChild(card);
      return card;
    });
    el.grid.removeAttribute('aria-busy');
    el.grid.appendChild(frag);
    observeReveal(cards);
  }

  function buildCard(entry) {
    var card = document.createElement('a');
    card.className = 'card';
    card.href = '#/entry/' + encodeURIComponent(entryKey(entry));

    // Cover: real image, or a generated placeholder with the first letter.
    var cover = document.createElement('div');
    if (entry.coverImage) {
      cover.className = 'card-cover';
      var img = document.createElement('img');
      img.src = entry.coverImage;
      img.alt = '';
      img.loading = 'lazy';
      // If the file is missing, fall back to the placeholder instead of a broken icon.
      img.addEventListener('error', function () {
        cover.className = 'card-cover placeholder';
        cover.innerHTML = '<span>' + escapeHtml((entry.title || '?').charAt(0).toUpperCase()) + '</span>';
      });
      cover.appendChild(img);
    } else {
      cover.className = 'card-cover placeholder';
      cover.innerHTML = '<span>' + escapeHtml((entry.title || '?').charAt(0).toUpperCase()) + '</span>';
    }
    card.appendChild(cover);

    var body = document.createElement('div');
    body.className = 'card-body';

    var meta = document.createElement('div');
    meta.className = 'meta-row';
    var metaHtml = '';
    if (entry.subject) metaHtml += '<span class="subject-badge">' + escapeHtml(entry.subject) + '</span>';
    var dateText = formatDate(entry.date);
    if (dateText) {
      if (metaHtml) metaHtml += '<span class="dot">·</span>';
      metaHtml += '<time datetime="' + escapeHtml(entry.date) + '">' + escapeHtml(dateText) + '</time>';
    }
    meta.innerHTML = metaHtml;
    body.appendChild(meta);

    var title = document.createElement('h2');
    title.className = 'card-title';
    title.innerHTML = highlight(entry.title || '(untitled)', state.query);
    body.appendChild(title);

    if (entry.summary) {
      var summary = document.createElement('p');
      summary.className = 'card-summary';
      summary.innerHTML = highlight(entry.summary, state.query);
      body.appendChild(summary);
    }

    if (entry.tags && entry.tags.length) {
      var tagList = document.createElement('div');
      tagList.className = 'tag-list';
      entry.tags.forEach(function (t) {
        var pill = document.createElement('span');
        pill.className = 'tag-pill';
        pill.textContent = '#' + t;
        tagList.appendChild(paintTag(pill, t));
      });
      body.appendChild(tagList);
    }

    card.appendChild(body);
    return card;
  }

  /* ---------------------------------------------------------
     Detail view
     --------------------------------------------------------- */

  function renderMarkdown(md) {
    var html;
    if (window.marked && typeof window.marked.parse === 'function') {
      html = window.marked.parse(md || '', { breaks: true, gfm: true });
    } else {
      // CDN blocked / offline: show the raw text rather than nothing.
      html = '<pre>' + escapeHtml(md || '') + '</pre>';
    }
    if (window.DOMPurify) {
      html = window.DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
    }
    return html;
  }

  function showDetail(key) {
    var entry = null;
    for (var i = 0; i < state.entries.length; i++) {
      if (entryKey(state.entries[i]) === key) { entry = state.entries[i]; break; }
    }

    show(el.viewList, false);

    if (!entry) {
      show(el.viewDetail, false);
      show(el.stateNotfound, true);
      document.title = 'Not found · Portfolio';
      return;
    }

    show(el.stateNotfound, false);
    show(el.viewDetail, true);
    show(el.readProgress, true);

    document.title = (entry.title || 'Entry') + ' · Portfolio';

    var metaHtml = '';
    if (entry.subject) metaHtml += '<span class="subject-badge">' + escapeHtml(entry.subject) + '</span>';
    var dateText = formatDate(entry.date);
    if (dateText) {
      if (metaHtml) metaHtml += '<span class="dot">·</span>';
      metaHtml += '<time datetime="' + escapeHtml(entry.date) + '">' + escapeHtml(dateText) + '</time>';
    }
    el.detailMeta.innerHTML = metaHtml;

    el.detailTitle.textContent = entry.title || '(untitled)';

    el.detailSummary.textContent = entry.summary || '';
    show(el.detailSummary, !!entry.summary);

    el.detailTags.innerHTML = '';
    (entry.tags || []).forEach(function (t) {
      var pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.textContent = '#' + t;
      el.detailTags.appendChild(paintTag(pill, t));
    });

    if (entry.coverImage) {
      el.detailCoverImg.src = entry.coverImage;
      el.detailCoverImg.alt = entry.title ? 'Cover image: ' + entry.title : '';
      show(el.detailCover, true);
    } else {
      el.detailCoverImg.removeAttribute('src');
      show(el.detailCover, false);
    }

    el.detailBody.innerHTML = renderMarkdown(entry.body);
    updateReadProgress();

    // Gallery = all images except the one already shown as the cover.
    var gallery = (entry.images || []).filter(function (src) { return src && src !== entry.coverImage; });
    el.detailGallery.innerHTML = '';
    if (gallery.length) {
      gallery.forEach(function (src) {
        var link = document.createElement('a');
        link.href = src;
        link.target = '_blank';
        link.rel = 'noopener';
        var img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        link.appendChild(img);
        link.style.setProperty('--i', el.detailGallery.children.length);
        el.detailGallery.appendChild(link);
      });
      show(el.detailGalleryWrap, true);
    } else {
      show(el.detailGalleryWrap, false);
    }

    window.scrollTo(0, 0);
  }

  function showList() {
    show(el.viewDetail, false);
    show(el.stateNotfound, false);
    show(el.readProgress, false);
    show(el.viewList, true);
    document.title = 'Portfolio';
  }

  /* ---------------------------------------------------------
     Hash routing:  #/            -> list
                    #/entry/slug  -> detail
     --------------------------------------------------------- */

  function route() {
    var hash = window.location.hash || '';
    var match = /^#\/entry\/(.+)$/.exec(hash);
    if (match) {
      var key;
      try { key = decodeURIComponent(match[1]); } catch (e) { key = match[1]; }
      showDetail(key);
    } else {
      showList();
    }
  }

  /* ---------------------------------------------------------
     Wiring
     --------------------------------------------------------- */

  function init() {
    el = {
      viewList: $('view-list'),
      viewDetail: $('view-detail'),
      grid: $('grid'),
      search: $('search'),
      searchClear: $('search-clear'),
      subjectFilter: $('subject-filter'),
      tagBar: $('tag-bar'),
      resultCount: $('result-count'),
      stateLoading: $('state-loading'),
      stateEmpty: $('state-empty'),
      stateNomatch: $('state-nomatch'),
      stateError: $('state-error'),
      stateNotfound: $('state-notfound'),
      errorDetail: $('error-detail'),
      detailMeta: $('detail-meta'),
      detailTitle: $('detail-title'),
      detailSummary: $('detail-summary'),
      detailTags: $('detail-tags'),
      detailCover: $('detail-cover'),
      detailCoverImg: $('detail-cover-img'),
      detailBody: $('detail-body'),
      detailGallery: $('detail-gallery'),
      detailGalleryWrap: $('detail-gallery-wrap'),
      readProgress: $('read-progress')
    };

    initTheme();
    $('theme-toggle').addEventListener('click', function () {
      var btn = this;
      toggleTheme();
      // let the icon flip, then reset so the next click animates again
      btn.classList.add('flip');
      setTimeout(function () { btn.classList.remove('flip'); }, 450);
    });
    $('year').textContent = new Date().getFullYear();

    // Make links inside rendered Markdown open in a new tab.
    if (window.DOMPurify) {
      window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
        if (node.tagName === 'A' && node.getAttribute('href')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      });
    }

    // Live search, lightly debounced so typing stays smooth on phones.
    var searchTimer;
    el.search.addEventListener('input', function () {
      show(el.searchClear, el.search.value.length > 0);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.query = el.search.value.trim();
        render();
      }, 120);
    });

    el.searchClear.addEventListener('click', function () {
      el.search.value = '';
      state.query = '';
      show(el.searchClear, false);
      el.search.focus();
      render();
    });

    el.subjectFilter.addEventListener('change', function () {
      state.subject = el.subjectFilter.value;
      render();
    });

    $('reset-filters').addEventListener('click', resetFilters);
    $('retry-load').addEventListener('click', function () {
      loadEntries().then(route);
    });

    // Cross-fade between the list and an entry where the browser allows it.
    window.addEventListener('hashchange', function () { withTransition(route); });

    initPointerSheen();
    initHeaderScroll();

    loadEntries().then(route);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
