// =====================================================================
// Daily Checklist
// - Weekly template: each weekday has its own list, repeated every week
// - Ticks are stored per calendar date, so every day starts fresh
// - Saves to Supabase when config.js is filled in, otherwise this browser
// =====================================================================

const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const ORDER = [1,2,3,4,5,6,0];          // Monday first in Settings
const KEEP_DAYS = 14;                   // how many days of ticks to keep
const LS_TEMPLATE = "checklist.template";
const LS_DONE = "checklist.done";
const LS_DIRTY = "checklist.dirty";     // true = local changes not yet saved online
const CHECK_SVG = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="square"><path d="M5 12.5l4.5 4.5L19 7"></path></svg>';

const CFG = window.CHECKLIST_CONFIG || {};
const SYNC_ON = !!(CFG.supabaseUrl && CFG.supabaseKey);

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------
// Local storage helpers
// ---------------------------------------------------------------------
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function normalize(t) {
  const out = {};
  for (let i = 0; i < 7; i++) out[i] = Array.isArray(t && t[i]) ? t[i].map(String) : [];
  return out;
}
function dateKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function daysAgoKey(n) { const d = new Date(); d.setDate(d.getDate() - n); return dateKey(d); }
function todayKey() { return dateKey(new Date()); }

let template = normalize(load(LS_TEMPLATE, null));
let done = load(LS_DONE, {});

function prune() {
  const cutoff = daysAgoKey(KEEP_DAYS);
  Object.keys(done).forEach(k => { if (k < cutoff) delete done[k]; });
}
function saveLocal() { prune(); save(LS_TEMPLATE, template); save(LS_DONE, done); }
function isDirty() { return load(LS_DIRTY, false) === true; }
function setDirty(v) { save(LS_DIRTY, v); }

// ---------------------------------------------------------------------
// Online saving (Supabase)
// ---------------------------------------------------------------------
let db = null;
let user = null;
let channel = null;
let refreshTimer = null;

function setStatus(text, warn) {
  const el = $("sync-status");
  el.textContent = text;
  el.classList.toggle("warn", !!warn);
}

async function must(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

// Send everything this device has (used after being offline)
async function pushEverything() {
  const today = todayKey();
  await must(db.from("templates").upsert({ user_id: user.id, data: template, updated_at: new Date().toISOString() }));
  await must(db.from("ticks").delete().eq("user_id", user.id).eq("day", today));
  const rows = (done[today] || []).map(idx => ({ user_id: user.id, day: today, idx }));
  if (rows.length) await must(db.from("ticks").insert(rows));
}

// Run one save; if it fails, remember we're behind and retry everything later
async function sync(job) {
  if (!db || !user) return;
  setStatus("Saving…");
  try {
    if (isDirty()) await pushEverything(); else await job();
    setDirty(false);
    setStatus("Saved");
  } catch (e) {
    console.warn("Save failed", e);
    setDirty(true);
    setStatus("Offline", true);
  }
}

// Fetch the latest from the server and redraw
async function pullAll() {
  if (!db || !user) return;
  try {
    if (isDirty()) { await pushEverything(); setDirty(false); }

    const row = await must(db.from("templates").select("data").eq("user_id", user.id).maybeSingle());
    const ticks = await must(db.from("ticks").select("day,idx").eq("user_id", user.id).gte("day", daysAgoKey(KEEP_DAYS)));

    const before = JSON.stringify(template);
    if (row) {
      template = normalize(row.data);
    } else {
      // First sign-in: upload whatever this browser already had
      await must(db.from("templates").upsert({ user_id: user.id, data: template, updated_at: new Date().toISOString() }));
    }
    const fresh = {};
    (ticks || []).forEach(r => { (fresh[r.day] = fresh[r.day] || []).push(r.idx); });
    done = fresh;
    saveLocal();
    setStatus("Saved");

    // Old ticks: tidy up on the server too (not urgent if it fails)
    db.from("ticks").delete().eq("user_id", user.id).lt("day", daysAgoKey(KEEP_DAYS)).then(() => {}, () => {});

    redraw(before !== JSON.stringify(template));
  } catch (e) {
    console.warn("Load failed", e);
    setStatus("Offline", true);
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(pullAll, 400);
}

function listen() {
  if (channel) db.removeChannel(channel);
  const filter = "user_id=eq." + user.id;
  channel = db.channel("checklist-" + user.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "templates", filter }, scheduleRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "ticks", filter }, scheduleRefresh)
    .subscribe();
}

