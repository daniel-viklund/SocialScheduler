const $ = (sel) => document.querySelector(sel);

const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

const fmtDuration = (secs) => {
  if (!Number.isFinite(secs) || secs < 0) return '–';
  if (secs < 90) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

// <input type="datetime-local"> wants wall-clock time, not UTC.
const toLocalInput = (date) => {
  const d = new Date(date);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

let maxUploadBytes = Infinity;
let instagramLimits = { reelMaxBytes: Infinity, imageMaxBytes: Infinity };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------- connections ---------- */

async function loadStatus() {
  const status = await api('/api/status');

  const yt = $('#conn-youtube');
  const ytDot = yt.querySelector('.dot');
  const ytState = yt.querySelector('.conn-state');
  const ytBtn = $('#yt-connect');
  if (!status.youtube.configured) {
    ytDot.className = 'dot err';
    ytState.textContent = 'not configured (set YT_CLIENT_ID / YT_CLIENT_SECRET in .env)';
    ytBtn.hidden = true;
  } else if (!status.youtube.connected) {
    ytDot.className = 'dot warn';
    ytState.textContent = 'not connected';
    ytBtn.hidden = false;
  } else {
    ytDot.className = 'dot ok';
    ytState.textContent = 'connected';
    ytBtn.hidden = true;
  }

  const ig = $('#conn-instagram');
  const igDot = ig.querySelector('.dot');
  const igState = ig.querySelector('.conn-state');
  const igBtn = $('#ig-connect');
  if (!status.instagram.configured) {
    igDot.className = 'dot err';
    igState.textContent = 'not configured (set IG_APP_ID / IG_APP_SECRET / PUBLIC_BASE_URL in .env)';
    igBtn.hidden = true;
  } else if (!status.instagram.connected) {
    igDot.className = 'dot warn';
    igState.textContent = 'not connected';
    igBtn.hidden = false;
  } else {
    // Surface token expiry here: a silently expired token is the one failure
    // mode that only shows up when a scheduled post is already overdue.
    const days = status.instagram.tokenExpiresAt
      ? Math.round((new Date(status.instagram.tokenExpiresAt) - Date.now()) / 864e5)
      : null;
    const who = status.instagram.username ? `connected as @${status.instagram.username}` : 'connected';
    igDot.className = days !== null && days < 7 ? 'dot warn' : 'dot ok';
    igState.textContent = days !== null ? `${who} · token valid ${days} more day(s)` : who;
    igBtn.hidden = days !== null && days < 7 ? false : true;
    if (!igBtn.hidden) igBtn.textContent = 'Reconnect Instagram';
  }

  if (typeof status.maxUploadBytes === 'number') maxUploadBytes = status.maxUploadBytes;
  if (status.instagramLimits) instagramLimits = status.instagramLimits;

  const box = $('#storage');
  if (status.storage) {
    const { total, free, used, uploadsBytes, uploadCount } = status.storage;
    const pct = total > 0 ? (used / total) * 100 : 0;
    box.hidden = false;
    $('#storage-num').textContent = `${fmtBytes(free)} free of ${fmtBytes(total)}`;
    const bar = $('#storage-bar');
    bar.style.width = `${Math.min(100, pct).toFixed(1)}%`;
    bar.className = `bar-fill${pct >= 90 ? ' err' : pct >= 75 ? ' warn' : ''}`;
    $('#storage-detail').textContent =
      `${fmtBytes(uploadsBytes)} in ${uploadCount} scheduled file${uploadCount === 1 ? '' : 's'} · ${pct.toFixed(0)}% of disk used`;

    const orphanBox = $('#storage-orphans');
    const orphanCount = status.storage.orphanCount ?? 0;
    orphanBox.hidden = orphanCount === 0;
    if (orphanCount > 0) {
      $('#storage-orphan-text').textContent =
        `${fmtBytes(status.storage.orphanBytes)} in ${orphanCount} leftover file${orphanCount === 1 ? '' : 's'} from interrupted uploads`;
    }
  } else {
    box.hidden = true;
  }

  const hint = $('#conn-hint');
  if (status.instagram.configured && !status.publicBaseUrl) {
    hint.hidden = false;
    hint.textContent = 'PUBLIC_BASE_URL is not set — Instagram cannot fetch your media without a public tunnel URL.';
  } else if (!status.youtube.configured || !status.instagram.configured) {
    hint.hidden = false;
    hint.textContent = 'See the README for how to set up YouTube and Instagram credentials.';
  } else {
    hint.hidden = true;
  }
}

/* ---------- new post form ---------- */

const form = $('#post-form');
const msg = $('#form-msg');

// Default the schedule field to one hour from now.
const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
inOneHour.setSeconds(0, 0);
form.scheduledAt.value = toLocalInput(inOneHour);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.hidden = true;

  const platforms = [...form.querySelectorAll('input[name="platforms"]:checked')].map((el) => el.value);
  if (platforms.length === 0) return showMsg('Pick at least one platform', true);

  const file = form.file.files[0];
  if (file && file.size > maxUploadBytes) {
    return showMsg(`${fmtBytes(file.size)} exceeds the ${fmtBytes(maxUploadBytes)} upload limit`, true);
  }
  // The server checks the file properly once it has it, but size alone rules
  // out most exports and that is worth knowing before a multi-GB upload.
  if (file && platforms.includes('instagram')) {
    const isVideo = file.type.startsWith('video/');
    const limit = isVideo ? instagramLimits.reelMaxBytes : instagramLimits.imageMaxBytes;
    if (file.size > limit) {
      return showMsg(
        `${fmtBytes(file.size)} is over Instagram's ${fmtBytes(limit)} ${isVideo ? 'Reels' : 'image'} limit — export a smaller file or untick Instagram`,
        true
      );
    }
  }

  const fd = new FormData();
  fd.append('file', form.file.files[0]);
  fd.append('title', form.title.value);
  fd.append('description', form.description.value);
  fd.append('scheduledAt', new Date(form.scheduledAt.value).toISOString());
  for (const p of platforms) fd.append('platforms', p);

  const btn = $('#submit-btn');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    const created = await uploadWithProgress(fd);
    const notes = created.warnings?.length ? ` — ${created.warnings.join(' · ')}` : '';
    showMsg(`Scheduled ✔${notes}`, false);
    form.file.value = '';
    form.title.value = '';
    form.description.value = '';
    await loadPosts();
    await loadStatus();
  } catch (err) {
    showMsg(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Schedule';
    $('#upload-progress').hidden = true;
  }
});

