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
const CHECK_SVG =
  '<svg class="tick-std" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="square"><path d="M5 12.5l4.5 4.5L19 7"></path></svg>' +
  '<svg class="tick-hand" aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13c2 1.5 3.5 3.5 4.5 5.5C11 12 15 7 21 3"></path></svg>';
const HANDLE_GRIP = '<svg class="g" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.7"></circle><circle cx="15" cy="6" r="1.7"></circle><circle cx="9" cy="12" r="1.7"></circle><circle cx="15" cy="12" r="1.7"></circle><circle cx="9" cy="18" r="1.7"></circle><circle cx="15" cy="18" r="1.7"></circle></svg>';
const GRIP_SVG = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>';

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
function keyWeekday(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).getDay(); }

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

async function pushTemplate() {
  await must(db.from("templates").upsert({ user_id: user.id, data: template, updated_at: new Date().toISOString() }));
}

// Replace the server's ticks for these dates with what this device has
async function pushTicks(keys) {
  if (!keys.length) return;
  await must(db.from("ticks").delete().eq("user_id", user.id).in("day", keys));
  const rows = [];
  keys.forEach(day => (done[day] || []).forEach(idx => rows.push({ user_id: user.id, day, idx })));
  if (rows.length) await must(db.from("ticks").insert(rows));
}

// Send everything this device has (used after being offline)
async function pushEverything() {
  await pushTemplate();
  await must(db.from("ticks").delete().eq("user_id", user.id).gte("day", daysAgoKey(KEEP_DAYS)));
  const rows = [];
  Object.keys(done).forEach(day => (done[day] || []).forEach(idx => rows.push({ user_id: user.id, day, idx })));
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
      await pushTemplate();
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
// Changing the lists (add / edit / remove / reorder)
// ---------------------------------------------------------------------

// remap: function(oldIndex) → newIndex, or null if that task was removed.
// Keeps ticks attached to the right tasks on every date that uses this weekday.
function templateChanged(d, remap) {
  let keys = [];
  if (typeof remap === "function") {
    keys = Object.keys(done).filter(k => keyWeekday(k) === d);
    keys.forEach(k => { done[k] = done[k].map(remap).filter(v => v !== null && v !== undefined); });
  }
  saveLocal();

  sync(async () => {
    await pushTemplate();
    await pushTicks(keys);
  });
}

function addTask(d, text) {
  template[d].push(text);
  templateChanged(d);
}

function editTask(d, i, text) {
  if (!text || text === template[d][i]) return;
  template[d][i] = text;
  templateChanged(d);
}

function removeTask(d, i) {
  template[d].splice(i, 1);
  templateChanged(d, old => old === i ? null : old > i ? old - 1 : old);
}

function moveTask(d, from, to) {
  if (from === to) return;
  const order = template[d].map((_, i) => i);
  const [t] = template[d].splice(from, 1);
  template[d].splice(to, 0, t);
  const [o] = order.splice(from, 1);
  order.splice(to, 0, o);
  const newIndex = {};
  order.forEach((old, pos) => { newIndex[old] = pos; });
  templateChanged(d, old => newIndex[old]);
}

// ---------------------------------------------------------------------
// Drag to reorder (mouse and touch). Drag by the element with class "handle".
// Keyboard: focus the handle and use the up / down arrow keys.
// ---------------------------------------------------------------------
let dragging = false;
let pendingRedraw = false;

function makeSortable(list, onMove, afterMove) {
  const items = () => [...list.children].filter(el => el.classList.contains("sortable"));

  list.querySelectorAll(".handle").forEach(handle => {
    handle.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const all = items();
      const li = handle.closest(".sortable");
      const from = all.indexOf(li);
      if (from < 0) return;
      const rects = all.map(el => { const r = el.getBoundingClientRect(); return { top: r.top + window.scrollY, h: r.height }; });
      const startY = e.pageY;
      let to = from;

      dragging = true;
      li.classList.add("dragging");
      document.body.classList.add("is-dragging");
      try { handle.setPointerCapture(e.pointerId); } catch {}

      const move = ev => {
        if (ev.clientY < 70) window.scrollBy(0, -12);
        else if (ev.clientY > window.innerHeight - 70) window.scrollBy(0, 12);
        const dy = ev.pageY - startY;
        li.style.transform = "translateY(" + dy + "px)";
        const centre = rects[from].top + dy + rects[from].h / 2;
        to = 0;
        all.forEach((el, j) => { if (j !== from && rects[j].top + rects[j].h / 2 < centre) to++; });
        all.forEach((el, j) => {
          if (j === from) return;
          let shift = 0;
          if (from < to && j > from && j <= to) shift = -rects[from].h;
          else if (to < from && j >= to && j < from) shift = rects[from].h;
          el.style.transform = shift ? "translateY(" + shift + "px)" : "";
        });
      };

      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        all.forEach(el => { el.style.transform = ""; });
        li.classList.remove("dragging");
        document.body.classList.remove("is-dragging");
        dragging = false;
        if (to !== from) { onMove(from, to); afterMove(to); }
        else if (pendingRedraw) afterMove(null);
        pendingRedraw = false;
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });

    handle.addEventListener("keydown", e => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const all = items();
      const from = all.indexOf(handle.closest(".sortable"));
      const to = from + (e.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= all.length) return;
      onMove(from, to);
      afterMove(to, true);
    });
  });
}

