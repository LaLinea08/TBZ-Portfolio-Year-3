/* =========================================================================
   Portfolio – admin logic
   -------------------------------------------------------------------------
   This file talks directly to the GitHub REST API from the browser. There is
   no server: every change is a commit made with the Personal Access Token the
   user pastes on load. The token lives only in localStorage and is never
   written into the repository.

   Saving an entry produces ONE commit containing everything — all images plus
   data/entries.json — built with the Git Data API:

     1. create a blob per image            POST /git/blobs
     2. read the branch head + entries.json     (so we modify current content)
     3. create a tree on top of the head   POST /git/trees
     4. create a commit                    POST /git/commits
     5. move the branch to it              PATCH /git/refs/heads/<branch>

   Step 5 is a non-forced update, so if someone else committed meanwhile GitHub
   rejects it and we retry once against the new head. One commit per save also
   means one GitHub Pages deployment per save instead of one per file.
   ========================================================================= */
(function () {
  'use strict';

  /* =======================================================================
     Constants and module state
     ======================================================================= */

  var API = 'https://api.github.com';
  var ENTRIES_PATH = 'data/entries.json';
  var TAGS_PATH = 'data/tags.json';
  var TAG_COLOURS = ['red','orange','amber','green','teal','blue','indigo','purple','pink'];
  var IMAGES_DIR = 'images';

  // localStorage keys. The token key is deliberately obvious — the user should
  // be able to find and delete it manually if they ever want to.
  var LS_TOKEN = 'portfolio-admin-token';
  var LS_REPO = 'portfolio-admin-repo';
  var LS_THEME = 'portfolio-theme';

  var LOCALE = 'en-GB';

  // Image pipeline. Photos straight from a phone are far larger than a web page
  // needs, so they are resized and re-encoded in the browser before upload.
  var IMG_MAX_DIM = 1600;              // longest edge, in pixels
  var IMG_QUALITY = 0.82;              // JPEG quality
  var IMG_RECOMPRESS_ABOVE = 400 * 1024;
  var IMG_HARD_LIMIT = 8 * 1024 * 1024; // refuse anything still this big afterwards
  var KEEP_AS_IS = ['image/svg+xml', 'image/gif']; // vector / animation: never touch

  var DEPLOY_POLL_MS = 5000;
  var DEPLOY_TIMEOUT_MS = 4 * 60 * 1000;

  var state = {
    token: null,
    user: null,          // { login, avatar_url }
    repo: { owner: '', repo: '', branch: '' },
    pagesUrl: null,      // public site URL, when the token may read Pages settings
    entries: [],         // parsed content of data/entries.json
    tagColors: {},       // { tag: colour } from data/tags.json
    tagsDirty: false,    // unsaved colour changes
    images: [],          // image items attached to the entry being edited
    coverId: null,       // id of the image item marked as cover
    editingId: null,     // id of the entry being edited, or null for "new"
    editingSlug: null,   // slug stays frozen while editing so image paths stay valid
    removedPaths: [],    // repo paths of images removed while editing
    deployPoll: null     // handle of the running "is it live yet" poll
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
    // Built from local parts — toISOString() would shift the day in +x time zones.
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

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
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

  // A new entry must never reuse an existing slug (image folders would collide).
  function uniqueSlug(base, ignoreId) {
    var taken = state.entries
      .filter(function (e) { return e.id !== ignoreId; })
      .map(function (e) { return e.slug; });
    var slug = base, n = 2;
    while (taken.indexOf(slug) !== -1) { slug = base + '-' + n; n++; }
    return slug;
  }

  // The slug the currently open form will publish under.
  function currentSlug() {
    return state.editingSlug || slugify(el.fTitle.value);
  }

  // Keep uploaded file names predictable and URL-safe.
  function safeFileName(name, forcedExt) {
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var ext = forcedExt ||
      (dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : 'bin');
    return (slugify(stem) || 'image') + '.' + (ext || 'bin');
  }

  // Two files whose sanitised names collide would silently overwrite each
  // other, so later ones get -2, -3, … appended.
  function uniqueFileName(name) {
    var taken = state.images.map(function (i) { return i.name; });
    if (taken.indexOf(name) === -1) return name;
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    var n = 2;
    while (taken.indexOf(stem + '-' + n + ext) !== -1) n++;
    return stem + '-' + n + ext;
  }

  /* =======================================================================
     UTF-8 safe base64
     -------------------------------------------------------------------------
     The GitHub API wants blob content base64 encoded. Plain btoa(string) throws
     on anything outside Latin-1, so umlauts and emoji in an entry would break
     the commit. We go through TextEncoder to get real UTF-8 bytes and base64
     those bytes instead of the characters.
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

  function blobToBytes(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(new Error('Could not read file')); };
      reader.readAsArrayBuffer(blob);
    });
  }

  /* =======================================================================
     Status log (bottom-right toasts)
     Each call returns a handle so a long step can update its own message in
     place: "Uploading image …" -> "Image uploaded".
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
        if (k === 'ok' || k === 'note') handle.dismiss(7000);
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

  /** Thin wrapper around fetch() for api.github.com. */
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
          else if (res.status === 403 && /rate limit/i.test(msg)) msg = 'GitHub API rate limit reached. Please wait a moment.';
          else if (res.status === 403) msg = 'Access denied (403): ' + msg;
          else if (res.status === 404) msg = 'Not found (404): ' + path.split('?')[0];
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

  // Encode each path segment separately so slashes survive.
  function encPath(p) {
    return String(p).split('/').map(encodeURIComponent).join('/');
  }

  /**
   * Read a file from the repository via the Contents API.
   * Resolves with sha:null when the file does not exist yet, because "create"
   * and "update" are otherwise the same operation.
   */
  function getFile(filePath, decodeText) {
    var url = repoPath('/contents/' + encPath(filePath)) +
              '?ref=' + encodeURIComponent(state.repo.branch) +
              '&t=' + Date.now(); // defeat any CDN/browser caching
    return ghFetch(url).then(function (data) {
      return {
        sha: data.sha,
        content: decodeText ? base64ToUtf8(data.content || '') : null
      };
    }).catch(function (err) {
      if (err.status === 404) return { sha: null, content: null };
      throw err;
    });
  }

  /* =======================================================================
     Git Data API — one atomic commit per save
     ======================================================================= */

  function refPath(prefix) {
    return repoPath(prefix + encPath(state.repo.branch));
  }

  function getHead() {
    return ghFetch(refPath('/git/ref/heads/')).then(function (ref) {
      return ghFetch(repoPath('/git/commits/' + ref.object.sha)).then(function (commit) {
        return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
      });
    });
  }

  function createBlob(base64) {
    return ghFetch(repoPath('/git/blobs'), {
      method: 'POST',
      body: { content: base64, encoding: 'base64' }
    }).then(function (b) { return b.sha; });
  }

  /**
   * Commit a set of changes as a single commit.
   *
   *   blobs   [{ path, sha }]   files whose content is already uploaded
   *   build(entries) -> array   receives the CURRENT entries, returns the new ones
   *   deletes [path]            files to remove
   *
   * The blobs are created once by the caller; only the tree/commit/ref part is
   * retried, so a conflict never re-uploads the images.
   */
  function commitAll(blobs, build, deletes, message, texts) {
    var attempt = 0;

    function tryOnce() {
      attempt++;
      // Only read entries.json when we are actually rewriting it.
      var reads = [getHead(), build ? loadEntriesFile() : Promise.resolve(null)];
      return Promise.all(reads).then(function (results) {
        var head = results[0];

        var tree = blobs.map(function (b) {
          return { path: b.path, mode: '100644', type: 'blob', sha: b.sha };
        });

        var nextEntries = null;
        if (build) {
          nextEntries = sortEntries(build(JSON.parse(JSON.stringify(results[1].entries))));
          // entries.json goes in as text — the API creates the blob for us.
          tree.push({ path: ENTRIES_PATH, mode: '100644', type: 'blob',
                      content: JSON.stringify(nextEntries, null, 2) + '\n' });
        }
        // any other plain-text file riding along in the same commit
        (texts || []).forEach(function (f) {
          tree.push({ path: f.path, mode: '100644', type: 'blob', content: f.content });
        });
        // A null sha on an existing path deletes it from the new tree.
        (deletes || []).forEach(function (p) {
          tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
        });

        return ghFetch(repoPath('/git/trees'), {
          method: 'POST',
          body: { base_tree: head.treeSha, tree: tree }
        }).then(function (newTree) {
          return ghFetch(repoPath('/git/commits'), {
            method: 'POST',
            body: { message: message, tree: newTree.sha, parents: [head.commitSha] }
          });
        }).then(function (commit) {
          // force:false — a stale parent is rejected instead of overwriting.
          return ghFetch(refPath('/git/refs/heads/'), {
            method: 'PATCH',
            body: { sha: commit.sha, force: false }
          }).then(function () {
            if (nextEntries) state.entries = nextEntries;
            return { entries: nextEntries, commit: commit.sha };
          });
        });
      }).catch(function (err) {
        // 409/422 here means the branch moved under us.
        if ((err.status === 409 || err.status === 422) && attempt === 1) {
          logStatus('Branch changed meanwhile — re-reading and retrying once …', 'note');
          return tryOnce();
        }
        throw err;
      });
    }

    return tryOnce();
  }

  /* =======================================================================
     entries.json
     ======================================================================= */

  function loadEntriesFile() {
    return getFile(ENTRIES_PATH, true).then(function (file) {
      var list = [];
      if (file.content && file.content.trim()) {
        var parsed = JSON.parse(file.content); // throws on broken JSON — surfaced to the user
        list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.entries) ? parsed.entries : []);
      }
      state.entries = list;
      return { entries: list, sha: file.sha };
    });
  }

  function loadTagsFile() {
    return getFile(TAGS_PATH, true).then(function (file) {
      var map = {};
      if (file.content && file.content.trim()) {
        var parsed = JSON.parse(file.content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
      }
      state.tagColors = map;
      return map;
    }).catch(function (err) {
      // The file is optional — a repo without it simply has no tag colours.
      if (err.status === 404) { state.tagColors = {}; return {}; }
      throw err;
    });
  }

  function sortEntries(list) {
    return list.slice().sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
  }

  /* =======================================================================
     Deployment: status, "is it live yet", and re-running a failed build
     ======================================================================= */

  /** Public URL of the site, however we can work it out. */
  function publicBaseUrl() {
    // Served from the Pages site itself: use our own directory.
    if (/\.github\.io$/i.test(location.hostname)) {
      return location.origin + location.pathname.replace(/[^/]*$/, '');
    }
    if (state.pagesUrl) return state.pagesUrl.replace(/\/?$/, '/');
    if (state.repo.owner && state.repo.repo) {
      var owner = state.repo.owner.toLowerCase();
      if (state.repo.repo.toLowerCase() === owner + '.github.io') {
        return 'https://' + owner + '.github.io/';
      }
      return 'https://' + owner + '.github.io/' + state.repo.repo + '/';
    }
    return null;
  }

  /**
   * Fetch the live entries.json straight from the published site.
   * GitHub Pages sends access-control-allow-origin:*, so this works from
   * anywhere, and it is the only check that reflects what visitors actually see.
   */
  function fetchLiveEntries() {
    var base = publicBaseUrl();
    if (!base) return Promise.reject(new Error('Public site URL is unknown.'));
    return fetch(base + ENTRIES_PATH + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('The live site returned HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        return Array.isArray(data) ? data : (data && data.entries) || [];
      });
  }

  /** Compare the live site against the repo and paint the deploy bar. */
  function refreshDeployStatus(quiet) {
    setDeployState('checking', 'Checking the live site …');
    return fetchLiveEntries().then(function (live) {
      var liveIds = live.map(function (e) { return e.id; });
      var missing = state.entries.filter(function (e) { return liveIds.indexOf(e.id) === -1; });
      if (missing.length === 0 && live.length === state.entries.length) {
        setDeployState('ok', 'Live site is up to date (' + live.length + ' entries).');
      } else {
        setDeployState('stale',
          missing.length
            ? missing.length + ' entry/entries not published yet — re-run the deployment.'
            : 'Live site differs from the repository — re-run the deployment.');
      }
      return live;
    }).catch(function (err) {
      setDeployState('unknown', 'Could not read the live site: ' + err.message);
      if (!quiet) logStatus('Live check failed: ' + err.message, 'note');
    });
  }

  function setDeployState(kind, text) {
    el.deployBar.className = 'deploy-bar is-' + kind;
    el.deployText.textContent = text;
  }

  /** Poll the published site until the given entry id shows up. */
  function waitUntilLive(entryId, status) {
    if (state.deployPoll) clearTimeout(state.deployPoll);
    var started = Date.now();

    function poll() {
      fetchLiveEntries().then(function (live) {
        var there = live.some(function (e) { return e.id === entryId; });
        if (there) {
          status.update('Published — your entry is live on the site.', 'ok');
          setDeployState('ok', 'Live site is up to date (' + live.length + ' entries).');
          return;
        }
        if (Date.now() - started > DEPLOY_TIMEOUT_MS) {
          status.update('Committed, but still not live after 4 minutes. The Pages build may have failed — try "Re-run deployment".', 'note');
          setDeployState('stale', 'Committed but not published yet — try re-running the deployment.');
          return;
        }
        state.deployPoll = setTimeout(poll, DEPLOY_POLL_MS);
      }).catch(function () {
        if (Date.now() - started > DEPLOY_TIMEOUT_MS) {
          status.update('Committed. Could not confirm publication automatically.', 'note');
          return;
        }
        state.deployPoll = setTimeout(poll, DEPLOY_POLL_MS);
      });
    }

    status.update('Committed. Waiting for GitHub Pages to publish (about a minute) …', 'work');
    setDeployState('building', 'Waiting for GitHub Pages to publish …');
    state.deployPoll = setTimeout(poll, DEPLOY_POLL_MS);
  }

  /** Find the newest GitHub Pages build run. Needs the token's Actions: Read. */
  function findPagesRun() {
    return ghFetch(repoPath('/actions/runs?per_page=20')).then(function (data) {
      var runs = (data && data.workflow_runs) || [];
      var pages = runs.filter(function (r) {
        return /pages/i.test(r.name || '') || /pages/i.test(r.path || '');
      });
      return (pages[0] || runs[0]) || null;
    });
  }

  /**
   * Re-run the deployment.
   *
   * Two routes, because a repo may publish either from a branch or from a
   * workflow, and the token may hold either permission:
   *   1. Actions API — re-run the pages build workflow  (Actions: Read+Write)
   *   2. Pages API   — request a fresh build            (Pages:   Read+Write)
   * If neither is permitted we say exactly which permission to add.
   */
  function rerunDeployment() {
    var status = logStatus('Requesting a new GitHub Pages deployment …', 'work');
    el.rerunBtn.disabled = true;
    setDeployState('building', 'Re-running the deployment …');

    findPagesRun().then(function (run) {
      if (!run) throw ApiError('No workflow run found to re-run.', 404, null);
      var endpoint = run.conclusion === 'failure' ? '/rerun-failed-jobs' : '/rerun';
      return ghFetch(repoPath('/actions/runs/' + run.id + endpoint), { method: 'POST' })
        .then(function () { return 'Re-running "' + (run.name || 'pages build') + '".'; });
    })
    .catch(function (actionsErr) {
      // Fall back to asking Pages itself for a build.
      return ghFetch(repoPath('/pages/builds'), { method: 'POST' })
        .then(function () { return 'Requested a fresh GitHub Pages build.'; })
        .catch(function (pagesErr) {
          var denied = [actionsErr, pagesErr].some(function (e) {
            return e && (e.status === 403 || e.status === 404);
          });
          throw new Error(denied
            ? 'Your token cannot trigger a deployment. Add "Actions: Read and write" (or "Pages: Read and write") to it, or use the Actions tab on GitHub. (' + actionsErr.message + ')'
            : actionsErr.message);
        });
    })
    .then(function (msg) {
      status.update(msg + ' It takes about a minute.', 'ok');
      setDeployState('building', 'Deployment running — this takes about a minute.');
      // Give the build a head start, then watch the live site.
      setTimeout(function () { refreshDeployStatus(true); }, 45000);
    })
    .catch(function (err) {
      status.update(err.message, 'error');
      refreshDeployStatus(true);
    })
    .then(function () { el.rerunBtn.disabled = false; });
  }

  /* =======================================================================
     Authentication
     ======================================================================= */

  /**
   * Guess owner/repo from the URL when the page is served by GitHub Pages.
   *   user.github.io/my-portfolio/admin.html -> project site
   *   user.github.io/admin.html              -> user site
   * Anywhere else the fields stay empty and the user fills them in once.
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

    var m = /^([\w-]+)\.github\.io$/i.exec(location.hostname);
    if (m) {
      var owner = m[1];
      var segments = location.pathname.split('/').filter(Boolean);
      var project = segments.length > 1 ? segments[0] : null;
      // Branch left empty on purpose: verifyToken() fills in the default branch.
      return { owner: owner, repo: project || (owner + '.github.io'), branch: '' };
    }
    return { owner: '', repo: '', branch: '' };
  }

  function saveRepo() { lsSet(LS_REPO, JSON.stringify(state.repo)); }

  function verifyToken(token) {
    state.token = token;
    return ghFetch('/user').then(function (user) {
      state.user = user;
      return ghFetch(repoPath('')).then(function (repo) {
        // Only auto-fill when the user left the branch field empty — never
        // override a branch they typed (Pages may publish from gh-pages).
        if (!state.repo.branch) state.repo.branch = repo.default_branch || 'main';
        // Optional: the real public URL, if the token may read Pages settings.
        return ghFetch(repoPath('/pages'))
          .then(function (pages) { state.pagesUrl = pages && pages.html_url; })
          .catch(function () { /* no Pages permission — we can derive the URL */ })
          .then(function () { return user; });
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
        .then(function () { return loadTagsFile(); })
        .then(function () {
          renderEntryList();
          refreshSubjectSuggestions();
          renderTagPreview();
          refreshDeployStatus(true);
        })
        .catch(function (err) {
          if (err.status === 404) return; // brand new repo, no entries.json yet
          logStatus('Could not read data/entries.json: ' + err.message, 'error');
        });
    });
  }

  function logout() {
    lsDel(LS_TOKEN);
    if (state.deployPoll) clearTimeout(state.deployPoll);
    state.token = null;
    state.user = null;
    state.entries = [];
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

    var base = publicBaseUrl();
    if (base) {
      el.viewSiteLink.href = base;
      show(el.viewSiteLink, true);
    }
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

    // Images referenced in the text are not on the live site yet, so point them
    // at the local preview of the pending file instead of a 404.
    var imgs = el.mdPreview.querySelectorAll('img');
    Array.prototype.forEach.call(imgs, function (img) {
      var m = /(?:^|\/)images\/[^/]+\/([^/?#]+)$/.exec(img.getAttribute('src') || '');
      if (!m) return;
      for (var i = 0; i < state.images.length; i++) {
        if (state.images[i].name === m[1]) { img.src = state.images[i].preview; return; }
      }
    });
  }

  /* =======================================================================
     Image pipeline
     -------------------------------------------------------------------------
     Everything a browser can decode is resized to at most IMG_MAX_DIM on its
     longest edge and re-encoded, so a 6 MB phone photo becomes a few hundred
     KB without the user having to think about it. SVG and GIF pass through
     untouched (vector / animation would be destroyed).
     ======================================================================= */

  function decodeImage(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).catch(function () { return decodeViaImgTag(file); });
    }
    return decodeViaImgTag(file);
  }

  function decodeViaImgTag(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        blob ? resolve(blob) : reject(new Error('encoding failed'));
      }, type, quality);
    });
  }

  /**
   * Resolve to { blob, name, width, height, originalSize }.
   * Rejects with a readable message when the browser cannot decode the file —
   * most often an iPhone .heic outside Safari.
   */
  function processImage(file) {
    var original = file.size;

    if (KEEP_AS_IS.indexOf(file.type) !== -1) {
      return Promise.resolve({
        blob: file, name: safeFileName(file.name), width: 0, height: 0, originalSize: original
      });
    }

    return decodeImage(file).then(function (src) {
      var w = src.width, h = src.height;
      var scale = Math.min(1, IMG_MAX_DIM / Math.max(w, h));
      var needsWork = scale < 1 || original > IMG_RECOMPRESS_ABOVE;

      if (!needsWork) {
        return { blob: file, name: safeFileName(file.name), width: w, height: h, originalSize: original };
      }

      var tw = Math.max(1, Math.round(w * scale));
      var th = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(src, 0, 0, tw, th);
      if (src.close) src.close(); // release the ImageBitmap

      // PNG in, PNG out: transparency survives. Everything else becomes JPEG.
      var isPng = file.type === 'image/png';
      var outType = isPng ? 'image/png' : 'image/jpeg';

      return canvasToBlob(canvas, outType, isPng ? undefined : IMG_QUALITY).then(function (blob) {
        // Re-encoding an already well-optimised file can make it bigger.
        if (blob.size >= original && scale === 1) {
          return { blob: file, name: safeFileName(file.name), width: w, height: h, originalSize: original };
        }
        return {
          blob: blob,
          name: safeFileName(file.name, isPng ? 'png' : 'jpg'),
          width: tw, height: th, originalSize: original
        };
      });
    }).catch(function () {
      var heic = /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
      throw new Error(heic
        ? file.name + ': HEIC images cannot be read by this browser. Export as JPG first (iPhone: Settings → Camera → Formats → Most Compatible).'
        : file.name + ': this file could not be read as an image.');
    });
  }

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    files.forEach(function (file) {
      if (!/^image\//.test(file.type) && !/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(file.name)) {
        logStatus('Skipped (not an image file): ' + file.name, 'note');
        return;
      }

      var prep = logStatus('Preparing ' + file.name + ' …', 'work');
      processImage(file).then(function (result) {
        if (result.blob.size > IMG_HARD_LIMIT) {
          prep.update(file.name + ' is still ' + formatBytes(result.blob.size) + ' after compression — too large.', 'error');
          return;
        }

        var item = {
          id: uid(),
          name: uniqueFileName(result.name),
          preview: URL.createObjectURL(result.blob),
          blob: result.blob,
          size: result.blob.size,
          originalSize: result.originalSize,
          path: null,       // set once committed
          uploaded: false
        };
        state.images.push(item);
        if (!state.coverId) state.coverId = item.id; // first image becomes the cover
        renderImageList();
        updatePreview();

        var saved = result.originalSize - result.blob.size;
        prep.update(saved > 1024
          ? 'Ready: ' + item.name + ' (' + formatBytes(result.originalSize) + ' → ' + formatBytes(item.size) + ')'
          : 'Ready: ' + item.name + ' (' + formatBytes(item.size) + ')', 'ok');
      }).catch(function (err) {
        prep.update(err.message, 'error');
      });
    });
  }

  /** Insert a Markdown image reference at the cursor in the body field. */
  function insertImageMarkdown(item) {
    var slug = currentSlug();
    if (!el.fTitle.value.trim() && !state.editingSlug) {
      logStatus('Enter a title first — the image path is built from it.', 'error');
      el.fTitle.focus();
      return;
    }
    var alt = item.name.replace(/\.[^.]+$/, '').replace(/-/g, ' ');
    var md = '\n![' + alt + '](' + IMAGES_DIR + '/' + slug + '/' + item.name + ')\n';

    var ta = el.fBody;
    var start = ta.selectionStart || 0;
    var end = ta.selectionEnd || 0;
    ta.value = ta.value.slice(0, start) + md + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + md.length;
    ta.focus();
    updatePreview();
    logStatus('Inserted into the text: ' + item.name, 'ok');
  }

  function removeImage(item) {
    if (item.uploaded && item.path) state.removedPaths.push(item.path);
    if (item.preview && item.preview.indexOf('blob:') === 0) URL.revokeObjectURL(item.preview);
    state.images = state.images.filter(function (i) { return i.id !== item.id; });
    if (state.coverId === item.id) {
      state.coverId = state.images.length ? state.images[0].id : null;
    }
    renderImageList();
    updatePreview();
  }

  function renderImageList() {
    el.imageList.innerHTML = '';
    show(el.imageHint, state.images.length > 0);

    state.images.forEach(function (item) {
      var box = document.createElement('div');
      box.className = 'image-item' + (state.coverId === item.id ? ' is-cover' : '');

      var img = document.createElement('img');
      img.src = item.preview;
      img.alt = '';
      img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
      box.appendChild(img);

      var meta = document.createElement('div');
      meta.className = 'img-meta';
      meta.innerHTML = '<span class="img-name">' + escapeHtml(item.name) + '</span>' +
                       '<span class="img-size">' + (item.size ? formatBytes(item.size) : 'in repo') + '</span>';
      box.appendChild(meta);

      if (state.coverId === item.id) {
        var flag = document.createElement('span');
        flag.className = 'cover-flag';
        flag.textContent = 'Cover';
        box.appendChild(flag);
      }

      // Hover/focus actions
      var actions = document.createElement('div');
      actions.className = 'img-actions';

      var coverBtn = document.createElement('button');
      coverBtn.type = 'button';
      coverBtn.className = 'img-btn';
      coverBtn.textContent = 'Cover';
      coverBtn.title = 'Use as cover image';
      coverBtn.addEventListener('click', function () {
        state.coverId = item.id;
        renderImageList();
      });

      var insertBtn = document.createElement('button');
      insertBtn.type = 'button';
      insertBtn.className = 'img-btn';
      insertBtn.textContent = 'Insert';
      insertBtn.title = 'Insert into the text at the cursor';
      insertBtn.addEventListener('click', function () { insertImageMarkdown(item); });

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'img-btn is-danger';
      delBtn.textContent = 'Remove';
      delBtn.addEventListener('click', function () { removeImage(item); });

      actions.appendChild(coverBtn);
      actions.appendChild(insertBtn);
      actions.appendChild(delBtn);
      box.appendChild(actions);

      el.imageList.appendChild(box);
    });
  }

  /* =======================================================================
     Tag colours
     ======================================================================= */

  // Every tag in use, plus any that already carry a colour.
  function allTags() {
    var counts = {};
    state.entries.forEach(function (e) {
      (e.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    Object.keys(state.tagColors).forEach(function (t) {
      if (!(t in counts)) counts[t] = 0;
    });
    return Object.keys(counts).sort(function (a, b) {
      return a.localeCompare(b);
    }).map(function (t) { return { tag: t, count: counts[t] }; });
  }

  function makePill(tag) {
    var pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.textContent = '#' + tag;
    if (state.tagColors[tag]) pill.setAttribute('data-tag-color', state.tagColors[tag]);
    return pill;
  }

  function renderTagEditor() {
    var tags = allTags();
    el.tagEditor.innerHTML = '';

    if (!tags.length) {
      el.tagEditor.innerHTML =
        '<div class="state"><div class="state-icon">🏷️</div><h2>No tags yet</h2>' +
        '<p>Add tags to an entry and they will show up here.</p></div>';
      return;
    }

    tags.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'tag-row';

      var name = document.createElement('div');
      name.className = 'tag-name';
      name.appendChild(makePill(item.tag));
      row.appendChild(name);

      var count = document.createElement('span');
      count.className = 'tag-count';
      count.textContent = item.count === 1 ? '1 entry' : item.count + ' entries';
      row.appendChild(count);

      var swatches = document.createElement('div');
      swatches.className = 'swatches';

      // "no colour" first, then one swatch per colour
      [''].concat(TAG_COLOURS).forEach(function (colour) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'swatch' + (colour ? '' : ' is-none');
        if (colour) btn.setAttribute('data-tag-color', colour);
        btn.setAttribute('aria-pressed', String((state.tagColors[item.tag] || '') === colour));
        btn.setAttribute('aria-label', colour
          ? 'Colour ' + item.tag + ' ' + colour
          : 'Remove the colour from ' + item.tag);
        btn.title = colour || 'No colour';
        btn.addEventListener('click', function () {
          if (colour) state.tagColors[item.tag] = colour;
          else delete state.tagColors[item.tag];
          state.tagsDirty = true;
          el.saveTags.disabled = false;
          renderTagEditor();
          renderTagPreview();
        });
        swatches.appendChild(btn);
      });

      row.appendChild(swatches);
      el.tagEditor.appendChild(row);
    });
  }

  function saveTagColors() {
    var status = logStatus('Saving tag colours …', 'work');
    el.saveTags.disabled = true;

    // Drop tags that no longer exist anywhere, so the file stays tidy.
    var live = {};
    state.entries.forEach(function (e) {
      (e.tags || []).forEach(function (t) { live[t] = true; });
    });
    var clean = {};
    Object.keys(state.tagColors).sort().forEach(function (t) {
      if (live[t]) clean[t] = state.tagColors[t];
    });
    state.tagColors = clean;

    commitAll([], null, [], 'Update tag colours', [
      { path: TAGS_PATH, content: JSON.stringify(clean, null, 2) + '\n' }
    ])
      .then(function () {
        state.tagsDirty = false;
        status.update('Tag colours saved.', 'ok');
        setDeployState('building', 'Waiting for GitHub Pages to publish …');
        setTimeout(function () { refreshDeployStatus(true); }, 45000);
        renderTagEditor();
      })
      .catch(function (err) {
        el.saveTags.disabled = false;
        status.update('Saving tag colours failed: ' + err.message, 'error');
        if (err.status === 401) logout();
      });
  }

  // Live chips under the tags field, in their assigned colours.
  function renderTagPreview() {
    el.tagPreview.innerHTML = '';
    parseTags(el.fTags.value).forEach(function (t) {
      var pill = makePill(t);
      pill.title = 'Change this tag\u2019s colour';
      pill.addEventListener('click', function () {
        switchTab('tags');
        window.scrollTo(0, 0);
      });
      el.tagPreview.appendChild(pill);
    });
  }

  /* =======================================================================
     Form <-> entry object
     ======================================================================= */

  function resetForm() {
    el.entryForm.reset();
    el.entryId.value = '';
    el.fDate.value = todayISO();
    state.images.forEach(function (i) {
      if (i.preview && i.preview.indexOf('blob:') === 0) URL.revokeObjectURL(i.preview);
    });
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
    renderTagPreview();
  }

  function fillForm(entry) {
    state.editingId = entry.id;
    state.editingSlug = entry.slug;   // frozen, so existing image paths stay correct
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
        preview: (publicBaseUrl() || '') + path,
        blob: null,
        size: 0,
        path: path,
        uploaded: true
      };
    });
    var cover = state.images.filter(function (i) { return i.path === entry.coverImage; })[0];
    state.coverId = cover ? cover.id : (state.images[0] ? state.images[0].id : null);

    el.editorTitle.textContent = 'Edit entry';
    show(el.cancelEdit, true);
    renderTagPreview();
    renderImageList();
    updatePreview();
    switchTab('editor');
    window.scrollTo(0, 0);
  }

  function parseTags(raw) {
    return String(raw || '')
      .split(',')
      .map(function (t) { return t.trim(); })
      .filter(function (t, i, arr) { return t && arr.indexOf(t) === i; });
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
     Saving — one commit for the whole entry
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
    var slug = isEdit ? state.editingSlug : uniqueSlug(slugify(title), null);
    var nowISO = new Date().toISOString();
    var pending = state.images.filter(function (i) { return !i.uploaded; });

    el.saveBtn.disabled = true;
    var status = logStatus(
      pending.length
        ? 'Uploading ' + pending.length + ' image(s) …'
        : (isEdit ? 'Saving changes …' : 'Creating entry …'), 'work');

    // Step 1: upload each image as a blob. No commit yet — nothing is visible
    // in the repository until the single commit at the end.
    var done = 0;
    var blobJobs = pending.map(function (item) {
      return blobToBytes(item.blob)
        .then(function (bytes) { return createBlob(bytesToBase64(bytes)); })
        .then(function (sha) {
          done++;
          status.update('Uploaded ' + done + '/' + pending.length + ' image(s) …', 'work');
          item.path = IMAGES_DIR + '/' + slug + '/' + item.name;
          return { path: item.path, sha: sha };
        });
    });

    Promise.all(blobJobs).then(function (blobs) {
      status.update('Creating commit …', 'work');

      var paths = state.images.map(function (i) { return i.path; }).filter(Boolean);
      var coverItem = state.images.filter(function (i) { return i.id === state.coverId; })[0];
      var draft = {
        id: isEdit ? state.editingId : uid(),
        slug: slug,
        title: title,
        date: date,
        subject: el.fSubject.value.trim(),
        tags: parseTags(el.fTags.value),
        summary: el.fSummary.value.trim(),
        body: el.fBody.value,
        coverImage: (coverItem && coverItem.path) || paths[0] || null,
        images: paths,
        createdAt: nowISO,   // replaced with the original below when editing
        updatedAt: nowISO
      };

      // Step 2-5: modify the entries array and commit everything at once.
      return commitAll(blobs, function (entries) {
        if (isEdit) {
          var found = false;
          var updated = entries.map(function (e) {
            if (e.id !== draft.id) return e;
            found = true;
            draft.createdAt = e.createdAt || draft.createdAt;
            return draft;
          });
          if (!found) updated.push(draft);
          return updated;
        }
        return entries.concat([draft]);
      }, state.removedPaths.slice(), (isEdit ? 'Update entry: ' : 'Add entry: ') + title)
        .then(function () { return draft; });
    })
    .then(function (draft) {
      state.removedPaths = [];
      state.images.forEach(function (i) { i.uploaded = true; });
      refreshSubjectSuggestions();
      renderEntryList();
      resetForm();
      // Step 6: watch the published site and say when it is actually visible.
      waitUntilLive(draft.id, status);
    })
    .catch(function (err) {
      status.update('Error: ' + err.message, 'error');
      if (err.status === 401) logout();
    })
    .then(function () { el.saveBtn.disabled = false; });
  }

  /* =======================================================================
     Existing entries: list, edit, delete
     ======================================================================= */

  function renderEntryList() {
    el.adminList.innerHTML = '';

    if (!state.entries.length) {
      el.adminList.innerHTML =
        '<div class="state"><div class="state-icon">📭</div><h2>No entries yet</h2>' +
        '<p>Create your first one in the “Entry” tab.</p></div>';
      return;
    }

    sortEntries(state.entries).forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'admin-row';

      if (entry.coverImage) {
        var img = document.createElement('img');
        img.className = 'thumb';
        img.src = (publicBaseUrl() || '') + entry.coverImage;
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
      '“' + (entry.title || '(untitled)') + '” will be removed from data/entries.json' +
      ((entry.images || []).length ? ', and its images will be deleted.' : '.');
    show(el.confirmBackdrop, true);

    // Rebound each time so it always targets the current entry.
    el.confirmOk.onclick = function () {
      show(el.confirmBackdrop, false);
      deleteEntry(entry);
    };
  }

  function deleteEntry(entry) {
    var status = logStatus('Deleting entry …', 'work');
    // Entry removal and image deletion travel in the same single commit.
    commitAll([], function (entries) {
      return entries.filter(function (e) { return e.id !== entry.id; });
    }, (entry.images || []).slice(), 'Delete entry: ' + (entry.title || entry.slug))
      .then(function () {
        if (state.editingId === entry.id) resetForm();
        refreshSubjectSuggestions();
        renderEntryList();
        status.update('Entry deleted. GitHub Pages needs about a minute to republish.', 'ok');
        setDeployState('building', 'Waiting for GitHub Pages to publish …');
        setTimeout(function () { refreshDeployStatus(true); }, 45000);
      })
      .catch(function (err) {
        status.update('Delete failed: ' + err.message, 'error');
        if (err.status === 401) logout();
      });
  }

  function reloadEntries() {
    var status = logStatus('Reloading entries …', 'work');
    loadEntriesFile()
      .then(function () { return loadTagsFile(); })
      .then(function () {
        status.update(state.entries.length + ' entry/entries loaded.', 'ok');
        refreshSubjectSuggestions();
        renderEntryList();
        renderTagPreview();
        if (!el.paneTags.hidden) renderTagEditor();
        refreshDeployStatus(true);
      })
      .catch(function (err) {
        if (err.status === 404) {
          status.update('data/entries.json does not exist yet — it will be created on the first save.', 'note');
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
    var panes = { editor: [el.tabEditor, el.paneEditor],
                  list:   [el.tabList,   el.paneList],
                  tags:   [el.tabTags,   el.paneTags] };
    Object.keys(panes).forEach(function (key) {
      var active = key === which;
      panes[key][0].setAttribute('aria-selected', String(active));
      show(panes[key][1], active);
    });
    if (which === 'tags') renderTagEditor();
  }

  function initTheme() {
    var stored = lsGet(LS_THEME);
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', stored || (prefersDark ? 'dark' : 'light'));
  }

  function init() {
    el = {
      loginView: $('login-view'), appView: $('app-view'),
      loginForm: $('login-form'), loginError: $('login-error'),
      tokenInput: $('token-input'), ownerInput: $('owner-input'),
      repoInput: $('repo-input'), branchInput: $('branch-input'),
      repoLabel: $('repo-label'), userBadge: $('user-badge'),
      logoutBtn: $('logout-btn'), viewSiteLink: $('view-site'),

      deployBar: $('deploy-bar'), deployText: $('deploy-text'),
      checkBtn: $('check-btn'), rerunBtn: $('rerun-btn'),

      tabEditor: $('tab-editor'), tabList: $('tab-list'), tabTags: $('tab-tags'),
      paneEditor: $('pane-editor'), paneList: $('pane-list'), paneTags: $('pane-tags'),
      tagEditor: $('tag-editor'), saveTags: $('save-tags'), tagPreview: $('tag-preview'),

      entryForm: $('entry-form'), entryId: $('entry-id'),
      editorTitle: $('editor-title'), cancelEdit: $('cancel-edit'),
      fTitle: $('f-title'), fDate: $('f-date'), fSubject: $('f-subject'),
      fTags: $('f-tags'), fSummary: $('f-summary'), fBody: $('f-body'),
      subjectList: $('subject-list'), slugPreview: $('slug-preview'),
      mdPreview: $('md-preview'), saveBtn: $('save-btn'), resetBtn: $('reset-btn'),

      dropzone: $('dropzone'), fileInput: $('file-input'),
      imageList: $('image-list'), imageHint: $('image-hint'),

      adminList: $('admin-list'), reloadBtn: $('reload-btn'),
      statusLog: $('status-log'),

      confirmBackdrop: $('confirm-backdrop'), confirmText: $('confirm-text'),
      confirmOk: $('confirm-ok'), confirmCancel: $('confirm-cancel')
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
        el.loginError.textContent = 'Please provide owner and repository (under “Repository settings”).';
        show(el.loginError, true);
        return;
      }

      var btn = el.loginForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Checking token …';

      login(el.tokenInput.value.trim())
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

    // --- deploy bar --------------------------------------------------------
    el.checkBtn.addEventListener('click', function () { refreshDeployStatus(false); });
    el.rerunBtn.addEventListener('click', rerunDeployment);

    // --- tabs --------------------------------------------------------------
    el.tabEditor.addEventListener('click', function () { switchTab('editor'); });
    el.tabList.addEventListener('click', function () { switchTab('list'); });
    el.tabTags.addEventListener('click', function () { switchTab('tags'); });
    el.saveTags.addEventListener('click', saveTagColors);
    el.fTags.addEventListener('input', renderTagPreview);

    // --- editor ------------------------------------------------------------
    el.fBody.addEventListener('input', updatePreview);
    el.fTitle.addEventListener('input', function () {
      el.slugPreview.textContent = state.editingSlug || slugify(el.fTitle.value) || '–';
    });
    el.entryForm.addEventListener('submit', handleSave);
    el.resetBtn.addEventListener('click', resetForm);
    el.cancelEdit.addEventListener('click', resetForm);
    el.reloadBtn.addEventListener('click', reloadEntries);

    // --- files: click, drag & drop, paste ----------------------------------
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

    // Paste a screenshot straight into the editor (Ctrl/Cmd+V).
    document.addEventListener('paste', function (ev) {
      if (!state.token || !ev.clipboardData) return;
      var items = ev.clipboardData.items || [];
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          var f = items[i].getAsFile();
          if (f) {
            // Clipboard images all arrive called "image.png". Name them
            // screenshot.png, screenshot-2.png, … — uniqueFileName() adds the
            // suffix, and it reads well as Markdown alt text.
            var ext = (f.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
            files.push(new File([f], 'screenshot.' + ext, { type: f.type }));
          }
        }
      }
      if (files.length) {
        ev.preventDefault();
        switchTab('editor');
        addFiles(files);
      }
    });

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
      var dirty = state.tagsDirty ||
                  (el.fTitle && (el.fTitle.value.trim() || el.fBody.value.trim() || state.images.length));
      if (state.token && dirty) { ev.preventDefault(); ev.returnValue = ''; }
    });

    resetForm();

    // --- auto login with a previously stored token -------------------------
    var savedToken = lsGet(LS_TOKEN);
    if (savedToken && state.repo.owner && state.repo.repo) {
      var status = logStatus('Checking saved token …', 'work');
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