// Multi-GB uploads over wifi take tens of minutes, so show real progress
// rather than leaving the button spinning. XHR is the only way to observe it.
function uploadWithProgress(fd) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const box = $('#upload-progress');
    const bar = $('#upload-bar');
    const detail = $('#upload-detail');
    box.hidden = false;
    bar.style.width = '0%';
    bar.className = 'bar-fill';
    detail.textContent = 'Starting…';
    const started = Date.now();

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      bar.style.width = `${pct.toFixed(1)}%`;
      const elapsed = (Date.now() - started) / 1000;
      const rate = e.loaded / elapsed;
      const eta = rate > 0 ? (e.total - e.loaded) / rate : NaN;
      detail.textContent =
        `${pct.toFixed(1)}% · ${fmtBytes(e.loaded)} of ${fmtBytes(e.total)} · ${fmtBytes(rate)}/s · ${fmtDuration(eta)} left`;
    });

    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        detail.textContent = 'Done';
        resolve(data);
      } else {
        reject(new Error(data.error || `Request failed (${xhr.status})`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload — connection dropped')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
    xhr.addEventListener('timeout', () => reject(new Error('Upload timed out')));

    xhr.open('POST', '/api/posts');
    xhr.timeout = 0; // a slow multi-GB upload is normal here
    xhr.send(fd);
  });
}

function showMsg(text, isError) {
  msg.hidden = false;
  msg.textContent = text;
  msg.className = `form-msg ${isError ? 'err' : 'ok'}`;
}

$('#storage-clean').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Cleaning…';
  try {
    const r = await api('/api/storage/cleanup', { method: 'POST' });
    await loadStatus();
    if (r.count === 0) alert('Nothing removed — the leftover files are still too fresh to be sure they are not uploading.');
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Clean up';
  }
});

/* ---------- post list ---------- */

// Statuses the server lets you edit (mirrors EDITABLE_STATUSES in db.js).
const EDITABLE = ['scheduled', 'failed', 'partial'];

const PLATFORMS = [
  { key: 'youtube', label: 'YouTube', box: '#posts-youtube' },
  { key: 'instagram', label: 'Instagram', box: '#posts-instagram' },
];

const platformLabel = (key) => PLATFORMS.find((p) => p.key === key)?.label ?? key;

