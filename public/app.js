const $ = (sel) => document.querySelector(sel);

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
const local = new Date(inOneHour.getTime() - inOneHour.getTimezoneOffset() * 60000);
form.scheduledAt.value = local.toISOString().slice(0, 16);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.hidden = true;

  const platforms = [...form.querySelectorAll('input[name="platforms"]:checked')].map((el) => el.value);
  if (platforms.length === 0) return showMsg('Pick at least one platform', true);

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
    await api('/api/posts', { method: 'POST', body: fd });
    showMsg('Scheduled ✔', false);
    form.file.value = '';
    form.title.value = '';
    form.description.value = '';
    await loadPosts();
  } catch (err) {
    showMsg(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Schedule';
  }
});

function showMsg(text, isError) {
  msg.hidden = false;
  msg.textContent = text;
  msg.className = `form-msg ${isError ? 'err' : 'ok'}`;
}

/* ---------- post list ---------- */

async function loadPosts() {
  const posts = await api('/api/posts');
  const box = $('#posts');
  if (posts.length === 0) {
    box.innerHTML = '<p class="hint">Nothing scheduled yet.</p>';
    return;
  }
  box.innerHTML = '';
  for (const post of posts) box.appendChild(renderPost(post));
}

function renderPost(post) {
  const el = document.createElement('div');
  el.className = 'post';

  const head = document.createElement('div');
  head.className = 'post-head';
  head.innerHTML = `
    <span class="post-title"></span>
    <span class="post-time"></span>
    <span class="badge ${post.status}">${post.status}</span>
  `;
  head.querySelector('.post-title').textContent = post.title;
  head.querySelector('.post-time').textContent = new Date(post.scheduled_at).toLocaleString();
  el.appendChild(head);

  const targets = document.createElement('ul');
  targets.className = 'targets';
  for (const t of post.targets) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'platform';
    name.textContent = t.platform;
    li.appendChild(name);
    if (t.status === 'done' && t.result_url) {
      const a = document.createElement('a');
      a.href = t.result_url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = t.result_url;
      li.appendChild(a);
    } else if (t.status === 'failed') {
      const err = document.createElement('span');
      err.className = 'error';
      err.textContent = t.error || 'failed';
      li.appendChild(err);
    } else {
      const s = document.createElement('span');
      s.textContent = t.status;
      li.appendChild(s);
    }
    targets.appendChild(li);
  }
  el.appendChild(targets);

  const actions = document.createElement('div');
  actions.className = 'post-actions';
  if (['failed', 'partial'].includes(post.status)) {
    const retry = document.createElement('button');
    retry.className = 'btn small';
    retry.textContent = 'Retry failed';
    retry.onclick = async () => {
      await api(`/api/posts/${post.id}/retry`, { method: 'POST' }).catch((e) => alert(e.message));
      loadPosts();
    };
    actions.appendChild(retry);
  }
  if (post.status !== 'processing') {
    const del = document.createElement('button');
    del.className = 'btn small danger';
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm(`Delete "${post.title}"?`)) return;
      await api(`/api/posts/${post.id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
      loadPosts();
    };
    actions.appendChild(del);
  }
  if (actions.children.length > 0) el.appendChild(actions);

  return el;
}

/* ---------- boot ---------- */

loadStatus().catch(console.error);
loadPosts().catch(console.error);
setInterval(() => loadPosts().catch(() => {}), 10000);
setInterval(() => loadStatus().catch(() => {}), 30000);
