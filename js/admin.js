/* =========================================================================
   Portfolio – admin logic
   -------------------------------------------------------------------------
   This file talks directly to the GitHub REST Contents API from the browser.
   There is no server: every change is a commit made with the Personal Access
   Token that the user pastes on load. The token lives only in localStorage of
   this browser and is never written into the repository.

   Rough flow when saving an entry:
     1. upload each new image to  images/<slug>/<filename>
     2. GET  data/entries.json    -> current content + sha
     3. modify the parsed array
     4. PUT  data/entries.json    with that sha and a commit message

   GitHub rejects a PUT whose sha is stale (someone else committed in the
   meantime) — we catch that and retry once with a freshly fetched sha.
   ========================================================================= */
(function () {
  'use strict';

  /* =======================================================================
     Constants and module state
     ======================================================================= */

  var API = 'https://api.github.com';
  var ENTRIES_PATH = 'data/entries.json';
  var IMAGES_DIR = 'images';

  // localStorage keys. The token key is deliberately obvious — the user should
  // be able to find and delete it manually if they ever want to.
  var LS_TOKEN = 'portfolio-admin-token';
  var LS_REPO = 'portfolio-admin-repo';
  var LS_THEME = 'portfolio-theme';

  var LOCALE = 'en-GB';

  var MAX_IMAGE_BYTES = 5 * 1024 * 1024; // GitHub Contents API is happiest well under 100 MB; 5 MB keeps commits sane.

  var state = {
    token: null,
    user: null,          // { login, avatar_url }
    repo: { owner: '', repo: '', branch: '' },   // filled in by detectRepo()
    entries: [],         // parsed content of data/entries.json
    entriesSha: null,    // sha of that file as last read
    images: [],          // image items currently attached to the open form
    coverId: null,       // id of the image item marked as cover
    editingId: null,     // id of the entry being edited, or null for "new"
    editingSlug: null,   // slug is kept stable while editing so image paths stay valid
    removedPaths: []     // repo paths of images the user removed while editing
  };

  var el = {}; // cached DOM references, filled in init()

  /* =======================================================================
     Tiny DOM / utility helpers
     ======================================================================= */

  function $(id) { return document.getElementById(id); }

  function show(node, visible) { if (node) node.hidden = !visible; }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* private mode */ } }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

  function todayISO() {
    var d = new Date();
    // Build the date from local parts — toISOString() would shift the day in +x time zones.
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function formatDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    return new Date(+m[1], +m[2] - 1, +m[3])
      .toLocaleDateString(LOCALE, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* -----------------------------------------------------------------------
     Slugs
     German umlauts are transliterated first, so "Übung Größe" becomes
     "uebung-groesse" rather than "bung-gre".
     ----------------------------------------------------------------------- */
  function slugify(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip remaining accents
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'entry';
  }

  // Make sure a new entry never reuses an existing slug (image folders would collide).
  function uniqueSlug(base, ignoreId) {
    var taken = state.entries
      .filter(function (e) { return e.id !== ignoreId; })
      .map(function (e) { return e.slug; });
    var slug = base, n = 2;
    while (taken.indexOf(slug) !== -1) { slug = base + '-' + n; n++; }
    return slug;
  }

  // Keep uploaded file names predictable and URL-safe.
  function safeFileName(name) {
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : 'bin';
    return (slugify(stem) || 'image') + '.' + (ext || 'bin');
  }

  /* =======================================================================
     UTF-8 safe base64
     -------------------------------------------------------------------------
     The GitHub Contents API wants file content base64 encoded. Plain
     btoa(string) throws on anything outside Latin-1, so umlauts and emoji in
     an entry would break the commit. We therefore go through TextEncoder to
     get real UTF-8 bytes and base64 those bytes instead of the characters.
     ======================================================================= */

  function bytesToBase64(bytes) {
    var binary = '';
    var CHUNK = 0x8000; // avoid "too many arguments" on large images
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function utf8ToBase64(text) {
    return bytesToBase64(new TextEncoder().encode(text));
  }

  function base64ToUtf8(b64) {
    var binary = atob(String(b64 || '').replace(/\s/g, '')); // GitHub wraps base64 in newlines
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // Read a File (image) straight into base64 without ever treating it as text.
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(bytesToBase64(new Uint8Array(reader.result))); };
      reader.onerror = function () { reject(new Error('Could not read file: ' + file.name)); };
      reader.readAsArrayBuffer(file);
    });
  }

  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Preview failed: ' + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  /* =======================================================================
     Status log (bottom-right toasts)
     Each call returns a small handle so a long-running step can update its own
     message in place: "Uploading image …" -> "Image uploaded".
     ======================================================================= */

  var GLYPH = { ok: '✓', error: '✕', note: 'ℹ', work: '' };

  function logStatus(text, kind) {
    kind = kind || 'work';
    var node = document.createElement('div');
    node.className = 'status-msg is-' + kind;
    el.statusLog.appendChild(node);

    var handle = {
      update: function (newText, newKind) {
        var k = newKind || kind;
        node.className = 'status-msg is-' + k;
        node.innerHTML = (k === 'work'
          ? '<span class="spin" aria-hidden="true"></span>'
          : '<span class="glyph" aria-hidden="true">' + GLYPH[k] + '</span>') +
          '<span>' + escapeHtml(newText) + '</span>';
        kind = k;
        if (k === 'ok' || k === 'note') handle.dismiss(6000);
        return handle;
      },
      dismiss: function (delay) {
        setTimeout(function () {
          if (node.parentNode) node.parentNode.removeChild(node);
        }, delay || 0);
      }
    };

    handle.update(text, kind);
    el.statusLog.scrollTop = el.statusLog.scrollHeight;
    return handle;
  }

  /* =======================================================================
     GitHub API plumbing
     ======================================================================= */

  function ApiError(message, status, body) {
    var err = new Error(message);
    err.status = status;
    err.body = body;
    return err;
  }

  /**
   * Thin wrapper around fetch() for api.github.com.
   * Adds auth + API version headers, parses JSON, turns non-2xx into throws.
   */
  function ghFetch(path, options) {
    options = options || {};
    var headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    if (options.body) headers['Content-Type'] = 'application/json';

    return fetch(API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = { message: text }; } }

        if (!res.ok) {
          var msg = (data && data.message) || res.statusText || ('HTTP ' + res.status);
          if (res.status === 401) msg = 'Token invalid or expired (401).';
          if (res.status === 403 && /rate limit/i.test(msg)) msg = 'GitHub API rate limit reached. Please wait a moment.';
          if (res.status === 403) msg = 'Access denied (403): ' + msg + ' \u2014 does the token have "Contents: Read and write" for this repository?';
          if (res.status === 404) msg = 'Not found (404): ' + path.split('?')[0];
          throw ApiError(msg, res.status, data);
        }
        return data;
      });
    });
  }

  function repoPath(suffix) {
    return '/repos/' + encodeURIComponent(state.repo.owner) +
           '/' + encodeURIComponent(state.repo.repo) + suffix;
  }

  function contentsUrl(filePath) {
    // Each path segment is encoded separately so slashes survive.
    var encoded = String(filePath).split('/').map(encodeURIComponent).join('/');
    return repoPath('/contents/' + encoded);
  }

  /**
   * Read a file from the repository.
   * Resolves with { content: <decoded utf-8 string|null>, sha, raw } and
   * resolves with sha:null when the file does not exist yet (404), because
   * "create it" and "update it" are the same PUT with or without a sha.
   */
  function getFile(filePath, decodeText) {
    var url = contentsUrl(filePath) +
              '?ref=' + encodeURIComponent(state.repo.branch) +
              '&t=' + Date.now(); // defeat any CDN/browser caching
    return ghFetch(url).then(function (data) {
      return {
        sha: data.sha,
        content: decodeText ? base64ToUtf8(data.content || '') : null,
        raw: data
      };
    }).catch(function (err) {
      if (err.status === 404) return { sha: null, content: null, raw: null };
      throw err;
    });
  }

  /**
   * Create or update a file. Pass the sha you read to update, or null to create.
   */
  function putFile(filePath, base64Content, message, sha) {
    var body = {
      message: message,
      content: base64Content,
      branch: state.repo.branch
    };
    if (sha) body.sha = sha;
    return ghFetch(contentsUrl(filePath), { method: 'PUT', body: body });
  }

  function deleteFile(filePath, message, sha) {
    return ghFetch(contentsUrl(filePath), {
      method: 'DELETE',
      body: { message: message, sha: sha, branch: state.repo.branch }
    });
  }

  /* =======================================================================
     entries.json read / write
     ======================================================================= */

  function loadEntriesFile() {
    return getFile(ENTRIES_PATH, true).then(function (file) {
      var list = [];
      if (file.content && file.content.trim()) {
        var parsed = JSON.parse(file.content); // throws on broken JSON — surfaced to the user
        list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.entries) ? parsed.entries : []);
      }
      state.entries = list;
      state.entriesSha = file.sha;
      return { entries: list, sha: file.sha };
    });
  }

  function sortEntries(list) {
    return list.slice().sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
  }

  /**
   * The core write path.
   *
   * `mutate(entriesArray)` receives a *fresh* copy of the entries and returns
   * the array to commit. If GitHub answers 409 (or the 422 it sometimes uses
   * for the same situation) the file changed underneath us — we re-read it and
   * run `mutate` again exactly once against the new content.
   */
  function commitEntries(mutate, message) {
    var attempt = 0;

    function tryOnce() {
      attempt++;
      return loadEntriesFile().then(function (file) {
        var next = sortEntries(mutate(JSON.parse(JSON.stringify(file.entries))));
        var json = JSON.stringify(next, null, 2) + '\n';
        return putFile(ENTRIES_PATH, utf8ToBase64(json), message, file.sha)
          .then(function (res) {
            state.entries = next;
            state.entriesSha = res.content && res.content.sha;
            return next;
          });
      }).catch(function (err) {
        if ((err.status === 409 || err.status === 422) && attempt === 1) {
          logStatus('sha-Konflikt – data/entries.json wird neu gelesen …', 'note');
          return tryOnce(); // one retry, as required
        }
        throw err;
      });
    }

    return tryOnce();
  }

  /* =======================================================================
     Authentication
     ======================================================================= */

  /**
   * Guess owner/repo from the URL when the page is served by GitHub Pages.
   *   lalinea08.github.io/TBZ-Portfolio-Year-3/admin.html -> project site
   *   lalinea08.github.io/admin.html                      -> user site
   * Anywhere else (localhost, file://) the fields stay empty and the user
   * fills them in once; the answer is remembered in localStorage.
   */
  function detectRepo() {
    var saved = lsGet(LS_REPO);
    if (saved) {
      try {
        var obj = JSON.parse(saved);
        if (obj && obj.owner && obj.repo) {
          return { owner: obj.owner, repo: obj.repo, branch: obj.branch || '' };
        }
      } catch (e) { /* fall through to detection */ }
    }

    var host = location.hostname;
    var m = /^([\w-]+)\.github\.io$/i.exec(host);
    if (m) {
      var owner = m[1];
      var segments = location.pathname.split('/').filter(Boolean);
      // Last segment is the html file; anything before it is the project name.
      var project = segments.length > 1 ? segments[0] : null;
      // Branch is left empty on purpose: verifyToken() fills in the repo's default branch.
      return { owner: owner, repo: project || (owner + '.github.io'), branch: '' };
    }
    return { owner: '', repo: '', branch: '' };
  }

  function saveRepo() {
    lsSet(LS_REPO, JSON.stringify(state.repo));
  }

  /** Verify the token by asking GitHub who it belongs to, then check repo access. */
  function verifyToken(token) {
    state.token = token;
    return ghFetch('/user').then(function (user) {
      state.user = user;
      // Also confirm the repository is reachable and pick up its default branch.
      return ghFetch(repoPath('')).then(function (repo) {
        // Only auto-fill when the user left the branch field empty — never override a
        // branch they typed (a Pages site may publish from gh-pages, not the default).
        if (!state.repo.branch) state.repo.branch = repo.default_branch || 'main';
        return user;
      }).catch(function (err) {
        if (err.status === 404) {
          throw ApiError('Repository "' + state.repo.owner + '/' + state.repo.repo +
                         '" not found, or the token has no access to it.', 404, null);
        }
        throw err;
      });
    });
  }

  function login(token) {
    return verifyToken(token).then(function (user) {
      lsSet(LS_TOKEN, token);
      saveRepo();
      showApp(user);
      return loadEntriesFile()
        .then(function () {
          renderEntryList();
          refreshSubjectSuggestions();
        })
        .catch(function (err) {
          // Missing entries.json is normal on a brand new repo.
          if (err.status === 404) return;
          logStatus('Could not read data/entries.json: ' + err.message, 'error');
        });
    });
  }

  function logout() {
    lsDel(LS_TOKEN);
    state.token = null;
    state.user = null;
    state.entries = [];
    state.entriesSha = null;
    el.tokenInput.value = '';
    show(el.appView, false);
    show(el.userBadge, false);
    show(el.logoutBtn, false);
    show(el.loginView, true);
    el.repoLabel.textContent = 'not connected';
    logStatus('Token removed from this browser.', 'ok');
  }

  function showApp(user) {
    show(el.loginView, false);
    show(el.appView, true);
    el.userBadge.innerHTML =
      (user.avatar_url ? '<img src="' + escapeHtml(user.avatar_url) + '" alt="">' : '') +
      '<span>' + escapeHtml(user.login) + '</span>';
    show(el.userBadge, true);
    show(el.logoutBtn, true);
    el.repoLabel.textContent = state.repo.owner + '/' + state.repo.repo + ' · ' + state.repo.branch;
  }

  /* =======================================================================
     Markdown preview
     ======================================================================= */

  function renderMarkdown(md) {
    var html;
    if (window.marked && typeof window.marked.parse === 'function') {
      html = window.marked.parse(md || '', { breaks: true, gfm: true });
    } else {
      html = '<pre>' + escapeHtml(md || '') + '</pre>';
    }
    return window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
  }

  function updatePreview() {
    el.mdPreview.innerHTML = renderMarkdown(el.fBody.value);
  }

  /* =======================================================================
     Image handling in the form
     ======================================================================= */

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    files.forEach(function (file) {
      if (!/^image\//.test(file.type)) {
        logStatus('Skipped (not an image file): ' + file.name, 'note');
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        logStatus('Too large (max. 5 MB): ' + file.name, 'error');
        return;
      }
      fileToDataUrl(file).then(function (dataUrl) {
        var item = {
          id: uid(),
          name: safeFileName(file.name),
          preview: dataUrl,
          file: file,
          path: null,       // filled in after upload
          uploaded: false
        };
        state.images.push(item);
        if (!state.coverId) state.coverId = item.id; // first image becomes the cover
        renderImageList();
      }).catch(function (err) {
        logStatus(err.message, 'error');
      });
    });
  }

  function renderImageList() {
    el.imageList.innerHTML = '';
    state.images.forEach(function (item) {
      var box = document.createElement('div');
      box.className = 'image-item' + (state.coverId === item.id ? ' is-cover' : '');
      box.title = 'Use as cover image';

      var img = document.createElement('img');
      img.src = item.preview;
      img.alt = '';
      box.appendChild(img);

      var name = document.createElement('div');
      name.className = 'img-name';
      name.textContent = item.name;
      box.appendChild(name);

      if (state.coverId === item.id) {
        var flag = document.createElement('span');
        flag.className = 'cover-flag';
        flag.textContent = 'Cover';
        box.appendChild(flag);
      }

      if (!item.uploaded) {
        var pending = document.createElement('div');
        pending.className = 'pending';
        pending.textContent = 'not uploaded yet';
        box.appendChild(pending);
      }

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-img';
      remove.setAttribute('aria-label', 'Remove image');
      remove.innerHTML = '&times;';
      remove.addEventListener('click', function (ev) {
        ev.stopPropagation();
        // Images already in the repo are queued for deletion on the next save.
        if (item.uploaded && item.path) state.removedPaths.push(item.path);
        state.images = state.images.filter(function (i) { return i.id !== item.id; });
        if (state.coverId === item.id) {
          state.coverId = state.images.length ? state.images[0].id : null;
        }
        renderImageList();
      });
      box.appendChild(remove);

      box.addEventListener('click', function () {
        state.coverId = item.id;
        renderImageList();
      });

      el.imageList.appendChild(box);
    });
  }

  /**
   * Upload every not-yet-committed image into images/<slug>/.
   * If a file with that name already exists it is replaced (read sha, PUT again).
   */
  function uploadPendingImages(slug) {
    var pending = state.images.filter(function (i) { return !i.uploaded; });
    if (!pending.length) return Promise.resolve();

    var index = 0;
    function next() {
      if (index >= pending.length) return Promise.resolve();
      var item = pending[index++];
      var target = IMAGES_DIR + '/' + slug + '/' + item.name;
      var status = logStatus('Uploading image (' + index + '/' + pending.length + '): ' + item.name, 'work');

      return fileToBase64(item.file)
        .then(function (b64) {
          return putFile(target, b64, 'Add image: ' + target, null)
            .catch(function (err) {
              // 422 here means "file already exists" — overwrite it with its sha.
              if (err.status !== 422 && err.status !== 409) throw err;
              return getFile(target, false).then(function (existing) {
                return putFile(target, b64, 'Update image: ' + target, existing.sha);
              });
            });
        })
        .then(function () {
          item.path = target;
          item.uploaded = true;
          item.preview = target; // from now on the preview can come from the repo
          status.update('Image uploaded: ' + item.name, 'ok');
          renderImageList();
          return next();
        })
        .catch(function (err) {
          status.update('Upload failed (' + item.name + '): ' + err.message, 'error');
          throw err;
        });
    }

    return next();
  }

  /** Best-effort cleanup: remove image files that are no longer referenced. */
  function deleteImagePaths(paths, reason) {
    var index = 0;
    function next() {
      if (index >= paths.length) return Promise.resolve();
      var path = paths[index++];
      return getFile(path, false)
        .then(function (file) {
          if (!file.sha) return null; // already gone
          return deleteFile(path, 'Remove image: ' + path + ' (' + reason + ')', file.sha);
        })
        .catch(function (err) {
          // Never let cleanup break the main operation — the entry is already saved.
          logStatus('Could not delete image (' + path + '): ' + err.message, 'note');
        })
        .then(next);
    }
    return next();
  }

  /* =======================================================================
     Form <-> entry object
     ======================================================================= */

  function resetForm() {
    el.entryForm.reset();
    el.entryId.value = '';
    el.fDate.value = todayISO();
    state.images = [];
    state.coverId = null;
    state.editingId = null;
    state.editingSlug = null;
    state.removedPaths = [];
    el.editorTitle.textContent = 'New entry';
    show(el.cancelEdit, false);
    el.slugPreview.textContent = '–';
    renderImageList();
    updatePreview();
  }

  function fillForm(entry) {
    state.editingId = entry.id;
    state.editingSlug = entry.slug;   // keep the slug so existing image paths stay correct
    state.removedPaths = [];

    el.entryId.value = entry.id;
    el.fTitle.value = entry.title || '';
    el.fDate.value = (entry.date || '').slice(0, 10);
    el.fSubject.value = entry.subject || '';
    el.fTags.value = (entry.tags || []).join(', ');
    el.fSummary.value = entry.summary || '';
    el.fBody.value = entry.body || '';
    el.slugPreview.textContent = entry.slug || '–';

    state.images = (entry.images || []).map(function (path) {
      return {
        id: uid(),
        name: path.split('/').pop(),
        preview: path,
        file: null,
        path: path,
        uploaded: true
      };
    });
    // Mark the stored cover as cover, otherwise fall back to the first image.
    var cover = state.images.filter(function (i) { return i.path === entry.coverImage; })[0];
    state.coverId = cover ? cover.id : (state.images[0] ? state.images[0].id : null);

    el.editorTitle.textContent = 'Edit entry';
    show(el.cancelEdit, true);
    renderImageList();
    updatePreview();
    switchTab('editor');
    window.scrollTo(0, 0);
  }

  function parseTags(raw) {
    return String(raw || '')
      .split(',')
      .map(function (t) { return t.trim(); })
      .filter(function (t, i, arr) { return t && arr.indexOf(t) === i; }); // trim, drop empties, dedupe
  }

  function refreshSubjectSuggestions() {
    var subjects = [];
    state.entries.forEach(function (e) {
      if (e.subject && subjects.indexOf(e.subject) === -1) subjects.push(e.subject);
    });
    el.subjectList.innerHTML = subjects.map(function (s) {
      return '<option value="' + escapeHtml(s) + '"></option>';
    }).join('');
  }

  /* =======================================================================
     Saving
     ======================================================================= */

  function handleSave(ev) {
    ev.preventDefault();

    var title = el.fTitle.value.trim();
    var date = el.fDate.value;
    if (!title || !date) {
      logStatus('Title and date are required.', 'error');
      return;
    }

    var isEdit = !!state.editingId;
    // On edit the slug never changes; otherwise derive it from the title.
    var slug = isEdit ? state.editingSlug : uniqueSlug(slugify(title), null);
    var nowISO = new Date().toISOString();

    el.saveBtn.disabled = true;
    var overall = logStatus(isEdit ? 'Saving changes \u2026' : 'Creating entry \u2026', 'work');

    // Step 1: get every image into the repo, so the entry can reference real paths.
    uploadPendingImages(slug)
      .then(function () {
        var paths = state.images.map(function (i) { return i.path; }).filter(Boolean);
        var coverItem = state.images.filter(function (i) { return i.id === state.coverId; })[0];
        var coverImage = (coverItem && coverItem.path) || paths[0] || null;

        var draft = {
          id: isEdit ? state.editingId : uid(),
          slug: slug,
          title: title,
          date: date,
          subject: el.fSubject.value.trim(),
          tags: parseTags(el.fTags.value),
          summary: el.fSummary.value.trim(),
          body: el.fBody.value,
          coverImage: coverImage,
          images: paths,
          createdAt: nowISO,      // replaced with the original value below when editing
          updatedAt: nowISO
        };

        overall.update('Committing ' + ENTRIES_PATH + ' \u2026', 'work');

        // Step 2 + 3: read entries.json (sha!), modify the array, PUT it back.
        return commitEntries(function (entries) {
          if (isEdit) {
            var found = false;
            var updated = entries.map(function (e) {
              if (e.id !== draft.id) return e;
              found = true;
              draft.createdAt = e.createdAt || draft.createdAt; // keep the original creation time
              return draft;
            });
            if (!found) updated.push(draft); // entry vanished elsewhere — re-add it
            return updated;
          }
          return entries.concat([draft]);
        }, (isEdit ? 'Update entry: ' : 'Add entry: ') + title);
      })
      .then(function () {
        overall.update(isEdit ? 'Entry updated.' : 'Entry saved.', 'ok');
        logStatus('GitHub Pages needs about a minute to redeploy before the change appears on the site.', 'note');

        // Step 4: clean up images the user removed while editing.
        var toDelete = state.removedPaths.slice();
        state.removedPaths = [];
        return deleteImagePaths(toDelete, 'no longer used');
      })
      .then(function () {
        refreshSubjectSuggestions();
        renderEntryList();
        resetForm();
      })
      .catch(function (err) {
        overall.update('Error: ' + err.message, 'error');
        if (err.status === 401) logout();
      })
      .then(function () {
        el.saveBtn.disabled = false;
      });
  }

  /* =======================================================================
     Existing entries: list, edit, delete
     ======================================================================= */

  function renderEntryList() {
    el.adminList.innerHTML = '';

    if (!state.entries.length) {
      el.adminList.innerHTML =
        '<div class="state"><div class="state-icon">\ud83d\udcec</div><h2>No entries yet</h2>' +
        '<p>Create your first one in the \u201cEntry\u201d tab.</p></div>';
      return;
    }

    sortEntries(state.entries).forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'admin-row';

      if (entry.coverImage) {
        var img = document.createElement('img');
        img.className = 'thumb';
        img.src = entry.coverImage;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
        row.appendChild(img);
      } else {
        var ph = document.createElement('div');
        ph.className = 'thumb-ph';
        ph.textContent = (entry.title || '?').charAt(0).toUpperCase();
        row.appendChild(ph);
      }

      var main = document.createElement('div');
      main.className = 'row-main';
      var t = document.createElement('p');
      t.className = 'row-title';
      t.textContent = entry.title || '(untitled)';
      var meta = document.createElement('p');
      meta.className = 'row-meta';
      meta.textContent = [
        formatDate(entry.date),
        entry.subject,
        (entry.images || []).length ? (entry.images.length + ' image(s)') : null
      ].filter(Boolean).join(' · ');
      main.appendChild(t);
      main.appendChild(meta);
      row.appendChild(main);

      var actions = document.createElement('div');
      actions.className = 'row-actions';

      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-ghost';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { fillForm(entry); });

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', function () { confirmDelete(entry); });

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      row.appendChild(actions);

      el.adminList.appendChild(row);
    });
  }

  function confirmDelete(entry) {
    el.confirmText.textContent =
      '\u201c' + (entry.title || '(untitled)') + '\u201d will be removed from data/entries.json' +
      ((entry.images || []).length ? ', and its images will be deleted.' : '.');
    show(el.confirmBackdrop, true);

    // Rebind the OK button each time so it always targets the current entry.
    el.confirmOk.onclick = function () {
      show(el.confirmBackdrop, false);
      deleteEntry(entry);
    };
  }

  function deleteEntry(entry) {
    var status = logStatus('Deleting entry \u2026', 'work');
    commitEntries(function (entries) {
      return entries.filter(function (e) { return e.id !== entry.id; });
    }, 'Delete entry: ' + (entry.title || entry.slug))
      .then(function () {
        status.update('Entry deleted.', 'ok');
        logStatus('GitHub Pages needs about a minute to redeploy before the change appears on the site.', 'note');
        return deleteImagePaths((entry.images || []).slice(), 'entry deleted');
      })
      .then(function () {
        // If the deleted entry was open in the editor, clear the form.
        if (state.editingId === entry.id) resetForm();
        refreshSubjectSuggestions();
        renderEntryList();
      })
      .catch(function (err) {
        status.update('Delete failed: ' + err.message, 'error');
        if (err.status === 401) logout();
      });
  }

  function reloadEntries() {
    var status = logStatus('Reloading entries \u2026', 'work');
    loadEntriesFile()
      .then(function () {
        status.update(state.entries.length + ' entry/entries loaded.', 'ok');
        refreshSubjectSuggestions();
        renderEntryList();
      })
      .catch(function (err) {
        if (err.status === 404) {
          status.update('data/entries.json does not exist yet \u2014 it will be created on the first save.', 'note');
          state.entries = [];
          renderEntryList();
          return;
        }
        status.update('Loading failed: ' + err.message, 'error');
      });
  }

  /* =======================================================================
     Tabs / theme / wiring
     ======================================================================= */

  function switchTab(which) {
    var isEditor = which === 'editor';
    el.tabEditor.setAttribute('aria-selected', String(isEditor));
    el.tabList.setAttribute('aria-selected', String(!isEditor));
    show(el.paneEditor, isEditor);
    show(el.paneList, !isEditor);
  }

  function initTheme() {
    var stored = lsGet(LS_THEME);
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', stored || (prefersDark ? 'dark' : 'light'));
  }

  function init() {
    el = {
      loginView: $('login-view'),
      appView: $('app-view'),
      loginForm: $('login-form'),
      loginError: $('login-error'),
      tokenInput: $('token-input'),
      ownerInput: $('owner-input'),
      repoInput: $('repo-input'),
      branchInput: $('branch-input'),
      repoLabel: $('repo-label'),
      userBadge: $('user-badge'),
      logoutBtn: $('logout-btn'),

      tabEditor: $('tab-editor'),
      tabList: $('tab-list'),
      paneEditor: $('pane-editor'),
      paneList: $('pane-list'),

      entryForm: $('entry-form'),
      entryId: $('entry-id'),
      editorTitle: $('editor-title'),
      cancelEdit: $('cancel-edit'),
      fTitle: $('f-title'),
      fDate: $('f-date'),
      fSubject: $('f-subject'),
      fTags: $('f-tags'),
      fSummary: $('f-summary'),
      fBody: $('f-body'),
      subjectList: $('subject-list'),
      slugPreview: $('slug-preview'),
      mdPreview: $('md-preview'),
      saveBtn: $('save-btn'),
      resetBtn: $('reset-btn'),

      dropzone: $('dropzone'),
      fileInput: $('file-input'),
      imageList: $('image-list'),

      adminList: $('admin-list'),
      reloadBtn: $('reload-btn'),
      statusLog: $('status-log'),

      confirmBackdrop: $('confirm-backdrop'),
      confirmText: $('confirm-text'),
      confirmOk: $('confirm-ok'),
      confirmCancel: $('confirm-cancel')
    };

    initTheme();
    $('theme-toggle').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      lsSet(LS_THEME, next);
    });

    // --- repository fields -------------------------------------------------
    state.repo = detectRepo();
    el.ownerInput.value = state.repo.owner;
    el.repoInput.value = state.repo.repo;
    el.branchInput.value = state.repo.branch;

    // --- login -------------------------------------------------------------
    el.loginForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      show(el.loginError, false);

      state.repo = {
        owner: el.ownerInput.value.trim(),
        repo: el.repoInput.value.trim(),
        branch: el.branchInput.value.trim()   // empty = use the repo's default branch
      };
      if (!state.repo.owner || !state.repo.repo) {
        el.loginError.textContent = 'Please provide owner and repository (under \u201cRepository settings\u201d).';
        show(el.loginError, true);
        return;
      }

      var token = el.tokenInput.value.trim();
      var btn = el.loginForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Checking token \u2026';

      login(token)
        .catch(function (err) {
          state.token = null;
          el.loginError.textContent = err.message;
          show(el.loginError, true);
        })
        .then(function () {
          btn.disabled = false;
          btn.textContent = 'Verify token & sign in';
        });
    });

    el.logoutBtn.addEventListener('click', logout);

    // --- tabs --------------------------------------------------------------
    el.tabEditor.addEventListener('click', function () { switchTab('editor'); });
    el.tabList.addEventListener('click', function () { switchTab('list'); });

    // --- editor ------------------------------------------------------------
    el.fBody.addEventListener('input', updatePreview);
    el.fTitle.addEventListener('input', function () {
      // While editing an existing entry the slug is frozen.
      el.slugPreview.textContent = state.editingSlug || slugify(el.fTitle.value) || '–';
    });
    el.entryForm.addEventListener('submit', handleSave);
    el.resetBtn.addEventListener('click', resetForm);
    el.cancelEdit.addEventListener('click', resetForm);
    el.reloadBtn.addEventListener('click', reloadEntries);

    // --- drag & drop -------------------------------------------------------
    el.dropzone.addEventListener('click', function () { el.fileInput.click(); });
    el.dropzone.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); el.fileInput.click(); }
    });
    el.fileInput.addEventListener('change', function () {
      addFiles(el.fileInput.files);
      el.fileInput.value = ''; // allow re-selecting the same file
    });
    ['dragenter', 'dragover'].forEach(function (type) {
      el.dropzone.addEventListener(type, function (ev) {
        ev.preventDefault();
        el.dropzone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      el.dropzone.addEventListener(type, function (ev) {
        ev.preventDefault();
        el.dropzone.classList.remove('dragover');
      });
    });
    el.dropzone.addEventListener('drop', function (ev) {
      if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
    });
    // Dropping anywhere else must not make the browser navigate to the file.
    window.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    window.addEventListener('drop', function (ev) { ev.preventDefault(); });

    // --- confirm dialog ----------------------------------------------------
    el.confirmCancel.addEventListener('click', function () { show(el.confirmBackdrop, false); });
    el.confirmBackdrop.addEventListener('click', function (ev) {
      if (ev.target === el.confirmBackdrop) show(el.confirmBackdrop, false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') show(el.confirmBackdrop, false);
    });

    // --- warn before losing unsaved work -----------------------------------
    window.addEventListener('beforeunload', function (ev) {
      var dirty = el.fTitle && (el.fTitle.value.trim() || el.fBody.value.trim() || state.images.length);
      if (state.token && dirty) { ev.preventDefault(); ev.returnValue = ''; }
    });

    resetForm();

    // --- auto login with a previously stored token --------------------------
    var savedToken = lsGet(LS_TOKEN);
    if (savedToken && state.repo.owner && state.repo.repo) {
      var status = logStatus('Checking saved token \u2026', 'work');
      login(savedToken)
        .then(function () { status.update('Signed in as ' + state.user.login, 'ok'); })
        .catch(function (err) {
          status.update('Saved token is no longer valid: ' + err.message, 'error');
          lsDel(LS_TOKEN);
          state.token = null;
          show(el.loginView, true);
        });
    } else {
      show(el.loginView, true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