// Filters act on the target status for the column the post is rendered in, so
// a post that published to YouTube but failed on Instagram sits under
// "Published" in one list and "Failed" in the other.
const FILTERS = [
  { key: 'pending', label: 'Pending', empty: 'Nothing pending for', match: (t) => t.status === 'pending' || t.status === 'processing' },
  { key: 'published', label: 'Published', empty: 'Nothing published to', match: (t) => t.status === 'done' },
  { key: 'failed', label: 'Failed', empty: 'Nothing failed on', match: (t) => t.status === 'failed' },
  { key: 'all', label: 'All', empty: 'Nothing scheduled for', match: () => true },
];

let filterKey = localStorage.getItem('ss-filter') || 'pending';
if (!FILTERS.some((f) => f.key === filterKey)) filterKey = 'pending';

// Kept so switching filters re-renders instantly instead of refetching.
let lastPosts = [];

function renderFilterChips() {
  const box = $('#filter-chips');
  box.innerHTML = '';
  for (const f of FILTERS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${f.key === filterKey ? ' is-on' : ''}`;
    chip.textContent = f.label;

    // A count on each chip means you can see there are failures without
    // having to click through every filter to find them.
    const n = lastPosts.reduce((sum, post) => sum + post.targets.filter(f.match).length, 0);
    if (n > 0 && f.key !== 'all') {
      const count = document.createElement('span');
      count.className = 'chip-count';
      count.textContent = ` ${n}`;
      chip.appendChild(count);
    }

    chip.onclick = () => {
      filterKey = f.key;
      localStorage.setItem('ss-filter', f.key);
      editingKey = null; // the card being edited may not survive the new filter
      renderPosts();
    };
    box.appendChild(chip);
  }
}

// In a per-platform list the post-level status is the wrong thing to show: a
// "partial" post is a success in one column and a failure in the other.
const TARGET_BADGE = {
  pending: { cls: 'scheduled', text: 'scheduled' },
  processing: { cls: 'processing', text: 'publishing' },
  done: { cls: 'done', text: 'published' },
  failed: { cls: 'failed', text: 'failed' },
};

// Which card is open in the inline editor, so the 10s refresh doesn't wipe it.
// Keyed by platform too: a post on both platforms is rendered twice, and only
// the card you clicked should turn into a form.
let editingKey = null;

async function loadPosts() {
  lastPosts = await api('/api/posts');
  renderPosts();
}

function renderPosts() {
  const filter = FILTERS.find((f) => f.key === filterKey);
  renderFilterChips();

  for (const { key, label, box } of PLATFORMS) {
    const el = $(box);
    const mine = lastPosts.filter((post) => post.targets.some((t) => t.platform === key));
    const shown = mine.filter((post) => filter.match(post.targets.find((t) => t.platform === key)));

    // Say what the filter is holding back, so an empty list is never a mystery.
    const hidden = mine.length - shown.length;
    el.innerHTML = '';

    if (shown.length === 0) {
      const msg = document.createElement('p');
      msg.className = 'hint';
      msg.textContent = hidden > 0
        ? `${filter.empty} ${label} — ${hidden} hidden by this filter.`
        : `${filter.empty} ${label}.`;
      el.appendChild(msg);
      continue;
    }

    for (const post of shown) el.appendChild(renderPost(post, key));
    if (hidden > 0) {
      const note = document.createElement('p');
      note.className = 'hint filtered-out';
      note.textContent = `${hidden} more hidden by the ${filter.label} filter`;
      el.appendChild(note);
    }
  }
}

function renderPost(post, platform) {
  const key = `${post.id}:${platform}`;
  if (key === editingKey) return renderEditForm(post);

  const target = post.targets.find((t) => t.platform === platform);
  const badge = TARGET_BADGE[target.status] ?? { cls: '', text: target.status };

  const el = document.createElement('div');
  el.className = 'post';

  const head = document.createElement('div');
  head.className = 'post-head';
  head.innerHTML = `
    <span class="post-title"></span>
    <span class="post-time"></span>
    <span class="badge ${badge.cls}">${badge.text}</span>
  `;
  head.querySelector('.post-title').textContent = post.title;
  head.querySelector('.post-time').textContent = new Date(post.scheduled_at).toLocaleString();
  el.appendChild(head);

  el.appendChild(renderFileLine(post));

  // The same post can sit in both lists; say so, so deleting from here is no surprise.
  const others = post.targets.filter((t) => t.platform !== platform);
  if (others.length > 0) {
    const note = document.createElement('p');
    note.className = 'hint post-note';
    note.textContent = `Also scheduled for ${others.map((t) => platformLabel(t.platform)).join(', ')}`;
    el.appendChild(note);
  }

  // Whatever this platform has to say for itself: a link, an error, or nothing yet.
  if (target.status === 'done' && target.result_url) {
    const a = document.createElement('a');
    a.className = 'post-result';
    a.href = target.result_url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = target.result_url;
    el.appendChild(a);
  } else if (target.status === 'failed') {
    const err = document.createElement('p');
    err.className = 'error post-result';
    err.textContent = target.error || 'failed';
    el.appendChild(err);
  }

  const actions = document.createElement('div');
  actions.className = 'post-actions';

  if (target.status === 'failed') {
    const retry = document.createElement('button');
    retry.className = 'btn small';
    retry.textContent = 'Retry failed';
    retry.onclick = async () => {
      await api(`/api/posts/${post.id}/retry`, { method: 'POST' }).catch((e) => alert(e.message));
      loadPosts();
    };
    actions.appendChild(retry);
  }
  if (EDITABLE.includes(post.status)) {
    const edit = document.createElement('button');
    edit.className = 'btn small';
    edit.textContent = 'Edit';
    edit.onclick = () => {
      editingKey = key;
      el.replaceWith(renderEditForm(post));
    };
    actions.appendChild(edit);
  }
  if (post.status !== 'processing') {
    const del = document.createElement('button');
    del.className = 'btn small danger';
    del.textContent = 'Delete';
    del.onclick = async () => {
      const also = others.length > 0
        ? ` This removes it from ${post.targets.map((t) => platformLabel(t.platform)).join(' and ')}.`
        : '';
      if (!confirm(`Delete "${post.title}"?${also}`)) return;
      await api(`/api/posts/${post.id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
      // Deleting frees the file too, so the disk figures are stale until we refetch.
      await loadPosts();
      await loadStatus();
    };
    actions.appendChild(del);
  }
  if (actions.children.length > 0) el.appendChild(actions);

  return el;
}