async function onSignedIn(u) {
  if (user && user.id === u.id) return;
  user = u;
  show("today");
  await pullAll();
  listen();
}

function onSignedOut() {
  user = null;
  if (channel) { db.removeChannel(channel); channel = null; }
  template = normalize(null);
  done = {};
  saveLocal();
  setDirty(false);
  show("auth");
}

function initSync() {
  if (!window.supabase) {
    setStatus("Offline", true);
    show("today");
    return;
  }
  db = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  db.auth.onAuthStateChange((event, session) => {
    // run outside the callback, as Supabase recommends
    setTimeout(() => {
      if (session && session.user) onSignedIn(session.user);
      else if (event === "SIGNED_OUT" || event === "INITIAL_SESSION") onSignedOut();
    }, 0);
  });

  // When you come back to the tab (e.g. on your phone), fetch the latest
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pullAll(); });
  window.addEventListener("online", pullAll);
}

// ---------------------------------------------------------------------
// Sign-in screen
// ---------------------------------------------------------------------
function authMessage(text, isError) {
  const el = $("auth-message");
  el.textContent = text;
  el.classList.toggle("error", !!isError);
}

async function handleAuth(mode) {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  if (!email || password.length < 6) { authMessage("Enter your email and a password of at least 6 characters.", true); return; }
  $("auth-signin").disabled = $("auth-signup").disabled = true;
  authMessage(mode === "signup" ? "Creating account…" : "Signing in…");
  try {
    if (mode === "signup") {
      const { data, error } = await db.auth.signUp({
        email, password,
        options: { emailRedirectTo: location.origin + location.pathname }
      });
      if (error) throw error;
      if (!data.session) authMessage("Account created. Check your email to confirm it, then sign in here.");
    } else {
      const { error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (e) {
    authMessage(e.message || "Something went wrong.", true);
  } finally {
    $("auth-signin").disabled = $("auth-signup").disabled = false;
  }
}

$("auth-form").addEventListener("submit", e => { e.preventDefault(); handleAuth("signin"); });
$("auth-signup").addEventListener("click", () => handleAuth("signup"));

// ---------------------------------------------------------------------
// Today view
// ---------------------------------------------------------------------
let currentKey = null;

function updateCount() {
  const tasks = template[new Date().getDay()] || [];
  const n = (done[currentKey] || []).filter(i => i < tasks.length).length;
  $("count").textContent = tasks.length ? n + " / " + tasks.length : "";
}

function renderToday() {
  const now = new Date();
  currentKey = dateKey(now);
  const dayIndex = now.getDay();
  const tasks = template[dayIndex] || [];
  const ticked = done[currentKey] || [];

  $("day-num").textContent = String(now.getDate()).padStart(2, "0");
  $("day-name").textContent = DAYS[dayIndex];
  $("month-year").textContent = now.toLocaleDateString("en-GB", { month: "short" }) + " " + now.getFullYear();

  const list = $("task-list");
  list.innerHTML = "";

  if (tasks.length === 0) {
    list.innerHTML = '<li class="empty">Nothing set for today. Add tasks in Settings.</li>';
    updateCount();
    return;
  }

  tasks.forEach((text, i) => {
    const li = document.createElement("li");
    li.className = "task" + (ticked.includes(i) ? " done" : "");
    const label = document.createElement("label");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = ticked.includes(i);
    cb.addEventListener("change", () => toggle(i, cb.checked, li));

    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(i + 1).padStart(2, "0");

    const span = document.createElement("span");
    span.className = "text";
    span.textContent = text;

    const box = document.createElement("span");
    box.className = "box";
    box.innerHTML = CHECK_SVG;

    label.append(cb, num, span, box);
    li.appendChild(label);
    list.appendChild(li);
  });
  updateCount();
}

function toggle(i, checked, li) {
  const day = currentKey;
  const set = new Set(done[day] || []);
  checked ? set.add(i) : set.delete(i);
  done[day] = [...set];
  saveLocal();
  li.classList.toggle("done", checked);
  updateCount();

  sync(async () => {
    if (checked) await must(db.from("ticks").upsert({ user_id: user.id, day, idx: i }, { ignoreDuplicates: true }));
    else await must(db.from("ticks").delete().eq("user_id", user.id).eq("day", day).eq("idx", i));
  });
}

// ---------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------
function renderSettings() {
  const wrap = $("settings-days");
  wrap.innerHTML = "";
  const todayIdx = new Date().getDay();

  ORDER.forEach(d => {
    const block = document.createElement("div");
    block.className = "day-block" + (d === todayIdx ? " is-today" : "");
    const h = document.createElement("h3");
    h.textContent = DAYS[d] + (d === todayIdx ? " — today" : "");
    block.appendChild(h);
    const ul = document.createElement("ul");

    template[d].forEach((text, i) => {
      const li = document.createElement("li");
      const input = document.createElement("input");
      input.type = "text";
      input.value = text;
      input.setAttribute("aria-label", DAYS[d] + " task " + (i + 1));
      input.addEventListener("change", () => { template[d][i] = input.value; templateChanged(d); });
      const del = document.createElement("button");
      del.className = "small-btn";
      del.textContent = "Remove";
      del.addEventListener("click", () => { template[d].splice(i, 1); templateChanged(d); renderSettings(); });
      li.append(input, del);
      ul.appendChild(li);
    });

    const addLi = document.createElement("li");
    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.placeholder = "Add a task…";
    addInput.setAttribute("aria-label", "New " + DAYS[d] + " task");
    const addBtn = document.createElement("button");
    addBtn.className = "small-btn add";
    addBtn.textContent = "Add";
    const add = () => {
      const v = addInput.value.trim();
      if (!v) return;
      template[d].push(v);
      templateChanged(d);
      renderSettings();
      const fresh = $("settings-days").children[ORDER.indexOf(d)].querySelector("input[placeholder]");
      if (fresh) fresh.focus();
    };
    addBtn.addEventListener("click", add);
    addInput.addEventListener("keydown", e => { if (e.key === "Enter") add(); });
    addLi.append(addInput, addBtn);
    ul.appendChild(addLi);

    block.appendChild(ul);
    wrap.appendChild(block);
  });

  renderAccount();
}

function renderAccount() {
  const el = $("account");
  el.innerHTML = "";
  const info = document.createElement("span");
  if (!SYNC_ON) {
    info.textContent = "Saving in this browser only. Fill in config.js to save online.";
    el.appendChild(info);
    return;
  }
  if (!user) return;
  info.textContent = "Signed in as " + user.email;
  const out = document.createElement("button");
  out.className = "small-btn";
  out.textContent = "Sign out";
  out.addEventListener("click", () => db.auth.signOut());
  el.append(info, out);
}

function templateChanged(d) {
  const today = todayKey();
  // If today's list changed, clear today's ticks so they don't point at the wrong task
  const clearToday = d === new Date().getDay();
  if (clearToday) delete done[today];
  saveLocal();

  sync(async () => {
    await must(db.from("templates").upsert({ user_id: user.id, data: template, updated_at: new Date().toISOString() }));
    if (clearToday) await must(db.from("ticks").delete().eq("user_id", user.id).eq("day", today));
  });
}

// ---------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------
let view = null;

function show(v) {
  view = v;
  $("view-auth").classList.toggle("hidden", v !== "auth");
  $("view-today").classList.toggle("hidden", v !== "today");
  $("view-settings").classList.toggle("hidden", v !== "settings");
  $("nav").classList.toggle("hidden", v === "auth");
  $("nav-today").classList.toggle("active", v === "today");
  $("nav-settings").classList.toggle("active", v === "settings");
  $("count").classList.toggle("hidden", v !== "today");
  if (v === "today") renderToday();
  if (v === "settings") renderSettings();
}

// Redraw after new data arrives, without wiping something you're typing
function redraw(listsChanged) {
  if (view === "today") renderToday();
  if (view === "settings" && listsChanged) {
    const typing = document.activeElement && $("view-settings").contains(document.activeElement);
    if (!typing) renderSettings();
  }
}

$("nav-today").addEventListener("click", () => show("today"));
$("nav-settings").addEventListener("click", () => show("settings"));

// New day while the tab is open → load the new day's list
setInterval(() => {
  if (view === "today" && todayKey() !== currentKey) { prune(); renderToday(); }
}, 30000);

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------
if (SYNC_ON) {
  setStatus("Connecting…");
  initSync();
} else {
  setStatus("This browser");
  show("today");
}
