const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [
  ...parent.querySelectorAll(selector),
];
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const icons = {
  library:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="16" cy="17" r="3" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload:
    '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  spark:
    '<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z"/>',
  video:
    '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  youtube:
    '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 5 3-5 3Z"/>',
  instagram:
    '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17 7h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = (name, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.library}</svg>`;
$$('[data-icon]').forEach((el) => {
  el.innerHTML = icon(el.dataset.icon);
});
const names = { youtube: 'YouTube', instagram: 'Instagram' };
const badge = (p) => `<span class="badge ${p}">${icon(p)}${names[p]}</span>`;
const size = (bytes) =>
  bytes == null
    ? 'Missing file'
    : bytes < 1024 ** 2
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : bytes < 1024 ** 3
        ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
        : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateText = (value, timezone = zone) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
const localInput = (value) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const uid = () =>
  globalThis.crypto?.randomUUID?.() ||
  `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const state = {
  media: [],
  posts: [],
  status: null,
  routine: null,
  selected: new Set(),
  platform: 'all',
  postFilter: 'upcoming',
  view: 'library',
  loaded: false,
};
let dialogBusy = false;
let toastTimer;
async function api(path, { body, ...options } = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({
    error: 'The server returned an unexpected response. Please try again.',
  }));
  if (!response.ok)
    throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${error ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      el.hidden = true;
    },
    error ? 8000 : 4500,
  );
}
function releaseDialogVideos() {
  $$('video', $('#dialog')).forEach((video) => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  });
}
function showDialog(title, eyebrow, content, wide = false) {
  releaseDialogVideos();
  if ($('#dialog').open) $('#dialog').close();
  $('#dialog-title').textContent = title;
  $('#dialog-eyebrow').textContent = eyebrow;
  $('#dialog-content').innerHTML = content;
  $('#dialog').classList.toggle('wide', wide);
  dialogBusy = false;
  $('#close-dialog').disabled = false;
  $('#dialog').showModal();
}
function closeDialog() {
  if (!dialogBusy) $('#dialog').close();
}
$('#close-dialog').onclick = closeDialog;
$('#dialog').addEventListener('close', () => {
  // A delayed close event can arrive after another dialog has opened.
  if (!$('#dialog').open) releaseDialogVideos();
});
$('#dialog').addEventListener('cancel', (event) => {
  if (dialogBusy) event.preventDefault();
});
function busyDialog(value) {
  dialogBusy = value;
  $('#close-dialog').disabled = value;
}
function dialogError(message) {
  const el = $('#dialog-error');
  if (el) {
    el.textContent = message;
    el.hidden = false;
    el.scrollIntoView({ block: 'nearest' });
  }
}
const errorBox =
  '<div id="dialog-error" class="notice error" role="alert" hidden></div>';
function go(view) {
  location.hash = view;
  navigate();
}
function navigate() {
  const previous = state.view;
  const view = location.hash.slice(1);
  state.view = ['library', 'schedule', 'settings'].includes(view)
    ? view
    : 'library';
  $$('.view').forEach((el) => {
    el.hidden = el.id !== `view-${state.view}`;
  });
  $$('[data-nav]').forEach((el) => {
    const active = el.dataset.nav === state.view;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  const title = {
    library: 'Media library',
    schedule: 'Schedule',
    settings: 'Settings',
  }[state.view];
  $('#breadcrumb').textContent = title;
  document.title = `${title} · Social Scheduler`;
  if (previous !== state.view) window.scrollTo({ top: 0, behavior: 'instant' });
}
window.addEventListener('hashchange', navigate);
navigate();
async function refreshData() {
  const [media, posts] = await Promise.all([
    api('/api/media'),
    api('/api/posts'),
  ]);
  state.media = media;
  state.posts = posts;
  state.loaded = true;
  for (const id of state.selected)
    if (!media.some((m) => m.id === id)) state.selected.delete(id);
  renderLibrary();
  renderPosts();
  $('#page-error').hidden = true;
}
async function refreshStatus() {
  const [status, routine] = await Promise.all([
    api('/api/status'),
    api('/api/settings/posting-schedule'),
  ]);
  state.status = status;
  state.routine = routine;
  renderSettings();
}
const summary = (count, label, glyph) =>
  `<div class="summary-item"><div class="summary-icon">${icon(glyph)}</div><div><div class="summary-number">${count}</div><div class="summary-label">${label}</div></div></div>`;
function filteredMedia() {
  const search = $('#library-search').value.trim().toLowerCase();
  return state.media.filter(
    (m) =>
      (state.platform === 'all' ||
        (state.platform === 'none'
          ? !m.platforms.length
          : m.platforms.includes(state.platform))) &&
      (!search ||
        `${m.original_name} ${m.title} ${m.description}`
          .toLowerCase()
          .includes(search)) &&
      ($('#media-kind').value === 'all' ||
        m.mime_type.startsWith(`${$('#media-kind').value}/`)) &&
      ($('#media-state').value === 'all' ||
        ($('#media-state').value === 'unused'
          ? m.post_count === 0
          : m.post_count > 0)),
  );
}
function empty(title, copy, action, button, glyph = 'library') {
  return `<div class="empty-state"><div class="empty-art">${icon(glyph)}</div><h3>${title}</h3><p>${copy}</p>${button ? `<button class="btn primary" data-action="${action}">${icon('plus')}${button}</button>` : ''}</div>`;
}
function renderLibrary() {
  $('#library-count').textContent = state.media.length;
  $('#media-total').textContent = state.media.length;
  $('#library-summary').innerHTML =
    summary(state.media.length, 'Files in your library', 'library') +
    summary(
      state.media.filter((m) => !m.post_count).length,
      'Not scheduled yet',
      'spark',
    ) +
    summary(
      state.posts.filter((p) => ['scheduled', 'processing'].includes(p.status))
        .length,
      'Posts coming up',
      'calendar',
    );
  $('#platform-tabs').innerHTML = [
    ['all', 'All files'],
    ['youtube', 'YouTube'],
    ['instagram', 'Instagram'],
    ['none', 'Uncategorized'],
  ]
    .map(
      ([key, label]) =>
        `<button data-filter="${key}" class="${state.platform === key ? 'active' : ''}" aria-pressed="${state.platform === key}">${label}<span>${state.media.filter((m) => key === 'all' || (key === 'none' ? !m.platforms.length : m.platforms.includes(key))).length}</span></button>`,
    )
    .join('');
  const visible = filteredMedia();
  $('#visible-count').textContent = `(${visible.length})`;
  $('#select-all').checked =
    visible.length > 0 && visible.every((m) => state.selected.has(m.id));
  $('#select-all').indeterminate =
    visible.some((m) => state.selected.has(m.id)) && !$('#select-all').checked;
  $('#select-all').disabled = !visible.length;
  $('#media-grid').innerHTML = visible.length
    ? visible.map(mediaCard).join('')
    : state.media.length
      ? empty(
          'No files found',
          'Try another search or filter to find what you’re looking for.',
          'reset-filters',
          'Reset filters',
          'search',
        )
      : empty(
          'No files uploaded',
          'Upload videos or images to save in the library or schedule for publishing.',
          'upload',
          'Upload files',
        );
  updateSelection();
}
function mediaCard(m) {
  const video = m.mime_type.startsWith('video/');
  const url = `/media/${encodeURIComponent(m.file_name)}`;
  return `<article class="media-card${state.selected.has(m.id) ? ' selected' : ''}" data-media="${m.id}"><div class="media-cover"><button data-detail="${m.id}" aria-label="Preview ${esc(m.original_name)}">${icon(video ? 'video' : 'image', 'file-placeholder')}${!m.file_missing ? (video ? '' : `<img src="${url}" alt="" loading="lazy" />`) : ''}</button><label class="media-check"><input type="checkbox" data-select="${m.id}" aria-label="Select ${esc(m.original_name)}" ${state.selected.has(m.id) ? 'checked' : ''} /></label><span class="media-type">${video ? 'Video' : 'Image'}</span></div><div class="media-body"><button class="file-title" data-detail="${m.id}" title="${esc(m.original_name)}">${esc(m.original_name)}</button><p class="file-meta${m.file_missing ? ' missing' : ''}">${size(m.file_size)} · ${new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p><div class="badges">${m.platforms.length ? m.platforms.map(badge).join('') : '<span class="badge">Uncategorized</span>'}</div></div><div class="media-footer"><span>${m.post_count ? `Used in ${m.post_count} post${m.post_count === 1 ? '' : 's'}` : 'Not scheduled yet'}</span><button data-schedule="${m.id}" ${m.file_missing ? 'disabled' : ''}>Schedule →</button></div></article>`;
}
function updateSelection() {
  $('#selection-bar').hidden = !state.selected.size;
  $('#selection-count').textContent =
    `${state.selected.size} file${state.selected.size === 1 ? '' : 's'} selected`;
}
$('#platform-tabs').onclick = (event) => {
  const button = event.target.closest('[data-filter]');
  if (button) {
    state.platform = button.dataset.filter;
    renderLibrary();
  }
};
$('#library-search').oninput = renderLibrary;
$('#media-kind').onchange = renderLibrary;
$('#media-state').onchange = renderLibrary;
$('#select-all').onchange = (event) => {
  filteredMedia().forEach((m) =>
    event.target.checked
      ? state.selected.add(m.id)
      : state.selected.delete(m.id),
  );
  renderLibrary();
};
$('#clear-selection').onclick = () => {
  state.selected.clear();
  renderLibrary();
};
$('#media-grid').onchange = (event) => {
  if (event.target.matches('[data-select]')) {
    const id = +event.target.dataset.select;
    event.target.checked ? state.selected.add(id) : state.selected.delete(id);
    event.target
      .closest('.media-card')
      .classList.toggle('selected', event.target.checked);
    const visible = filteredMedia();
    $('#select-all').checked = visible.every((m) => state.selected.has(m.id));
    $('#select-all').indeterminate =
      visible.some((m) => state.selected.has(m.id)) &&
      !$('#select-all').checked;
    updateSelection();
  }
};
$('#media-grid').onclick = (event) => {
  const detail = event.target.closest('[data-detail]');
  const schedule = event.target.closest('[data-schedule]');
  if (detail) openMedia(+detail.dataset.detail);
  if (schedule) openSchedule([+schedule.dataset.schedule]);
};
$('#schedule-selected').onclick = () => openSchedule([...state.selected]);
function resetFilters() {
  state.platform = 'all';
  $('#library-search').value = '';
  $('#media-kind').value = 'all';
  $('#media-state').value = 'all';
  renderLibrary();
}
document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'upload') openUpload();
  if (action === 'upload-schedule') openUpload([], true);
  if (action === 'pick-media') {
    go('library');
    resetFilters();
    toast('Select one or more files, then choose Schedule selected.');
  }
  if (action === 'reset-filters') resetFilters();
});
const categoryOptions = (selected = '', includeUncategorized = true) =>
  [
    ['', 'Uncategorized'],
    ['youtube', 'YouTube'],
    ['instagram', 'Instagram'],
    ['youtube,instagram', 'Both platforms'],
  ]
    .filter(([value]) => includeUncategorized || value)
    .map(
      ([value, label]) =>
        `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`,
    )
    .join('');
const categoryValue = (platforms) =>
  ['youtube', 'instagram'].filter((p) => platforms.includes(p)).join(',');
const chosenPlatforms = (value) => (value ? value.split(',') : []);

// Upload a batch one file at a time, keeping each successful file even if another fails.
const uploadJobs = [];
let uploading = false;
let refreshUploadPreview = null;
function openUpload(initial = [], scheduleImmediately = false) {
  const files = [];
  let schedule = false;
  let scheduleMode = 'auto';
  let previewVersion = 0;
  let previewReady = false;
  let previewInFlight = false;
  let previewPending = false;
  showDialog(
    'Upload your files.',
    'UPLOAD OPTIONS',
    `<p class="dialog-copy">Keep files in your library, or choose publishing dates as you upload.</p>
    <label class="field">Upload mode<select id="upload-mode"><option value="library">Save to library</option><option value="schedule">Upload & schedule</option></select></label>
    <label class="field">Platform<select id="upload-category">${categoryOptions(state.platform === 'youtube' || state.platform === 'instagram' ? state.platform : '')}</select><span class="muted">Apply a platform to all files, then adjust individual files below.</span></label>
    <label class="drop-zone" id="drop-zone">${icon('upload')}<strong>Drop your videos and images here</strong><span>or choose files from your device</span><input id="upload-files" type="file" accept="video/*,image/*" multiple /></label>
    <div id="upload-date-default" hidden><label class="field">Publishing time<select id="upload-schedule-mode"><option value="auto">Next available slot</option><option value="manual">Choose a date and time</option></select></label><p id="upload-next-info" class="notice">Suggested dates below follow each platform’s posting routine and timezone. They may change if another post takes a slot or an upload runs past it. Final dates appear in Schedule.</p><button id="refresh-upload-slots" type="button" class="btn small">Refresh dates</button><label id="upload-manual-date" class="field" hidden>Default publishing date<input id="upload-date" type="datetime-local" value="${localInput(Date.now() + 86400000)}" /><span class="muted">${esc(zone)}. Applies to all files; you can change each date below.</span></label><p class="notice">Files are scheduled automatically after uploading. Keep this tab open until the queue finishes. Your files also stay in the library.</p></div>
    <div id="upload-files-list"></div>${errorBox}<div class="form-footer"><p id="upload-help">Saved to your library. No publishing date needed.</p><button id="start-upload" class="btn primary" disabled>Upload files</button></div>`,
  );
  function defaultPlatform(file) {
    return (
      $('#upload-category').value ||
      (schedule
        ? file.type.startsWith('image/')
          ? 'instagram'
          : 'youtube'
        : '')
    );
  }
  function renderFiles() {
    $('#upload-files-list').innerHTML = files
      .map(
        (entry, i) => `
      <section class="${schedule ? 'review-card' : ''}">
        <div class="upload-file-row">${icon(entry.file.type.startsWith('image/') ? 'image' : 'video')}<div class="file-info"><strong>${esc(entry.file.name)}</strong><small>${size(entry.file.size)}</small></div><select data-file-category="${i}" aria-label="Platform for ${esc(entry.file.name)}">${categoryOptions(entry.category, !schedule)}</select><button type="button" class="icon-btn" data-remove-file="${i}" aria-label="Remove ${esc(entry.file.name)}">✕</button></div>
        ${
          schedule
            ? `${
                scheduleMode === 'manual'
                  ? `<label class="field">Publish at<input type="datetime-local" data-upload-field="date" data-file-index="${i}" value="${esc(entry.date)}" required /><span class="muted">${esc(zone)}</span></label>`
                  : `<div data-upload-slots="${i}" aria-live="polite"><p class="review-date">Finding next available dates…</p></div>`
              }
        ${chosenPlatforms(entry.category).includes('youtube') ? `<label class="field">YouTube title<input type="text" data-upload-field="title" data-file-index="${i}" maxlength="100" value="${esc(entry.title)}" required /></label><label class="field">YouTube description<textarea data-upload-field="description" data-file-index="${i}" rows="2">${esc(entry.description)}</textarea></label>` : ''}
        ${chosenPlatforms(entry.category).includes('instagram') ? `<label class="field">Instagram caption<textarea data-upload-field="caption" data-file-index="${i}" rows="2">${esc(entry.caption)}</textarea></label>` : ''}`
            : ''
        }
      </section>`,
      )
      .join('');
    $('#start-upload').disabled =
      !files.length || (schedule && scheduleMode === 'auto');
    $('#start-upload').textContent = schedule
      ? `Upload & schedule${files.length ? ` ${files.length} file${files.length === 1 ? '' : 's'}` : ''}`
      : files.length
        ? `Upload ${files.length} file${files.length === 1 ? '' : 's'}`
        : 'Upload files';
    refreshPreviews();
  }
  const uploadList = $('#upload-files-list');
  async function refreshPreviews(background = false) {
    if (previewInFlight) {
      if (!background) {
        previewPending = true;
        previewReady = false;
        ++previewVersion;
      }
      return;
    }
    const version = ++previewVersion;
    const keepDates = background && previewReady;
    if (!keepDates) previewReady = false;
    if (!uploadList.isConnected || !$('#dialog').open) return;
    const automatic = schedule && scheduleMode === 'auto';
    $('#refresh-upload-slots').hidden = !automatic;
    if (!automatic || !files.length) return;
    previewInFlight = true;
    if (!keepDates) $('#start-upload').disabled = true;
    $('#refresh-upload-slots').disabled = true;
    if (!keepDates) $$('[data-upload-slots]', uploadList).forEach((el) => {
      el.innerHTML = '<p class="review-date">Finding next available dates…</p>';
    });
    const heldSlots = { youtube: [], instagram: [] };
    for (const job of uploadJobs) {
      if (
        !job.schedule ||
        !['queued', 'uploading', 'scheduling'].includes(job.status)
      )
        continue;
      if (job.scheduleMode === 'manual') {
        chosenPlatforms(job.category).forEach((platform) =>
          heldSlots[platform].push(job.scheduledAt),
        );
      } else {
        for (const slot of job.previewSlots || [])
          heldSlots[slot.platform].push(slot.scheduledAt);
      }
    }
    const platforms = files.flatMap((entry) => chosenPlatforms(entry.category));
    const current = () =>
      version === previewVersion && uploadList.isConnected && $('#dialog').open;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const { slots } = await api('/api/next-slots', {
        method: 'POST',
        body: { platforms, heldSlots },
        signal: controller.signal,
      });
      if (!current()) return;
      let offset = 0;
      files.forEach((entry, i) => {
        entry.previewSlots = slots.slice(
          offset,
          offset + chosenPlatforms(entry.category).length,
        );
        offset += entry.previewSlots.length;
        $(`[data-upload-slots="${i}"]`, uploadList).innerHTML =
          entry.previewSlots
            .map(
              (slot) =>
                `<p class="review-date" data-slot-platform="${slot.platform}" data-slot-date="${slot.scheduledAt}">${icon('calendar')} ${names[slot.platform]} · ${esc(dateText(slot.scheduledAt, slot.timezone))} · ${esc(slot.timezone)}</p>`,
            )
            .join('');
      });
      previewReady = true;
      $('#start-upload').disabled = false;
    } catch (err) {
      if (!current() || keepDates) return;
      const message = controller.signal.aborted
        ? 'The date lookup timed out. Please try again.'
        : err.message;
      $$('[data-upload-slots]', uploadList).forEach((el) => {
        el.innerHTML = `<p class="notice error">Couldn’t load dates. ${esc(message)} Use Refresh dates to try again.</p>`;
      });
    } finally {
      clearTimeout(timeout);
      previewInFlight = false;
      if (current()) $('#refresh-upload-slots').disabled = false;
      if (previewPending) {
        previewPending = false;
        refreshPreviews();
      }
    }
  }
  $('#refresh-upload-slots').onclick = () => refreshPreviews();
  refreshUploadPreview = () => refreshPreviews(true);
  const previewTimer = setInterval(() => {
    if (!uploadList.isConnected || !$('#dialog').open) {
      clearInterval(previewTimer);
      return;
    }
    if (!document.hidden) refreshPreviews(true);
  }, 30000);
  function addFiles(incoming) {
    const errors = [];
    for (const file of incoming) {
      if (!/^(video|image)\//.test(file.type)) {
        errors.push(`${file.name}: choose a video or image.`);
        continue;
      }
      if (
        state.status?.maxUploadBytes &&
        file.size > state.status.maxUploadBytes
      ) {
        errors.push(
          `${file.name}: exceeds the ${size(state.status.maxUploadBytes)} upload limit.`,
        );
        continue;
      }
      files.push({
        file,
        category: defaultPlatform(file),
        date: $('#upload-date').value,
        title: file.name.replace(/\.[^.]+$/, '').slice(0, 100),
        description: '',
        caption: '',
      });
    }
    $('#dialog-error').hidden = !errors.length;
    if (errors.length) dialogError(errors.join('\n'));
    renderFiles();
  }
  $('#upload-mode').onchange = () => {
    schedule = $('#upload-mode').value === 'schedule';
    $('#upload-date-default').hidden = !schedule;
    $('#upload-help').textContent = schedule
      ? scheduleMode === 'auto'
        ? 'We’ll schedule each file in the next available platform slot.'
        : 'Each file will upload and publish at its chosen time.'
      : 'Saved to your library. No publishing date needed.';
    files.forEach((entry) => {
      if (schedule && !entry.category)
        entry.category = defaultPlatform(entry.file);
    });
    renderFiles();
  };
  $('#upload-schedule-mode').onchange = () => {
    scheduleMode = $('#upload-schedule-mode').value;
    $('#upload-manual-date').hidden = scheduleMode !== 'manual';
    $('#upload-next-info').hidden = scheduleMode !== 'auto';
    $('#refresh-upload-slots').hidden = scheduleMode !== 'auto';
    $('#upload-mode').onchange();
  };
  $('#upload-date').onchange = () => {
    files.forEach((entry) => {
      entry.date = $('#upload-date').value;
    });
    renderFiles();
  };
  $('#upload-files').onchange = (event) => {
    addFiles([...event.target.files]);
    event.target.value = '';
  };
  $('#upload-category').onchange = () => {
    files.forEach((entry) => {
      entry.category = defaultPlatform(entry.file);
    });
    renderFiles();
  };
  $('#upload-files-list').oninput = (event) => {
    if (event.target.matches('[data-upload-field]'))
      files[+event.target.dataset.fileIndex][event.target.dataset.uploadField] =
        event.target.value;
  };
  $('#upload-files-list').onchange = (event) => {
    if (event.target.matches('[data-file-category]')) {
      const index = +event.target.dataset.fileCategory;
      files[index].category = event.target.value;
      renderFiles();
      $(`[data-file-category="${index}"]`).focus();
    }
  };
  $('#upload-files-list').onclick = (event) => {
    const button = event.target.closest('[data-remove-file]');
    if (button) {
      files.splice(+button.dataset.removeFile, 1);
      renderFiles();
    }
  };
  const drop = $('#drop-zone');
  drop.ondragover = (event) => {
    event.preventDefault();
    drop.classList.add('dragging');
  };
  drop.ondragleave = () => drop.classList.remove('dragging');
  drop.ondrop = (event) => {
    event.preventDefault();
    drop.classList.remove('dragging');
    addFiles([...event.dataTransfer.files]);
  };
  $('#start-upload').onclick = () => {
    if (schedule && scheduleMode === 'auto' && !previewReady) return;
    if (schedule) {
      for (const field of $$('input, textarea', $('#upload-files-list')))
        if (!field.reportValidity()) return;
      for (const entry of files) {
        if (
          scheduleMode === 'manual' &&
          (!Number.isFinite(Date.parse(entry.date)) ||
            Date.parse(entry.date) <= Date.now())
        )
          return dialogError(
            `${entry.file.name}: choose a publishing time in the future.`,
          );
        if (
          entry.category.includes('youtube') &&
          !entry.file.type.startsWith('video/')
        )
          return dialogError(
            `${entry.file.name}: YouTube requires a video. Choose Instagram for this image.`,
          );
        if (entry.category.includes('youtube') && !entry.title.trim())
          return dialogError(`${entry.file.name}: add a YouTube title.`);
      }
    }
    files.forEach((entry) =>
      uploadJobs.push({
        ...entry,
        id: uid(),
        requestId: uid(),
        schedule,
        scheduleMode,
        scheduledAt:
          schedule && scheduleMode === 'manual'
            ? new Date(entry.date).toISOString()
            : null,
        status: 'queued',
        progress: 0,
      }),
    );
    closeDialog();
    if (schedule) {
      state.postFilter = 'upcoming';
      $('#post-platform').value = 'all';
      go('schedule');
    } else {
      go('library');
      resetFilters();
    }
    processUploads();
  };
  $('#upload-mode').value = scheduleImmediately ? 'schedule' : 'library';
  $('#upload-mode').onchange();
  addFiles(initial);
}
$('#media-grid').ondragover = (event) => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
};
$('#media-grid').ondrop = (event) => {
  event.preventDefault();
  if (event.dataTransfer.files.length)
    openUpload([...event.dataTransfer.files]);
};
function renderUploads() {
  const panel = $('#upload-progress');
  panel.hidden = !uploadJobs.length;
  const unfinished = uploadJobs.filter((job) => job.status !== 'done').length;
  const pending = uploadJobs.some((job) =>
    ['queued', 'uploading', 'scheduling'].includes(job.status),
  );
  panel.innerHTML = `<header><span>${pending ? 'Finishing your uploads' : unfinished ? 'Some files need attention' : 'Uploads complete'} · ${uploadJobs.filter((j) => j.status === 'done').length}/${uploadJobs.length}</span>${!uploading && !uploadJobs.some((j) => j.status === 'queued') ? '<button class="icon-btn" id="dismiss-uploads" aria-label="Dismiss upload results">✕</button>' : ''}</header><p>${pending ? 'Keep this tab open until uploads and scheduling finish.' : unfinished ? 'Saved files are in your library. Retry any failed steps below.' : 'Files are saved. Scheduled posts are listed in Schedule.'}</p>${uploadJobs.map((job, i) => `<div class="upload-job"><div class="inline"><strong>${esc(job.file.name)}</strong><span>${job.status === 'done' ? (job.schedule ? 'Scheduled ✓' : 'Saved ✓') : job.status === 'scheduling' ? 'Scheduling…' : job.status === 'uploading' ? `${job.progress}%` : job.status === 'error' ? 'Needs attention' : 'Waiting'}</span></div>${job.status === 'uploading' ? `<progress value="${job.progress}" max="100" aria-label="Upload progress for ${esc(job.file.name)}"></progress>` : ''}${job.schedule ? (job.posts?.length ? job.posts.map((post) => `<p>${names[post.targets[0].platform]} · ${esc(dateText(post.scheduled_at))} · ${esc(zone)}</p>`).join('') : `<p>${job.scheduleMode === 'auto' ? (job.previewSlots || []).map((slot) => `Suggested: ${names[slot.platform]} · ${esc(dateText(slot.scheduledAt, slot.timezone))} · ${esc(slot.timezone)}`).join('<br>') || 'Finding next available slot' : `${esc(dateText(job.scheduledAt))} · ${esc(zone)}`}</p>`) : ''}${job.warnings?.length ? `<p>${esc(job.warnings.join(' '))}</p>` : ''}${job.error ? `<p class="post-error">${esc(job.error)}</p><button class="btn small" data-retry-upload="${i}">${job.mediaId ? 'Retry scheduling' : 'Retry upload'}</button>` : ''}</div>`).join('')}`;
}
$('#upload-progress').onclick = (event) => {
  const retry = event.target.closest('[data-retry-upload]');
  if (retry) {
    const job = uploadJobs[+retry.dataset.retryUpload];
    job.status = 'queued';
    job.error = '';
    processUploads();
  }
  if (event.target.closest('#dismiss-uploads')) {
    uploadJobs.splice(0);
    renderUploads();
  }
};
function sendFile(job) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media');
    const data = new FormData();
    data.append('file', job.file);
    data.append('uploadId', job.id);
    chosenPlatforms(job.category).forEach((platform) =>
      data.append('platforms', platform),
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        job.progress = Math.round((event.loaded / event.total) * 100);
        renderUploads();
      }
    };
    xhr.onload = () => {
      let body;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(
          new Error('Unexpected server response. Retry this upload safely.'),
        );
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || 'Upload failed. Please retry.'));
    };
    xhr.onerror = () =>
      reject(new Error('Connection lost. Retry to finish this upload safely.'));
    xhr.onabort = () => reject(new Error('Upload interrupted. Please retry.'));
    xhr.send(data);
  });
}
async function processUploads() {
  if (uploading) return;
  uploading = true;
  try {
    let job;
    while ((job = uploadJobs.find((j) => j.status === 'queued'))) {
      job.status = 'uploading';
      renderUploads();
      try {
        // Retain the saved media ID so scheduling retries never upload the file again.
        if (!job.mediaId) job.mediaId = (await sendFile(job)).id;
        if (job.schedule) {
          job.status = 'scheduling';
          renderUploads();
          const result = await api('/api/media/schedule', {
            method: 'POST',
            body: {
              requestId: job.requestId,
              mode: job.scheduleMode,
              items: chosenPlatforms(job.category).map((platform) => ({
                mediaId: job.mediaId,
                platform,
                scheduledAt: job.scheduledAt,
                title: platform === 'youtube' ? job.title.trim() : '',
                description:
                  platform === 'youtube' ? job.description : job.caption,
              })),
            },
          });
          job.posts = result.posts;
          job.warnings = result.warnings;
        }
        job.status = 'done';
      } catch (err) {
        job.status = 'error';
        job.error = job.mediaId
          ? `File saved, but scheduling was not confirmed. ${err.message} Retry here, or choose another date from the library.`
          : err.message;
      }
      await refreshData().catch(() => {});
      renderUploads();
      refreshUploadPreview?.();
    }
  } finally {
    uploading = false;
    renderUploads();
  }
  refreshStatus().catch(() => {});
}
window.addEventListener('beforeunload', (event) => {
  if (uploadJobs.some((j) => j.status !== 'done') || dialogBusy) {
    event.preventDefault();
    event.returnValue = '';
  }
});

function openMedia(id) {
  const media = state.media.find((m) => m.id === id);
  if (!media) return;
  const url = `/media/${encodeURIComponent(media.file_name)}`;
  showDialog(
    media.original_name,
    'FILE DETAILS',
    `<div class="media-preview">${media.file_missing ? '<p class="notice error">This file is missing from storage.</p>' : media.mime_type.startsWith('video/') ? `<video controls preload="metadata" src="${url}"></video>` : `<img src="${url}" alt="${esc(media.original_name)}" />`}</div><p class="file-meta">${size(media.file_size)} · ${media.post_count ? `Used in ${media.post_count} post(s)` : 'Not scheduled yet'}</p><form id="media-form"><label class="field">Platform category<select name="category">${categoryOptions(categoryValue(media.platforms))}</select></label><label class="field">Default YouTube title<input name="title" maxlength="100" value="${esc(media.title)}" /></label><label class="field">Default caption / description<textarea name="description" rows="3">${esc(media.description)}</textarea><span class="muted">Used as a starting point for new posts. Existing posts keep their own text.</span></label>${errorBox}<div class="form-footer"><button class="btn danger small" type="button" id="delete-media">Delete file</button><div class="inline"><button type="submit" class="btn" id="save-media">Save details</button><button type="button" class="btn primary" id="schedule-media" ${media.file_missing ? 'disabled' : ''}>Save & schedule</button></div></div></form>`,
  );
  async function save(schedule) {
    if (!$('#media-form').reportValidity()) return;
    const form = $('#media-form');
    busyDialog(true);
    $('#save-media').disabled = true;
    $('#schedule-media').disabled = true;
    try {
      await api(`/api/media/${id}`, {
        method: 'PATCH',
        body: {
          title: form.elements.title.value,
          description: form.elements.description.value,
          platforms: chosenPlatforms(form.elements.category.value),
        },
      });
      await refreshData();
      busyDialog(false);
      closeDialog();
      if (schedule) openSchedule([id]);
      else toast('File details saved.');
    } catch (err) {
      dialogError(err.message);
    } finally {
      busyDialog(false);
      if ($('#save-media')) {
        $('#save-media').disabled = false;
        $('#schedule-media').disabled = media.file_missing;
      }
    }
  }
  $('#media-form').onsubmit = (event) => {
    event.preventDefault();
    save(false);
  };
  $('#schedule-media').onclick = () => save(true);
  $('#delete-media').onclick = () =>
    confirmDelete(
      'Delete this file?',
      `“${media.original_name}” will be permanently removed from your library and storage.`,
      async () => {
        await api(`/api/media/${id}`, { method: 'DELETE' });
        await refreshData();
      },
      media.post_count
        ? 'This file is used by scheduled or published posts. Remove those posts from Schedule before deleting the file.'
        : null,
    );
}
function confirmDelete(title, copy, action, blocked = null) {
  showDialog(
    title,
    'REMOVE CONTENT',
    `<p class="dialog-copy">${esc(copy)}</p>${blocked ? `<p class="notice">${esc(blocked)}</p>` : ''}${errorBox}<div class="form-footer"><button class="btn" id="cancel-delete">Cancel</button>${!blocked ? '<button class="btn danger" id="confirm-delete">Delete</button>' : ''}</div>`,
  );
  $('#cancel-delete').onclick = closeDialog;
  if ($('#confirm-delete'))
    $('#confirm-delete').onclick = async () => {
      busyDialog(true);
      $('#confirm-delete').disabled = true;
      try {
        await action();
        busyDialog(false);
        closeDialog();
        toast('Removed successfully.');
      } catch (err) {
        dialogError(err.message);
      } finally {
        busyDialog(false);
        if ($('#confirm-delete')) $('#confirm-delete').disabled = false;
      }
    };
}
$('#categorize-selected').onclick = () => {
  const ids = [...state.selected];
  showDialog(
    `Organize ${ids.length} file${ids.length === 1 ? '' : 's'}`,
    'PLATFORM CATEGORIES',
    `<p class="dialog-copy">Choose a platform category. Categorizing a file doesn’t schedule a post.</p><label class="field">Platform<select id="batch-category">${categoryOptions()}</select></label>${errorBox}<div class="form-footer"><p>Applies to all selected files.</p><button class="btn primary" id="save-category">Save category</button></div>`,
  );
  $('#save-category').onclick = async () => {
    busyDialog(true);
    $('#save-category').disabled = true;
    try {
      const platforms = chosenPlatforms($('#batch-category').value);
      const results = await Promise.allSettled(
        ids.map((id) =>
          api(`/api/media/${id}`, { method: 'PATCH', body: { platforms } }),
        ),
      );
      await refreshData();
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length)
        throw new Error(
          `${failed.length} file(s) could not be updated. ${failed[0].reason.message}`,
        );
      busyDialog(false);
      closeDialog();
      toast('Categories updated.');
    } catch (err) {
      dialogError(err.message);
    } finally {
      busyDialog(false);
      if ($('#save-category')) $('#save-category').disabled = false;
    }
  };
};

function openSchedule(ids) {
  const media = ids
    .map((id) => state.media.find((m) => m.id === id))
    .filter(Boolean);
  if (!media.length) return;
  if (media.length > 50) return toast('Select up to 50 files at a time.', true);
  let mode = 'next',
    manualDate = localInput(Date.now() + 86400000),
    spacing = '1';
  const categories = new Map(
    media.map((m) => [
      m.id,
      categoryValue(m.platforms) ||
        (m.mime_type.startsWith('image/') ? 'instagram' : 'youtube'),
    ]),
  );
  let reviewed = [],
    draftItems = null,
    requestId = uid();
  function configure() {
    showDialog(
      `Schedule ${media.length === 1 ? 'your file' : `${media.length} files`}`,
      '1 OF 2 · PLATFORM & DATES',
      `<p class="dialog-copy">Choose a platform for each file, then review dates and write your post text.</p><div>${media.map((m) => `<div class="upload-file-row"><div class="file-info"><strong>${esc(m.original_name)}</strong><small>${m.post_count ? `Already used in ${m.post_count} post(s). This creates a new post.` : 'Not scheduled yet'}</small></div><select data-schedule-platform="${m.id}" aria-label="Publish ${esc(m.original_name)} to">${categoryOptions(categories.get(m.id), false)}</select></div>`).join('')}</div><label class="field">Publishing time<select id="schedule-mode"><option value="next" ${mode === 'next' ? 'selected' : ''}>Use next available posting slots</option><option value="manual" ${mode === 'manual' ? 'selected' : ''}>Choose a date and time</option></select></label><p id="next-explainer" class="notice" ${mode !== 'next' ? 'hidden' : ''}>Each file gets its own available day for that platform, following your posting routine in Settings.</p><div id="manual-fields" ${mode !== 'manual' ? 'hidden' : ''}><div class="field-row"><label class="field">First publishing time<input id="manual-date" type="datetime-local" value="${manualDate}" required /></label><label class="field">Days between files<input id="manual-spacing" type="number" min="1" max="365" value="${spacing}" required /></label></div><p class="muted">Times are in ${esc(zone)}. Files going to both platforms share the same time.</p></div>${errorBox}<div class="form-footer"><p>You’ll confirm everything on the next step.</p><button class="btn primary" id="review-schedule">Review schedule →</button></div>`,
      true,
    );
    $('#schedule-mode').onchange = () => {
      mode = $('#schedule-mode').value;
      $('#manual-fields').hidden = mode !== 'manual';
      $('#next-explainer').hidden = mode !== 'next';
    };
    $$('[data-schedule-platform]').forEach((el) => {
      el.onchange = () =>
        categories.set(+el.dataset.schedulePlatform, el.value);
    });
    $('#review-schedule').onclick = async () => {
      mode = $('#schedule-mode').value;
      manualDate = $('#manual-date').value;
      spacing = $('#manual-spacing').value;
      if (
        mode === 'manual' &&
        (!$('#manual-date').reportValidity() ||
          !$('#manual-spacing').reportValidity())
      )
        return;
      const items = [];
      for (const [i, m] of media.entries()) {
        if (!categories.get(m.id))
          return dialogError('Choose a publishing platform for every file.');
        for (const platform of chosenPlatforms(categories.get(m.id))) {
          const date = new Date(manualDate);
          date.setDate(date.getDate() + i * Number(spacing));
          const draft = draftItems?.find(
            (item) => item.mediaId === m.id && item.platform === platform,
          );
          items.push({
            mediaId: m.id,
            platform,
            ...(draft
              ? { title: draft.title, description: draft.description }
              : {}),
            ...(mode === 'manual' ? { scheduledAt: date.toISOString() } : {}),
          });
        }
      }
      busyDialog(true);
      $('#review-schedule').disabled = true;
      try {
        const result = await api('/api/media/schedule/preview', {
          method: 'POST',
          body: { mode, items },
        });
        reviewed = result.items;
        requestId = uid();
        busyDialog(false);
        review();
      } catch (err) {
        dialogError(err.message);
      } finally {
        busyDialog(false);
        if ($('#review-schedule')) $('#review-schedule').disabled = false;
      }
    };
  }
  function capture() {
    reviewed = reviewed.map((item, i) => ({
      ...item,
      title: $(`[data-review-title="${i}"]`)?.value ?? item.title,
      description: $(`[data-review-description="${i}"]`).value,
    }));
    draftItems = reviewed;
  }
  function review() {
    const disconnected = [...new Set(reviewed.map((r) => r.platform))].filter(
      (p) =>
        state.status && (!state.status[p].connected || state.status[p].error),
    );
    showDialog(
      'Review posts',
      '2 OF 2 · REVIEW & SCHEDULE',
      `<p class="dialog-copy">${reviewed.length} post${reviewed.length === 1 ? '' : 's'} to review. Original files remain in the library.</p>${disconnected.length ? `<p class="notice">${disconnected.map((p) => names[p]).join(' and ')} ${disconnected.length === 1 ? 'needs' : 'need'} to be connected in Settings before publishing.</p>` : ''}<form id="confirm-schedule-form">${reviewed.map((item, i) => `<section class="review-card"><div class="review-heading"><strong>${esc(item.originalName)}</strong>${badge(item.platform)}</div><div class="review-date">${icon('calendar')} ${esc(dateText(item.scheduledAt, item.timezone || zone))} · ${esc(item.timezone || zone)}</div>${item.platform === 'youtube' ? `<label class="field">YouTube title<input data-review-title="${i}" maxlength="100" required value="${esc(item.title)}" /></label>` : ''}<label class="field">${item.platform === 'youtube' ? 'Description' : 'Instagram caption'}<textarea data-review-description="${i}" rows="2">${esc(item.description)}</textarea></label></section>`).join('')}${reviewed.some((r) => r.platform === 'instagram') ? '<p class="muted">Instagram files are checked for publishing compatibility when you confirm.</p>' : ''}${errorBox}<div class="form-footer"><button type="button" class="btn" id="back-schedule">← Back</button><button type="submit" class="btn primary" id="confirm-schedule">Schedule ${reviewed.length} post${reviewed.length === 1 ? '' : 's'}</button></div></form>`,
      true,
    );
    $('#back-schedule').onclick = () => {
      capture();
      configure();
    };
    $('#confirm-schedule-form').onsubmit = async (event) => {
      event.preventDefault();
      capture();
      busyDialog(true);
      $('#confirm-schedule').disabled = true;
      $('#back-schedule').disabled = true;
      $('#confirm-schedule').textContent = 'Checking & scheduling…';
      try {
        const result = await api('/api/media/schedule', {
          method: 'POST',
          body: { requestId, mode, items: reviewed },
        });
        state.selected.clear();
        busyDialog(false);
        closeDialog();
        go('schedule');
        state.postFilter = 'upcoming';
        await refreshData();
        toast(
          `${result.posts.length} post${result.posts.length === 1 ? '' : 's'} scheduled. Your files are saved in the library.`,
        );
        if (result.warnings.length)
          showDialog(
            'Posts scheduled.',
            'MEDIA NOTES',
            `<p class="notice">${esc(result.warnings.join('\n'))}</p><p class="dialog-copy">These notes don’t prevent your posts from publishing.</p>`,
          );
      } catch (err) {
        dialogError(
          `${err.message}\nIf a slot is no longer available, go back and review fresh dates. Your files remain in the library.`,
        );
      } finally {
        busyDialog(false);
        if ($('#confirm-schedule')) {
          $('#confirm-schedule').disabled = false;
          $('#confirm-schedule').textContent =
            `Schedule ${reviewed.length} posts`;
          $('#back-schedule').disabled = false;
        }
      }
    };
  }
  configure();
}

const statusLabels = {
  scheduled: 'Scheduled',
  processing: 'Publishing',
  done: 'Published',
  failed: 'Failed',
  partial: 'Needs attention',
  pending: 'Scheduled',
};
const matchesPost = (post, filter) =>
  filter === 'all' ||
  (filter === 'upcoming'
    ? ['scheduled', 'processing'].includes(post.status)
    : filter === 'attention'
      ? ['failed', 'partial'].includes(post.status)
      : post.status === 'done');
function renderPosts() {
  const upcoming = state.posts.filter((p) => matchesPost(p, 'upcoming')).length;
  $('#schedule-count').textContent = upcoming;
  $('#schedule-summary').innerHTML =
    summary(upcoming, 'Posts coming up', 'calendar') +
    summary(
      state.posts.filter((p) => p.status === 'done').length,
      'Published posts',
      'check',
    ) +
    summary(
      state.posts.filter((p) => matchesPost(p, 'attention')).length,
      'Need your attention',
      'clock',
    );
  $('#post-tabs').innerHTML = [
    ['upcoming', 'Upcoming'],
    ['done', 'Published'],
    ['attention', 'Needs attention'],
    ['all', 'All posts'],
  ]
    .map(
      ([key, label]) =>
        `<button data-post-filter="${key}" class="${state.postFilter === key ? 'active' : ''}" aria-pressed="${state.postFilter === key}">${label}<span>${state.posts.filter((p) => matchesPost(p, key)).length}</span></button>`,
    )
    .join('');
  $('#schedule-timezone').textContent = `All times shown in ${zone}`;
  const platform = $('#post-platform').value;
  const posts = state.posts.filter(
    (p) =>
      matchesPost(p, state.postFilter) &&
      (platform === 'all' || p.targets.some((t) => t.platform === platform)),
  );
  $('#bulk-reschedule').hidden = !state.posts.some(
    (p) =>
      p.status === 'scheduled' &&
      (platform === 'all' || p.targets.some((t) => t.platform === platform)),
  );
  let lastDay = '';
  $('#post-list').innerHTML = posts.length
    ? posts
        .map((post) => {
          const day = new Date(post.scheduled_at).toLocaleDateString(
            undefined,
            { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
          );
          const heading =
            day !== lastDay ? `<div class="post-day">${esc(day)}</div>` : '';
          lastDay = day;
          const editable = ['scheduled', 'failed', 'partial'].includes(
            post.status,
          );
          return `${heading}<article class="post-card"><div class="post-time">${new Date(post.scheduled_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div><div class="post-content"><h3>${esc(post.title || post.description.split('\n')[0] || post.original_name)}</h3><p class="muted${post.file_missing ? ' missing' : ''}">${esc(post.original_name)} · ${size(post.file_size)}</p><div class="badges" style="margin-top:8px">${post.targets.map((target) => `${badge(target.platform)}<span class="badge ${target.status === 'pending' ? 'scheduled' : target.status}">${statusLabels[target.status]}</span>${target.result_url && /^https?:\/\//i.test(target.result_url) ? `<a class="badge" href="${esc(target.result_url)}" target="_blank" rel="noopener noreferrer">View post ↗</a>` : ''}`).join('')}</div>${post.targets
            .filter((t) => t.error)
            .map(
              (t) =>
                `<p class="post-error">${names[t.platform]}: ${esc(t.error)}</p>`,
            )
            .join(
              '',
            )}</div><div class="post-actions">${['failed', 'partial'].includes(post.status) ? `<button class="btn small" data-retry-post="${post.id}">Retry failed</button>` : ''}${editable ? `<button class="btn small" data-edit-post="${post.id}">Edit post</button>` : ''}${post.status !== 'processing' ? `<button class="btn small text" data-delete-post="${post.id}">Remove</button>` : ''}</div></article>`;
        })
        .join('')
    : empty(
        state.postFilter === 'upcoming'
          ? 'No upcoming posts'
          : 'No posts here yet.',
        state.postFilter === 'upcoming'
          ? 'Upload a file or select one from the library to schedule a post.'
          : 'Posts will appear here as their status changes.',
        'pick-media',
        'Choose from library',
        'calendar',
      );
}
$('#post-tabs').onclick = (event) => {
  const button = event.target.closest('[data-post-filter]');
  if (button) {
    state.postFilter = button.dataset.postFilter;
    renderPosts();
  }
};
$('#post-platform').onchange = renderPosts;
$('#post-list').onclick = async (event) => {
  const edit = event.target.closest('[data-edit-post]'),
    remove = event.target.closest('[data-delete-post]'),
    retry = event.target.closest('[data-retry-post]');
  if (edit) editPost(+edit.dataset.editPost);
  if (remove) {
    const post = state.posts.find((p) => p.id === +remove.dataset.deletePost);
    const retained =
      state.media.some((m) => m.file_name === post.file_name) ||
      state.posts.some(
        (p) => p.id !== post.id && p.file_name === post.file_name,
      );
    confirmDelete(
      'Remove this post?',
      `${post.status === 'done' ? 'This removes its local history; the published post stays on the platform.' : 'This removes the post from your schedule.'} ${retained ? 'Your file will remain available in the library or other posts.' : 'The associated upload will also be deleted.'}`,
      async () => {
        await api(`/api/posts/${post.id}`, { method: 'DELETE' });
        await refreshData();
      },
    );
  }
  if (retry) {
    retry.disabled = true;
    try {
      await api(`/api/posts/${retry.dataset.retryPost}/retry`, {
        method: 'POST',
      });
      await refreshData();
      toast(
        'Failed targets queued to retry. Past-due posts publish on the next scheduler check.',
      );
    } catch (err) {
      toast(err.message, true);
      retry.disabled = false;
    }
  }
};
function editPost(id) {
  const post = state.posts.find((p) => p.id === id);
  const youtube = post.targets.some((t) => t.platform === 'youtube');
  showDialog(
    'Edit post',
    'EDIT SCHEDULED POST',
    `<p class="dialog-copy">${esc(post.original_name)}</p><form id="edit-post-form">${youtube ? `<label class="field">YouTube title<input name="title" maxlength="100" required value="${esc(post.title)}" /></label>` : ''}<label class="field">${youtube ? 'Description' : 'Instagram caption'}<textarea name="description">${esc(youtube ? post.description : [post.title, post.description].filter(Boolean).join('\n\n'))}</textarea></label><label class="field">Publish at<input name="scheduledAt" type="datetime-local" required value="${localInput(post.scheduled_at)}" /><span class="muted">${esc(zone)}. Past-due scheduled posts publish on the next check.</span></label>${['failed', 'partial'].includes(post.status) ? '<p class="notice">Saving changes keeps the failed status. Use “Retry failed” when you’re ready to publish.</p>' : ''}${errorBox}<div class="form-footer"><button type="button" class="btn" id="cancel-edit">Cancel</button><button class="btn primary" id="save-post">Save changes</button></div></form>`,
  );
  $('#cancel-edit').onclick = closeDialog;
  $('#edit-post-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target;
    busyDialog(true);
    $('#save-post').disabled = true;
    try {
      await api(`/api/posts/${id}`, {
        method: 'PATCH',
        body: {
          title: youtube ? form.elements.title.value : '',
          description: form.elements.description.value,
          scheduledAt: new Date(form.elements.scheduledAt.value).toISOString(),
        },
      });
      await refreshData();
      busyDialog(false);
      closeDialog();
      toast('Post updated.');
    } catch (err) {
      dialogError(err.message);
    } finally {
      busyDialog(false);
      if ($('#save-post')) $('#save-post').disabled = false;
    }
  };
}
$('#bulk-reschedule').onclick = () => {
  const platform = $('#post-platform').value;
  const posts = state.posts.filter(
    (p) =>
      p.status === 'scheduled' &&
      (platform === 'all' || p.targets.some((t) => t.platform === platform)),
  );
  let changes = [];
  showDialog(
    `Reschedule ${posts.length} upcoming posts`,
    'RESCHEDULE POSTS',
    `<p class="dialog-copy">Spread upcoming posts across new dates, in their current order. Times use ${esc(zone)}.</p><form id="bulk-form"><div class="field-row"><label class="field">First publishing time<input id="bulk-date" type="datetime-local" required value="${localInput(Date.now() + 86400000)}" /></label><label class="field">Days between posts<input id="bulk-spacing" type="number" min="1" max="365" required value="1" /></label></div><div id="bulk-preview"></div>${errorBox}<div class="form-footer"><button type="button" class="btn" id="cancel-bulk">Cancel</button><button class="btn primary" id="save-bulk">Save new dates</button></div></form>`,
  );
  function preview() {
    const start = new Date($('#bulk-date').value);
    const spacing = Number($('#bulk-spacing').value);
    if (!Number.isFinite(start.getTime()) || spacing < 1) {
      changes = [];
      return;
    }
    changes = posts.map((p, i) => {
      const date = new Date(start);
      date.setDate(date.getDate() + i * spacing);
      return { id: p.id, scheduledAt: date.toISOString() };
    });
    $('#bulk-preview').innerHTML = changes
      .map(
        (c, i) =>
          `<div class="review-date">${esc(posts[i].title || posts[i].original_name)} → ${esc(dateText(c.scheduledAt))}</div>`,
      )
      .join('');
  }
  $('#bulk-date').oninput = preview;
  $('#bulk-spacing').oninput = preview;
  preview();
  $('#cancel-bulk').onclick = closeDialog;
  $('#bulk-form').onsubmit = async (event) => {
    event.preventDefault();
    preview();
    if (!changes.length || Date.parse(changes[0].scheduledAt) <= Date.now())
      return dialogError('Choose a first publishing time in the future.');
    busyDialog(true);
    $('#save-bulk').disabled = true;
    try {
      const result = await api('/api/posts/reschedule', {
        method: 'POST',
        body: { changes },
      });
      await refreshData();
      busyDialog(false);
      closeDialog();
      toast(
        `${result.updated} posts rescheduled.${result.skipped ? ` ${result.skipped} could no longer be moved.` : ''}`,
      );
    } catch (err) {
      dialogError(err.message);
    } finally {
      busyDialog(false);
      if ($('#save-bulk')) $('#save-bulk').disabled = false;
    }
  };
};

function renderSettings() {
  const status = state.status;
  for (const p of ['youtube', 'instagram']) {
    const connected = status[p].connected && !status[p].error;
    $(`#channel-${p} .connection-dot`).className =
      `connection-dot ${connected ? 'connected' : 'issue'}`;
    $(`#channel-${p}`).title =
      `${names[p]}: ${connected ? 'Connected' : status[p].configured ? 'Needs connection' : 'Not configured'}`;
  }
  $('#connections').innerHTML = ['youtube', 'instagram']
    .map((p) => {
      const account = status[p];
      const connected = account.connected && !account.error;
      let detail = connected
        ? p === 'instagram' && account.username
          ? `Connected as @${account.username}`
          : 'Account connected.'
        : account.configured
          ? 'Connect your account to publish scheduled posts.'
          : `Add your ${names[p]} app credentials to the server’s .env file, then restart the app.`;
      if (account.error) detail = account.error;
      if (p === 'instagram' && account.tokenExpiresAt) {
        const days = Math.ceil(
          (Date.parse(account.tokenExpiresAt) - Date.now()) / 86400000,
        );
        detail +=
          days > 0
            ? ` Token expires in ${days} days; refreshes automatically.`
            : ' Token expired. Reconnect your account.';
      }
      return `<section class="settings-card"><div class="channel-title"><span class="platform-icon">${icon(p)}</span><h3>${names[p]}</h3><span class="badge ${connected ? 'done' : ''}">${connected ? 'Connected' : 'Not connected'}</span></div><p>${esc(detail)}</p>${account.configured ? `<a class="btn small" href="/auth/${p}">${connected ? 'Reconnect' : 'Connect'} ${names[p]} ↗</a>` : '<p class="muted">See the project README for account setup instructions.</p>'}</section>`;
    })
    .join('');
  // Keep in-progress routine edits intact during connection/storage refreshes.
  if (!$('#routine-fields').children.length) renderRoutine();
  const storage = status.storage;
  if (storage) {
    $('#storage-detail').textContent =
      `${size(storage.uploadsBytes)} in ${storage.uploadCount} saved media files · ${size(storage.free)} free on disk`;
    $('#storage-bar span').style.width =
      `${Math.min(100, (storage.used / storage.total) * 100)}%`;
    $('#storage-extra').textContent = storage.orphanCount
      ? `${size(storage.orphanBytes)} in ${storage.orphanCount} leftover upload(s).`
      : 'No leftover uploads.';
    $('#cleanup').disabled = !storage.orphanCount;
  }
}
function renderRoutine() {
  const weekdays = [
    [1, 'M', 'Monday'],
    [2, 'T', 'Tuesday'],
    [3, 'W', 'Wednesday'],
    [4, 'T', 'Thursday'],
    [5, 'F', 'Friday'],
    [6, 'S', 'Saturday'],
    [0, 'S', 'Sunday'],
  ];
  $('#routine-fields').innerHTML =
    ['youtube', 'instagram']
      .map((p) => {
        const spec = state.routine[p];
        return `<section class="settings-card"><div class="channel-title"><span class="platform-icon">${icon(p)}</span><h3>${names[p]}</h3></div><fieldset class="weekdays"><legend>Posting days</legend>${weekdays.map(([day, letter, name]) => `<label class="day-check" title="${name}"><input type="checkbox" name="${p}-days" value="${day}" aria-label="${name}" ${spec.days.includes(day) ? 'checked' : ''} /><span>${letter}</span></label>`).join('')}</fieldset><label class="field">Posting time<input type="time" name="${p}-time" required value="${spec.time}" /></label><label class="field">Timezone<input type="text" name="${p}-timezone" required list="timezones" value="${esc(spec.timezone)}" /></label></section>`;
      })
      .join('') +
    `<datalist id="timezones">${(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [zone, 'UTC', 'Europe/Stockholm']).map((z) => `<option value="${esc(z)}"></option>`).join('')}</datalist>`;
}
$('#routine-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.target;
  const button = $('button[type=submit]', form);
  button.disabled = true;
  const value = Object.fromEntries(
    ['youtube', 'instagram'].map((p) => [
      p,
      {
        days: $$(`input[name="${p}-days"]:checked`).map((el) => +el.value),
        time: form.elements[`${p}-time`].value,
        timezone: form.elements[`${p}-timezone`].value.trim(),
      },
    ]),
  );
  try {
    state.routine = await api('/api/settings/posting-schedule', {
      method: 'PUT',
      body: value,
    });
    $('#routine-message').textContent =
      'Saved. New suggestions will follow your routine.';
    toast('Posting routine saved.');
  } catch (err) {
    $('#routine-message').textContent = err.message;
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
};
$('#cleanup').onclick = async () => {
  $('#cleanup').disabled = true;
  try {
    const result = await api('/api/storage/cleanup', { method: 'POST' });
    state.status.storage = result.storage;
    renderSettings();
    toast(
      result.count
        ? `Removed ${result.count} leftover upload(s), freeing ${size(result.bytes)}.`
        : 'No idle uploads to remove yet. Recent uploads are kept safe.',
    );
  } catch (err) {
    toast(err.message, true);
    $('#cleanup').disabled = false;
  }
};
async function initialize() {
  const results = await Promise.allSettled([refreshData(), refreshStatus()]);
  const errors = results.filter((r) => r.status === 'rejected');
  if (errors.length) {
    $('#page-error').hidden = false;
    $('#page-error').textContent =
      `Couldn’t load app data. ${errors[0].reason.message} Refresh this page to try again.`;
  }
}
initialize();
// Refresh the visible lists without disturbing an open editor or active selection.
setInterval(() => {
  if (
    !document.hidden &&
    !$('#dialog').open &&
    !state.selected.size &&
    !uploading &&
    state.view !== 'settings'
  )
    refreshData().catch(() => {
      $('#page-error').hidden = false;
      $('#page-error').textContent =
        'Connection lost. The app will refresh when the server is available again.';
    });
}, 30000);