// After a keyboard move, put focus back on the moved item's handle
function refocusHandle(list, index, fromKeyboard) {
  if (!fromKeyboard || index === null) return;
  const el = [...list.children].filter(x => x.classList.contains("sortable"))[index];
  if (el) el.querySelector(".handle").focus();
}

// ---------------------------------------------------------------------
// Today view
// ---------------------------------------------------------------------
let currentKey = null;        // the date being shown
let offset = 0;               // days from today: 0 = today, 1 = tomorrow, -1 = yesterday
let lastToday = todayKey();   // to notice midnight
const MIN_OFFSET = -(KEEP_DAYS - 1);

function viewDate() { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset); return d; }

function relLabel(n) {
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  return n > 0 ? "In " + n + " days" : -n + " days ago";
}

function updateCount() {
  const tasks = template[viewDate().getDay()] || [];
  const ticked = (done[currentKey] || []).filter(i => i < tasks.length);
  const n = ticked.length, total = tasks.length;
  $("count").textContent = total ? n + " / " + total : "";

  // progress shown by the Atomic, Notebook and Midnight looks
  $("progress").classList.toggle("hidden", total === 0);
  const pills = $("progress-pills");
  if (pills.children.length !== total) {
    pills.innerHTML = "";
    for (let i = 0; i < total; i++) pills.appendChild(document.createElement("span"));
  }
  [...pills.children].forEach((p, i) => p.classList.toggle("on", i < n));
  $("progress-fill").style.width = total ? (n / total * 100) + "%" : "0";
  $("progress-text").textContent = total ? n + " of " + total + " done" : "";
}

