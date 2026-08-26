# Portfolio

A static portfolio site for school work. No build step, no framework, no server —
just HTML, CSS and vanilla JavaScript served straight from GitHub Pages.

* **`index.html`** — the public site: a responsive grid of entries with live search,
  subject/tag filters, a detail view rendered from Markdown, and a light/dark toggle.
* **`admin.html`** — a private editor that commits changes to this repository
  directly from your browser using the GitHub API. It is not linked from the public pages.

All entries are read at runtime from `data/entries.json`. There is no hardcoded
HTML per entry — adding an entry means adding an object to that JSON file, which
is exactly what the admin page does for you.

---

## Folder structure

```
.
├── index.html            Public site
├── admin.html            Admin editor (not linked from the public pages)
├── .nojekyll             Tells GitHub Pages to serve files as-is
├── README.md
├── css/
│   ├── style.css         Design tokens, public site, shared components
│   └── admin.css         Admin-only styling
├── js/
│   ├── app.js            Public site logic (loading, search, filters, routing)
│   └── admin.js          Admin logic (GitHub API, uploads, commits)
├── data/
│   └── entries.json      Every entry lives here
└── images/
    └── <slug>/           Uploaded images, one folder per entry
```

---

## Part 1 — Enable GitHub Pages

1. Push this repository to GitHub.
2. Open the repository on github.com and go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Pick the branch you want to publish (usually `main`) and the folder **`/ (root)`**.
5. Click **Save**.

After a minute or two the site is live at:

```
https://<your-username>.github.io/<repository-name>/
```

The admin page is at the same address plus `admin.html`:

```
https://<your-username>.github.io/<repository-name>/admin.html
```

> **Note on the branch.** The admin page commits to the branch that GitHub Pages
> publishes from. If you publish from `main`, leave the branch field in the admin
> login set to `main`. If you publish from something else, enter that branch name
> under **Repository settings** on the admin login screen.

---

## Part 2 — Create a fine-grained Personal Access Token

The admin page needs permission to commit to this repository — and to *nothing else*.
A **fine-grained** token scoped to a single repository is exactly that.

1. On github.com, click your avatar (top right) → **Settings**.
2. In the left sidebar, scroll to the bottom → **Developer settings**.
3. Choose **Personal access tokens → Fine-grained tokens**.
4. Click **Generate new token**.
5. Fill in the form:

   | Field | What to enter |
   | --- | --- |
   | **Token name** | e.g. `portfolio-admin` |
   | **Expiration** | Pick a date you are comfortable with (e.g. 90 days). You will need to create a new token when it expires. |
   | **Resource owner** | Your own account |
   | **Repository access** | **Only select repositories** → pick **this repository only** |

6. Open **Permissions → Repository permissions** and set:

   | Permission | Level | Why |
   | --- | --- | --- |
   | **Contents** | Read and write | Required — this is what commits your entries and images |
   | **Actions** | Read and write | Optional — lets the **Re-run deployment** button work |

   Leave everything else on *No access*. (GitHub adds a read-only **Metadata**
   permission automatically — that is expected.)

   Without the *Actions* permission everything still works; only the re-run
   button is unavailable, and the admin page tells you so and points you at the
   Actions tab instead. If your site publishes from a branch rather than a
   workflow, **Pages: Read and write** works for the re-run button too — the
   admin page tries both.

7. Click **Generate token** and **copy it now** — GitHub shows it only once.
8. Open `admin.html`, paste the token, and click **Verify token & sign in**.
   The page calls the GitHub API to confirm the token and shows your username in the header.

The token is saved in your browser's `localStorage` so you do not have to paste it
every time. The **Log out / forget token** button in the header deletes it again.

### If the token expires or you lose it

Just create a new one the same way and sign in again. Old tokens can be revoked
at any time under **Settings → Developer settings → Personal access tokens →
Fine-grained tokens**.

---

## How this site is protected

**The token is the only thing that protects your site.** There is no login system,
no database and no server-side code — there is nothing else to protect it with.
That means:

* **The token is never committed.** It is not in this repository, not in any file,
  and not in the deployed site. It exists only in the `localStorage` of the browser
  you typed it into.
* **Anyone can read the site.** A GitHub Pages site is public. `admin.html` is public
  too — anyone who guesses the URL can open the page. That is fine: without a valid
  token, every GitHub API call it makes is rejected, so the form does nothing.
  **Reading is open to everyone; writing requires the token.**
* **Anyone with the token can change the site.** Treat it like a password: do not
  paste it into chats, screenshots or commits, and use **Log out / forget token**
  on shared or public computers.
* **Scope limits the damage.** Because the token is fine-grained and scoped to this
  one repository with only *Contents: Read and write*, a leaked token cannot touch
  your other repositories, your account settings or anything else.

If you ever think the token has leaked, revoke it on GitHub. That immediately makes
it useless, everywhere, and the public site keeps working untouched.

---

## Using the admin page

### Creating an entry

1. Open `admin.html` and sign in.
2. Fill in title, date (defaults to today), subject, tags, a short summary
   and the body in Markdown — the preview next to the editor updates as you type.
3. Add images in whichever way is easiest:
   * **drag** them onto the drop area,
   * **click** the drop area to pick files, or
   * **paste** a screenshot with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>V</kbd>.
4. Each thumbnail has three buttons:
   * **Cover** — use it as the image shown in the overview (the first image is the cover by default)
   * **Insert** — drop `![](images/<slug>/<file>)` into the text at your cursor
   * **Remove** — take it back out
5. Click **Save entry**.

