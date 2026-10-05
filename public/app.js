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
    // A refresh token Google has rejected: the row goes red and the button
    // says reconnect, with the full reason in the hint below.
    const dead = Boolean(status.youtube.error);
    ytDot.className = dead ? 'dot err' : 'dot warn';
    ytState.textContent = dead ? 'access expired or revoked' : 'not connected';
    ytBtn.textContent = dead ? 'Reconnect YouTube' : 'Connect YouTube';
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
  if (status.youtube.error) {
    hint.hidden = false;
    hint.textContent = status.youtube.error;
  } else if (status.instagram.configured && !status.publicBaseUrl) {
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

// Instagram shows exactly one piece of text on a post, so it gets one field.
// YouTube has a real title and a separate description.
const PLATFORM_FIELDS = {
  youtube: {
    title: true,
    label: 'Description',
    placeholder: 'Optional description',
    maxlength: 5000,
  },
  instagram: {
    title: false,
    label: 'Caption',
    placeholder: 'The caption shown under the post — hashtags and all',
    maxlength: 2200,
  },
};

const platformSelect = $('#platform-select');

function applyPlatformFields() {
  const spec = PLATFORM_FIELDS[platformSelect.value];
  // Moving to a caption-only platform: keep whatever was typed as a title
  // rather than silently dropping it, since it is all one text over there.
  if (!spec.title && form.title.value.trim()) {
    form.description.value = [form.title.value.trim(), form.description.value]
      .filter((t) => t.trim())
      .join('\n\n');
    form.title.value = '';
  }
  $('#title-field').hidden = !spec.title;
  $('#text-label').textContent = spec.label;
  form.description.placeholder = spec.placeholder;
  form.description.maxLength = spec.maxlength;
}

platformSelect.addEventListener('change', applyPlatformFields);
applyPlatformFields();

// Keep a convenient starting value for the manual date picker.
const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
inOneHour.setSeconds(0, 0);
form.scheduledAt.value = toLocalInput(inOneHour);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.hidden = true;

  if (form.scheduleMode.value === 'next' && !suggestedSlot) return showMsg('Wait for an available slot, or choose a specific date and time.', true);
  const platforms = [platformSelect.value];
  if (PLATFORM_FIELDS[platformSelect.value].title && !form.title.value.trim()) {
    return showMsg('Title is required for YouTube', true);
  }

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

  if (!file) return showMsg('Choose a file first', true);
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes); // also available on the HTTP LAN site
  const job = {
    id: [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    file, title: form.title.value, description: form.description.value,
    platform: platformSelect.value, mode: form.scheduleMode.value,
    scheduledAt: form.scheduleMode.value === 'next' ? suggestedSlot.scheduledAt : new Date(form.scheduledAt.value).toISOString(),
    status: 'queued', detail: 'Waiting to upload', progress: 0,
  };
  uploadQueue.push(job);
  form.file.value = '';
  form.title.value = '';
  form.description.value = '';
  showMsg('Added to the upload queue. You can schedule the next video now.', false);
  renderUploadQueue();
  refreshNextSlot();
  processUploadQueue();
});

const uploadQueue = [];
let queueRunning = false;