function renderToday() {
  const now = viewDate();
  currentKey = dateKey(now);
  const dayIndex = now.getDay();
  const tasks = template[dayIndex] || [];
  const ticked = done[currentKey] || [];

  $("day-num").textContent = String(now.getDate()).padStart(2, "0");
  $("day-name").textContent = DAYS[dayIndex];
  $("month-year").textContent = now.toLocaleDateString("en-GB", { month: "short" }) + " " + now.getFullYear();
  $("full-date").textContent = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  $("rel-tag").textContent = relLabel(offset);
  $("date-header").classList.toggle("is-today", offset === 0);
  $("back-today").classList.toggle("hidden", offset === 0);
  $("prev-day").disabled = offset <= MIN_OFFSET;
  $("nav-today").classList.toggle("active", view === "today" && offset === 0);

  const list = $("task-list");
  list.innerHTML = "";

  if (tasks.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing set for " + DAYS[dayIndex] + ". Add tasks in Settings.";
    list.appendChild(li);
    updateCount();
    return;
  }

  tasks.forEach((text, i) => {
    const li = document.createElement("li");
    li.className = "task sortable" + (ticked.includes(i) ? " done" : "");

    // The number is the drag handle
    const num = document.createElement("button");
    num.type = "button";
    num.className = "num handle";
    num.innerHTML = '<span class="n">' + String(i + 1).padStart(2, "0") + "</span>" + HANDLE_GRIP;
    num.setAttribute("aria-label", "Move task " + (i + 1) + ". Drag, or use the up and down arrow keys");

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = ticked.includes(i);
    cb.addEventListener("change", () => toggle(i, cb.checked, li));

    const span = document.createElement("span");
    span.className = "text";
    span.textContent = text;

    const box = document.createElement("span");
    box.className = "box";
    box.innerHTML = CHECK_SVG;

    label.append(cb, span, box);
    li.append(num, label);
    list.appendChild(li);
  });

  makeSortable(list,
    (from, to) => moveTask(dayIndex, from, to),
    (to, kbd) => { renderToday(); refocusHandle($("task-list"), to, kbd); });
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
function settingsList(d) {
  return $("settings-days").children[ORDER.indexOf(d)].querySelector("ul");
}

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
      li.className = "sortable";

      const grip = document.createElement("button");
      grip.type = "button";
      grip.className = "grip handle";
      grip.innerHTML = GRIP_SVG;
      grip.setAttribute("aria-label", "Move " + text + ". Drag, or use the up and down arrow keys");

      // Click the text to edit it
      const span = document.createElement("button");
      span.type = "button";
      span.className = "task-text";
      span.textContent = text;
      span.title = "Click to edit";
      span.setAttribute("aria-label", "Edit " + text);
      span.addEventListener("click", () => startEdit(li, d, i));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "small-btn";
      del.textContent = "Remove";
      del.setAttribute("aria-label", "Remove " + text);
      del.addEventListener("click", () => { removeTask(d, i); renderSettings(); });

      li.append(grip, span, del);
      ul.appendChild(li);
    });

    const addLi = document.createElement("li");
    addLi.className = "add-row";
    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.placeholder = "Add a task…";
    addInput.setAttribute("aria-label", "New " + DAYS[d] + " task");
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "small-btn add";
    addBtn.textContent = "Add";
    const add = () => {
      const v = addInput.value.trim();
      if (!v) return;
      addTask(d, v);
      renderSettings();
      const fresh = settingsList(d).querySelector("input[placeholder]");
      if (fresh) fresh.focus();
    };
    addBtn.addEventListener("click", add);
    addInput.addEventListener("keydown", e => { if (e.key === "Enter") add(); });
    addLi.append(addInput, addBtn);
    ul.appendChild(addLi);

    block.appendChild(ul);
    wrap.appendChild(block);

    makeSortable(ul,
      (from, to) => moveTask(d, from, to),
      (to, kbd) => { renderSettings(); refocusHandle(settingsList(d), to, kbd); });
  });

  renderAccount();
}

// Turn a task row into a text box. Enter or clicking away saves, Esc cancels.
function startEdit(li, d, i) {
  if (li.classList.contains("editing")) return;
  li.classList.add("editing");
  const span = li.querySelector(".task-text");
  const input = document.createElement("input");
  input.type = "text";
  input.value = template[d][i];
  input.setAttribute("aria-label", "Edit task");
  span.replaceWith(input);

  let finished = false;
  const finish = keep => {
    if (finished) return;
    finished = true;
    if (keep) editTask(d, i, input.value.trim());
    renderSettings();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));

  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
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
  if (v === "today") { offset = 0; renderToday(); }
  if (v === "settings") renderSettings();
}

// Redraw after new data arrives, without interrupting a drag or an edit
function redraw(listsChanged) {
  if (dragging) { pendingRedraw = true; return; }
  if (view === "today") renderToday();
  if (view === "settings" && listsChanged) {
    const typing = document.activeElement && $("view-settings").contains(document.activeElement)
      && document.activeElement.tagName === "INPUT";
    if (!typing) renderSettings();
  }
}

$("nav-today").addEventListener("click", () => show("today"));
$("nav-settings").addEventListener("click", () => show("settings"));