**You never have to prepare the files first.** Anything the browser can decode is
resized to at most 1600 px on its longest edge and re-encoded before upload, so a
6 MB phone photo becomes roughly 400 KB on its own. PNGs stay PNGs (transparency
survives); SVG and GIF are passed through untouched so vectors and animations are
not destroyed. The thumbnail shows the final size.

What happens when you save — **one commit, not one per file**:

1. Each new image is uploaded as a blob (`POST /git/blobs`) — nothing is visible
   in the repository yet.
2. `data/entries.json` is read so the new entry is added to the *current* content.
3. A tree, then a commit, containing every image **and** `entries.json` together.
4. The branch is moved to that commit with a non-forced update, so if someone
   else committed in the meantime GitHub rejects it and the admin page re-reads
   and retries once — without re-uploading the images.

That means one save produces exactly one GitHub Pages deployment, and an entry is
never half-published. The status messages in the bottom-right corner show each
step, and afterwards the page **polls your live site** and tells you the moment the
entry is actually visible (usually about a minute).

### The deployment bar

Across the top of the admin page is a status bar comparing your **live site** with
the **repository**:

* 🟢 *Live site is up to date* — everything you have saved is published.
* 🟠 *… not published yet* — the commit landed but GitHub Pages has not published it.
* **Check now** — re-reads the live `data/entries.json` and refreshes the comparison.
* **Re-run deployment** — asks GitHub to build and deploy again.

Use **Re-run deployment** when a Pages build fails. That happens occasionally for
reasons that have nothing to do with your content — GitHub's deployment API
returns a `500` and the build is marked failed:

```
Error: Failed to create deployment (status: 500) with build version <sha>.
Server error, is githubstatus.com reporting a Pages outage?
```

Your commit is fine in that case; only the publishing step failed. Re-running
redeploys the same commit. If it keeps failing, check
[githubstatus.com](https://www.githubstatus.com/) for a Pages incident.

### Editing and deleting

The **All entries** tab lists everything in `data/entries.json` with **Edit** and
**Delete** buttons. Both work the same way: read the file and its `sha`, modify the
array, commit it back. Deleting an entry also removes its uploaded images.

An entry's slug never changes when you edit it, so image paths stay valid.

### If two people save at once

The branch is updated with `force: false`, so if the branch moved between the read
and the write, GitHub rejects it (`422` / `409`) instead of overwriting the other
change. The admin page catches that, re-reads the head commit and
`data/entries.json`, rebuilds the commit on top of the newer version and retries —
once. Already-uploaded image blobs are reused, so the retry costs nothing extra.

---

## Entry format

Each object in `data/entries.json`:

```json
{
  "id": "unique-id",
  "slug": "url-safe-name",
  "title": "Sample project",
  "date": "2026-05-04",
  "subject": "Computer Science",
  "tags": ["html", "css"],
  "summary": "One or two sentences for the overview.",
  "body": "## Markdown\n\nThe full text of the entry.",
  "coverImage": "images/url-safe-name/cover.jpg",
  "images": ["images/url-safe-name/cover.jpg"],
  "createdAt": "2026-05-04T08:00:00.000Z",
  "updatedAt": "2026-05-04T08:00:00.000Z"
}
```

| Field | Meaning |
| --- | --- |
| `id` | Internal identifier, used to find the entry when editing or deleting |
| `slug` | Used in the URL (`#/entry/<slug>`) and as the image folder name |
| `date` | ISO date (`YYYY-MM-DD`). The overview sorts newest first |
| `subject` | Single value, becomes an option in the subject dropdown |
| `tags` | Array of strings, becomes the clickable tag chips |
| `body` | Markdown, rendered with [marked](https://marked.js.org/) and sanitised with [DOMPurify](https://github.com/cure53/DOMPurify) |
| `coverImage` | Path to the cover image, or `null` — entries without one get a generated placeholder |
| `images` | All images belonging to the entry; those that are not the cover appear in a gallery |

The file ships with two example entries. Delete them in the admin area once you have
added your own.

---

## Technical notes

* **Cache busting.** GitHub Pages caches aggressively, so `entries.json` is always
  fetched with `?t=<timestamp>`. Without it you would keep seeing the old file after
  saving.
* **UTF-8 safe base64.** The GitHub API wants file content base64 encoded. Plain
  `btoa()` throws on anything outside Latin-1, so umlauts and emoji would break a
  commit. `admin.js` encodes through `TextEncoder` and base64s the resulting *bytes*
  instead of the characters, and decodes back through `TextDecoder`.
* **One atomic commit per save.** Writes go through the Git Data API
  (blobs → tree → commit → ref) rather than one Contents API `PUT` per file.
  Reads still use the Contents API. This keeps a multi-image entry to a single
  commit and a single deployment, and makes a half-saved entry impossible.
* **Client-side image processing.** Resizing and re-encoding happen on a
  `<canvas>` in the browser, so nothing large is ever uploaded. HEIC files
  (the iPhone default) cannot be decoded outside Safari; the admin page detects
  that and says so instead of committing a file that will not display.
* **No build step.** `marked` and `DOMPurify` are loaded from a CDN at pinned versions.
  If the CDN is unreachable, the detail view falls back to showing the raw Markdown
  rather than an empty page.
* **`.nojekyll`** stops GitHub Pages from running the content through Jekyll, which
  would otherwise ignore files and folders starting with an underscore.
* **Routing** is hash based (`#/entry/<slug>`), so entry links are shareable and
  bookmarkable without any server configuration.

---

## Running it locally

Because the page fetches `data/entries.json`, opening `index.html` from the file
system will not work — browsers block `fetch` on `file://`. Serve the folder over HTTP:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. The admin page works locally too; on localhost it
cannot detect the repository from the URL, so open **Repository settings** on the login
screen and fill in the owner, repository name and branch once. It is remembered afterwards.