function renderUploadQueue() {
  $('#upload-queue').hidden = uploadQueue.length === 0;
  const list = $('#upload-queue-list');
  list.innerHTML = '';
  for (const job of uploadQueue) {
    const row = document.createElement('div');
    row.className = 'post upload-job';
    const name = document.createElement('strong');
    name.textContent = job.fileName || job.file.name;
    const when = document.createElement('p');
    when.className = 'hint';
    when.textContent = `${platformLabel(job.platform)} · ${new Date(job.scheduledAt).toLocaleString()}`;
    const detail = document.createElement('p');
    detail.className = `hint${job.status === 'failed' ? ' error' : ''}`;
    detail.textContent = job.detail;
    row.append(name, when, detail);
    if (job.status === 'uploading') {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.width = `${job.progress}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
    }
    const actions = document.createElement('div');
    actions.className = 'post-actions';
    if (job.status === 'failed') {
      const retry = document.createElement('button');
      retry.className = 'btn small';
      retry.textContent = 'Retry upload';
      retry.onclick = () => {
        job.status = 'queued';
        job.detail = 'Waiting to retry';
        renderUploadQueue();
        refreshNextSlot();
        processUploadQueue();
      };
      actions.appendChild(retry);
    }
    if (job.status !== 'uploading') {
      const remove = document.createElement('button');
      remove.className = 'btn small';
      remove.textContent = job.status === 'done' ? 'Dismiss' : 'Remove';
      remove.onclick = () => {
        uploadQueue.splice(uploadQueue.indexOf(job), 1);
        renderUploadQueue();
        refreshNextSlot();
      };
      actions.appendChild(remove);
    }
    row.appendChild(actions);
    list.appendChild(row);
  }
}

async function processUploadQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    let job;
    while ((job = uploadQueue.find((item) => item.status === 'queued'))) {
      job.status = 'uploading';
      job.detail = 'Starting upload…';
      job.progress = 0;
      renderUploadQueue();
      const fd = new FormData();
      fd.append('file', job.file);
      fd.append('title', job.title);
      fd.append('description', job.description);
      fd.append('platforms', job.platform);
      fd.append('scheduleMode', job.mode);
      fd.append('scheduledAt', job.scheduledAt);
      fd.append('uploadId', job.id);
      try {
        const created = await uploadWithProgress(fd, job);
        job.status = 'done';
        job.scheduledAt = created.scheduled_at;
        job.detail = `Scheduled ✔${created.warnings?.length ? ' — ' + created.warnings.join(' · ') : ''}`;
        job.fileName = job.file.name;
        job.file = null; // release the completed file reference
      } catch (error) {
        job.status = 'failed';
        job.detail = error.message;
      }
      renderUploadQueue();
      // A refresh failure must not turn a successful upload into a failed job.
      await Promise.allSettled([loadPosts(), loadStatus(), refreshNextSlot()]);
    }
  } finally {
    queueRunning = false;
  }
}

window.addEventListener('beforeunload', (event) => {
  if (uploadQueue.some((job) => job.status !== 'done')) {
    event.preventDefault();
    event.returnValue = '';
  }
});

function uploadWithProgress(fd, job) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const started = Date.now();
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      job.progress = (event.loaded / event.total) * 100;
      const rate = event.loaded / ((Date.now() - started) / 1000);
      job.detail = job.progress >= 100 ? 'Upload received; checking file and saving schedule…' :
        `${job.progress.toFixed(1)}% · ${fmtBytes(event.loaded)} of ${fmtBytes(event.total)} · ${fmtBytes(rate)}/s · ${fmtDuration(rate > 0 ? (event.total - event.loaded) / rate : NaN)} left`;
      renderUploadQueue();
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* proxy error */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Request failed (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('Connection dropped. Retry to finish this upload safely.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
    xhr.addEventListener('timeout', () => reject(new Error('Upload timed out')));
    xhr.open('POST', '/api/posts');
    xhr.timeout = 0;
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

// Instagram posts carry only a caption, so the card names them by its first
// line instead of showing an empty heading.
function postHeading(post) {
  if (post.title) return post.title;
  const line = (post.description || '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return '(no caption)';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

// What Instagram will actually show, matching how the scheduler builds it.
const captionOf = (post) => [post.title, post.description].filter(Boolean).join('\n\n');

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
  await refreshNextSlot();
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

  // Bulk-reschedule buttons and any open preview track the same data.
  for (const { key } of PLATFORMS) reschedUI[key]?.update();
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
  head.querySelector('.post-title').textContent = postHeading(post);
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

  // An Instagram-only post is edited as the single caption it really is —
  // including any text that was typed into Title before this was a dropdown.
  const captionOnly = post.targets.every((t) => t.platform === 'instagram');

  el.innerHTML = `
    <label${captionOnly ? ' hidden' : ''}>
      Title
      <input type="text" name="title" maxlength="100" />
    </label>
    <label>
      ${captionOnly ? 'Caption' : 'Description'}
      <textarea name="description" rows="3" maxlength="${captionOnly ? 2200 : 5000}"></textarea>
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
  fields.description.value = captionOnly ? captionOf(post) : (post.description || '');
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
          // Caption-only posts fold everything into the description, so the
          // text in the box is exactly what gets published.
          title: captionOnly ? '' : fields.title.value,
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

/* ---------- reschedule all ---------- */

// "3× per week" and friends map onto a spread of weekdays; the checkboxes stay
// editable for people whose week doesn't match ours.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // the checkbox row runs Mon..Sun
const CADENCE_DAYS = {
  1: [6],
  2: [2, 6],
  3: [1, 3, 5],
  4: [0, 1, 3, 5],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 5, 6],
  7: [0, 1, 2, 3, 4, 5, 6],
};

const ORDER_SORTS = {
  keep: { label: 'Keep current order', sort: (posts) => posts },
  oldest: {
    label: 'Oldest upload first',
    sort: (posts) => [...posts].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id),
  },
  newest: {
    label: 'Newest upload first',
    sort: (posts) => [...posts].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id),
  },
  shuffle: { label: 'Shuffle', sort: null }, // stable per-panel shuffle, handled in update()
};