// ---------------------------------------------------------------------
// Moving between days: arrows (desktop), swipe on the date (phone),
// left / right arrow keys
// ---------------------------------------------------------------------
function goToDay(newOffset) {
  newOffset = Math.max(MIN_OFFSET, newOffset);
  if (newOffset === offset) return false;
  const dir = newOffset > offset ? 1 : -1;
  offset = newOffset;
  renderToday();
  [$("date-inner"), $("task-list")].forEach(el => {
    el.style.transform = ""; el.style.opacity = "";
    if (el.animate) el.animate(
      [{ transform: "translateX(" + (dir * 40) + "px)", opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 220, easing: "ease-out" });
  });
  return true;
}

$("prev-day").addEventListener("click", () => goToDay(offset - 1));
$("next-day").addEventListener("click", () => goToDay(offset + 1));
$("back-today").addEventListener("click", () => goToDay(0));

document.addEventListener("keydown", e => {
  if (view !== "today" || dragging) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  e.preventDefault();
  goToDay(offset + (e.key === "ArrowRight" ? 1 : -1));
});

(function swipe() {
  const header = $("date-header");
  const inner = $("date-inner");
  let startX = null, startY = 0, dx = 0, mode = null; // mode: null | "x" | "y"

  header.addEventListener("pointerdown", e => {
    if (e.pointerType === "mouse") return;
    startX = e.clientX; startY = e.clientY; dx = 0; mode = null;
    inner.classList.remove("snap");
  });
  header.addEventListener("pointermove", e => {
    if (e.pointerType === "mouse" || startX === null) return;
    const mx = e.clientX - startX, my = e.clientY - startY;
    if (!mode && (Math.abs(mx) > 10 || Math.abs(my) > 10)) mode = Math.abs(mx) > Math.abs(my) ? "x" : "y";
    if (mode !== "x") return;
    dx = mx;
    // resist dragging past the oldest day we keep
    const blocked = dx > 0 && offset <= MIN_OFFSET;
    const shown = blocked ? dx * 0.2 : dx * 0.7;
    inner.style.transform = "translateX(" + shown + "px)";
    inner.style.opacity = String(Math.max(0.3, 1 - Math.abs(shown) / 300));
  });
  const finish = e => {
    if (e.pointerType === "mouse") return;
    const wasX = mode === "x";
    mode = null; startX = null;
    if (!wasX) return;
    const moved = Math.abs(dx) > 50 && goToDay(offset + (dx < 0 ? 1 : -1));
    if (!moved) {
      inner.classList.add("snap");
      inner.style.transform = ""; inner.style.opacity = "";
    }
  };
  header.addEventListener("pointerup", finish);
  header.addEventListener("pointercancel", finish);
})();

// New day while the tab is open → "today" moves on with it
setInterval(() => {
  if (todayKey() === lastToday) return;
  lastToday = todayKey();
  prune();
  if (view === "today" && !dragging) renderToday();
}, 30000);

// ---------------------------------------------------------------------
// Look (Swiss / Atomic / Notebook / Midnight) and Appearance (Auto / Light / Dark)
// Saved on this device. Applied early in index.html too, so there's no flash.
// ---------------------------------------------------------------------
const THEMES = ["swiss", "atomic", "notebook", "midnight"];
const MODES = ["auto", "light", "dark"];
const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function lsGet(k, fallback) { try { return localStorage.getItem(k) || fallback; } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

let theme = THEMES.includes(lsGet("checklist.theme")) ? lsGet("checklist.theme") : "swiss";
let mode = MODES.includes(lsGet("checklist.mode")) ? lsGet("checklist.mode") : "auto";

function applyLook() {
  const dark = mode === "dark" || (mode === "auto" && !!darkQuery && darkQuery.matches);
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-mode", dark ? "dark" : "light");
  // browser/phone toolbar colour
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getComputedStyle(root).getPropertyValue("--bg").trim() || "#FFFFFF");
  document.querySelectorAll("[data-theme-option]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.themeOption === theme)));
  document.querySelectorAll("[data-mode-option]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.modeOption === mode)));
}

document.querySelectorAll("[data-theme-option]").forEach(b => b.addEventListener("click", () => {
  theme = b.dataset.themeOption; lsSet("checklist.theme", theme); applyLook();
}));
document.querySelectorAll("[data-mode-option]").forEach(b => b.addEventListener("click", () => {
  mode = b.dataset.modeOption; lsSet("checklist.mode", mode); applyLook();
}));
// In Auto, follow the phone / computer when it switches between light and dark
if (darkQuery) {
  const onChange = () => { if (mode === "auto") applyLook(); };
  if (darkQuery.addEventListener) darkQuery.addEventListener("change", onChange);
  else if (darkQuery.addListener) darkQuery.addListener(onChange);
}
applyLook();

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