// Which file goes out with this post — a missing one is worth shouting about,
// since the upload will fail at publish time rather than now.
function renderFileLine(post) {
  const line = document.createElement('p');
  line.className = 'post-file';

  if (post.file_missing) {
    const gone = document.createElement('span');
    gone.className = 'error';
    gone.textContent = `${post.original_name} — file missing from the server`;
    line.appendChild(gone);
    return line;
  }

  const a = document.createElement('a');
  a.href = `/media/${post.file_name}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = post.original_name;
  line.appendChild(a);

  const meta = document.createElement('span');
  meta.className = 'post-file-meta';
  meta.textContent = [
    Number.isFinite(post.file_size) ? fmtBytes(post.file_size) : null,
    post.mime_type,
  ].filter(Boolean).join(' · ');
  line.appendChild(meta);

  return line;
}

function renderEditForm(post) {
  const el = document.createElement('form');
  el.className = 'post post-edit';

  el.innerHTML = `
    <label>
      Title
      <input type="text" name="title" maxlength="100" required />
    </label>
    <label>
      Description / caption
      <textarea name="description" rows="3"></textarea>
    </label>
    <label class="edit-when">
      Publish at
      <input type="datetime-local" name="scheduledAt" required />
    </label>
    <p class="hint edit-file"></p>
    <div class="post-actions">
      <button type="submit" class="btn small primary">Save</button>
      <button type="button" class="btn small" data-cancel>Cancel</button>
      <span class="form-msg err" hidden></span>
    </div>
  `;
  const fields = {
    title: el.querySelector('[name="title"]'),
    description: el.querySelector('[name="description"]'),
    scheduledAt: el.querySelector('[name="scheduledAt"]'),
  };
  fields.title.value = post.title;
  fields.description.value = post.description || '';
  fields.scheduledAt.value = toLocalInput(post.scheduled_at);
  // The file itself can't be swapped — re-upload for that — so say which one this edits.
  el.querySelector('.edit-file').textContent = `File: ${post.original_name} (unchanged)`;

  const err = el.querySelector('.form-msg');
  const close = async () => {
    editingKey = null;
    await loadPosts();
  };

  el.querySelector('[data-cancel]').onclick = close;
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const save = el.querySelector('button[type="submit"]');
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      await api(`/api/posts/${post.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: fields.title.value,
          description: fields.description.value,
          scheduledAt: new Date(fields.scheduledAt.value).toISOString(),
        }),
      });
      await close();
    } catch (e2) {
      err.hidden = false;
      err.textContent = e2.message;
      save.disabled = false;
      save.textContent = 'Save';
    }
  });

  return el;
}

/* ---------- boot ---------- */

renderFilterChips();
loadStatus().catch(console.error);
loadPosts().catch(console.error);
setInterval(() => {
  if (editingKey === null) loadPosts().catch(() => {});
}, 10000);
setInterval(() => loadStatus().catch(() => {}), 30000);