// Only posts still waiting to go out can be bulk-moved; soonest first, so the
// publish order you already arranged is what gets re-spaced.
const reschedulable = (platform) =>
  lastPosts
    .filter((p) => p.status === 'scheduled' && p.targets.some((t) => t.platform === platform && t.status === 'pending'))
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at) || a.id - b.id);

// One future Date per post: walk forward from the start date, taking every
// ticked weekday at the chosen time and skipping anything already in the past.
function computeSlots(count, days, time, startStr) {
  if (days.length === 0 || !/^\d{2}:\d{2}/.test(time || '')) return null;
  const cur = new Date(`${startStr}T00:00:00`);
  if (Number.isNaN(cur.getTime())) return null;
  const [h, m] = time.split(':').map(Number);
  cur.setHours(h, m, 0, 0);
  const now = Date.now();
  const slots = [];
  while (slots.length < count) {
    if (days.includes(cur.getDay()) && cur.getTime() > now) slots.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return slots;
}

const fmtSlot = (d) =>
  d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const reschedUI = {};

function initResched(platform) {
  const btn = $(`#resched-btn-${platform}`);
  const panel = $(`#resched-${platform}`);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(`ss-resched-${platform}`)) || {}; } catch { /* stale */ }

  panel.innerHTML = `
    <form>
      <div class="row">
        <label>How often
          <select name="cadence">
            ${[1, 2, 3, 4, 5, 6, 7].map((n) => `<option value="${n}">${n === 7 ? 'Every day' : `${n}\u00d7 per week`}</option>`).join('')}
            <option value="custom">Custom days</option>
          </select>
        </label>
        <label>Post at
          <input type="time" name="time" required />
        </label>
        <label>Starting
          <input type="date" name="start" required />
        </label>
      </div>
      <fieldset class="resched-days">
        <legend>On days</legend>
        ${DAY_ORDER.map((d) => `<label class="day-pick"><input type="checkbox" value="${d}" />${DAY_NAMES[d]}</label>`).join('')}
      </fieldset>
      <div class="row">
        <label class="resched-order">Order
          <select name="order">
            ${Object.entries(ORDER_SORTS).map(([k, o]) => `<option value="${k}">${o.label}</option>`).join('')}
          </select>
        </label>
        <button type="button" class="btn small" data-reshuffle hidden>Shuffle again</button>
      </div>
      <div class="resched-preview"></div>
      <p class="hint resched-summary"></p>
      <p class="hint resched-warn error" hidden></p>
      <div class="post-actions">
        <button type="submit" class="btn small primary" data-apply>Apply new schedule</button>
        <button type="button" class="btn small" data-close>Cancel</button>
        <span class="form-msg err" hidden></span>
      </div>
    </form>
  `;

  const el = (sel) => panel.querySelector(sel);
  const els = {
    form: el('form'),
    cadence: el('[name="cadence"]'),
    time: el('[name="time"]'),
    start: el('[name="start"]'),
    order: el('[name="order"]'),
    days: [...panel.querySelectorAll('.resched-days input')],
    reshuffle: el('[data-reshuffle]'),
    preview: el('.resched-preview'),
    summary: el('.resched-summary'),
    warn: el('.resched-warn'),
    apply: el('[data-apply]'),
    msg: el('.form-msg'),
  };

  const setDays = (days) => els.days.forEach((c) => { c.checked = days.includes(Number(c.value)); });
  els.cadence.value = String(saved.cadence ?? 3);
  if (!els.cadence.value) els.cadence.value = '3'; // saved value is no longer an option
  els.time.value = saved.time || '18:00';
  els.order.value = saved.order && ORDER_SORTS[saved.order] ? saved.order : 'keep';
  setDays(Array.isArray(saved.days) ? saved.days : CADENCE_DAYS[3]);

  const shuffleRank = new Map();
  let pending = []; // the { id, scheduledAt } changes the preview currently shows

  function update() {
    const posts = reschedulable(platform);
    btn.hidden = posts.length === 0;
    if (posts.length === 0) panel.hidden = true;
    if (panel.hidden) return;

    const days = els.days.filter((c) => c.checked).map((c) => Number(c.value));
    const slots = computeSlots(posts.length, days, els.time.value, els.start.value);
    els.apply.disabled = !slots;
    els.reshuffle.hidden = els.order.value !== 'shuffle';
    if (!slots) {
      pending = [];
      els.preview.innerHTML = '';
      els.summary.textContent = 'Tick at least one day (and set a time and start date) to see the new schedule.';
      els.warn.hidden = true;
      return;
    }

    let ordered;
    if (els.order.value === 'shuffle') {
      for (const p of posts) if (!shuffleRank.has(p.id)) shuffleRank.set(p.id, Math.random());
      ordered = [...posts].sort((a, b) => shuffleRank.get(a.id) - shuffleRank.get(b.id));
    } else {
      ordered = ORDER_SORTS[els.order.value].sort(posts);
    }
    pending = ordered.map((p, i) => ({ id: p.id, scheduledAt: slots[i].toISOString() }));

    els.preview.innerHTML = '';
    ordered.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'resched-line';
      const name = document.createElement('span');
      name.className = 'resched-name';
      name.textContent = postHeading(p);
      const when = document.createElement('span');
      when.className = 'resched-when';
      when.append(`${fmtSlot(new Date(p.scheduled_at))} \u2192 `);
      const b = document.createElement('b');
      b.textContent = fmtSlot(slots[i]);
      when.append(b);
      row.append(name, when);
      els.preview.appendChild(row);
    });

    els.summary.textContent =
      `${posts.length} post${posts.length === 1 ? '' : 's'} \u00b7 ${days.length}\u00d7 per week \u00b7 ` +
      (posts.length === 1 ? `lands ${fmtDay(slots[0])}` : `${fmtDay(slots[0])} \u2013 ${fmtDay(slots[slots.length - 1])}`);

    const elsewhere = ordered.filter((p) => p.targets.some((t) => t.platform !== platform)).length;
    els.warn.hidden = elsewhere === 0;
    if (elsewhere > 0) {
      els.warn.textContent = `${elsewhere} of these also target another platform and will move there too.`;
    }
  }

  els.cadence.addEventListener('change', () => {
    if (els.cadence.value !== 'custom') setDays(CADENCE_DAYS[Number(els.cadence.value)]);
    update();
  });
  for (const c of els.days) {
    c.addEventListener('change', () => {
      els.cadence.value = 'custom';
      update();
    });
  }
  for (const input of [els.time, els.start, els.order]) input.addEventListener('change', update);
  els.reshuffle.addEventListener('click', () => { shuffleRank.clear(); update(); });

  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      els.start.value = toLocalInput(new Date()).slice(0, 10);
      els.msg.hidden = true;
      update();
    }
  });
  el('[data-close]').addEventListener('click', () => { panel.hidden = true; });

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pending.length === 0) return;
    els.msg.hidden = true;
    els.apply.disabled = true;
    els.apply.textContent = 'Applying\u2026';
    try {
      const r = await api('/api/posts/reschedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: pending }),
      });
      localStorage.setItem(`ss-resched-${platform}`, JSON.stringify({
        cadence: els.cadence.value,
        time: els.time.value,
        order: els.order.value,
        days: els.days.filter((c) => c.checked).map((c) => Number(c.value)),
      }));
      panel.hidden = true;
      await loadPosts();
      if (r.skipped > 0) alert(`${r.skipped} post(s) could not be moved \u2014 they were being published while you rescheduled.`);
    } catch (err) {
      els.msg.hidden = false;
      els.msg.textContent = err.message;
    } finally {
      els.apply.disabled = false;
      els.apply.textContent = 'Apply new schedule';
    }
  });

  reschedUI[platform] = { update };
}

/* ---------- posting schedule settings and suggestions ---------- */

let suggestedSlot = null;
let slotRequest = 0;

function updateScheduleButton() {
  $('#submit-btn').disabled = (form.scheduleMode.value === 'next' && !suggestedSlot);
}

function applyScheduleMode() {
  const manual = form.scheduleMode.value === 'manual';
  $('#manual-schedule').hidden = !manual;
  $('#next-slot-panel').hidden = manual;
  form.scheduledAt.disabled = !manual;
  form.scheduledAt.required = manual;
  updateScheduleButton();
}

async function refreshNextSlot() {
  const request = ++slotRequest;
  suggestedSlot = null;
  updateScheduleButton();
  $('#next-slot').textContent = 'Finding next available slot…';
  try {
    const slot = await api('/api/next-slot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: platformSelect.value,
        heldSlots: uploadQueue.filter((job) => job.platform === platformSelect.value && job.status !== 'done')
          .map((job) => job.scheduledAt),
      }),
    });
    if (request !== slotRequest) return;
    suggestedSlot = slot;
    const when = new Date(slot.scheduledAt).toLocaleString(undefined, {
      timeZone: slot.timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    $('#next-slot').textContent = `Next available: ${when} (${slot.timezone})`;
  } catch (err) {
    if (request !== slotRequest) return;
    $('#next-slot').textContent = `Could not find a slot: ${err.message}. Retry or pick a specific date and time.`;
  }
  updateScheduleButton();
}

form.scheduleMode.addEventListener('change', () => {
  applyScheduleMode();
  refreshNextSlot();
});
platformSelect.addEventListener('change', refreshNextSlot);
$('#refresh-slot').addEventListener('click', refreshNextSlot);
$('#configure-schedule').addEventListener('click', () => {
  $('#posting-settings').open = true;
  $('#settings').scrollIntoView({ behavior: 'smooth' });
});
$('#manual-timezone').textContent = `Your browser timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
applyScheduleMode();

async function loadPostingSchedule() {
  const message = $('#settings-msg');
  try {
    const schedule = await api('/api/settings/posting-schedule');
    const fields = $('#posting-schedule-fields');
    fields.innerHTML = '';
    for (const { key, label } of PLATFORMS) {
      const spec = schedule[key];
      const group = document.createElement('fieldset');
      group.className = 'posting-platform';
      group.dataset.platform = key;
      group.innerHTML = `
        <legend>${label}</legend>
        <div class="posting-days">
          ${DAY_ORDER.map((day) => `<label class="day-pick"><input type="checkbox" value="${day}" />${DAY_NAMES[day]}</label>`).join('')}
        </div>
        <div class="row">
          <label>Post at<input type="time" name="time" required /></label>
          <label>Timezone<input type="text" name="timezone" list="posting-timezones" placeholder="Europe/Stockholm" required /></label>
        </div>`;
      group.querySelectorAll('input[type="checkbox"]').forEach((box) => { box.checked = spec.days.includes(Number(box.value)); });
      group.querySelector('[name="time"]').value = spec.time;
      group.querySelector('[name="timezone"]').value = spec.timezone;
      fields.appendChild(group);
    }
    const zones = document.createElement('datalist');
    zones.id = 'posting-timezones';
    const availableZones = typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone') : ['Europe/Stockholm', 'UTC'];
    for (const zone of new Set(['UTC', ...availableZones])) {
      const option = document.createElement('option');
      option.value = zone;
      zones.appendChild(option);
    }
    fields.appendChild(zones);
    $('#save-schedule').disabled = false;
  } catch (err) {
    $('#posting-settings').open = true;
    message.hidden = false;
    message.className = 'form-msg err';
    message.textContent = `Could not load posting settings: ${err.message}. Reload to try again.`;
  }
}

$('#posting-schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#settings-msg');
  const button = $('#save-schedule');
  message.hidden = true;
  const schedule = {};
  for (const group of document.querySelectorAll('.posting-platform')) {
    schedule[group.dataset.platform] = {
      days: [...group.querySelectorAll('input[type="checkbox"]:checked')].map((box) => Number(box.value)),
      time: group.querySelector('[name="time"]').value,
      timezone: group.querySelector('[name="timezone"]').value.trim(),
    };
  }
  button.disabled = true;
  try {
    await api('/api/settings/posting-schedule', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(schedule),
    });
    message.className = 'form-msg ok';
    message.textContent = 'Posting schedule saved. Existing posts keep their dates.';
    await refreshNextSlot();
  } catch (err) {
    message.className = 'form-msg err';
    message.textContent = err.message;
  } finally {
    message.hidden = false;
    button.disabled = false;
  }
});

/* ---------- boot ---------- */

renderFilterChips();
for (const { key } of PLATFORMS) initResched(key);
loadPostingSchedule();
refreshNextSlot();
loadStatus().catch(console.error);
loadPosts().catch(console.error);
setInterval(() => {
  if (editingKey === null) loadPosts().catch(() => {});
}, 10000);
setInterval(() => loadStatus().catch(() => {}), 30000);
