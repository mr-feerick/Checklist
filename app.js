// =====================================================================
// Daily Checklist
// - Weekly template: each weekday has its own list, repeated every week
// - Ticks are stored per calendar date, so every day starts fresh
// - Saves to Supabase when config.js is filled in, otherwise this browser
// =====================================================================

const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const ORDER = [1,2,3,4,5,6,0];          // Monday first in Settings
const KEEP_DAYS = 63;                   // how many days of ticks to keep (9 weeks, for the Week page)
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
// A weekly task is { t: "text", s: ["step", "step"] }. Older saves were plain strings.
function normItem(x) {
  if (typeof x === "string") return { t: x, s: [] };
  if (x && typeof x.t === "string") return { t: x.t, s: Array.isArray(x.s) ? x.s.map(String) : [] };
  return { t: String(x), s: [] };
}
function normalize(t) {
  const out = {};
  for (let i = 0; i < 7; i++) out[i] = Array.isArray(t && t[i]) ? t[i].map(normItem) : [];
  return out;
}

// Step ticks are stored alongside task ticks: task i → i, step j of task i → (i+1)*1000 + j
const SUB = 1000;
const encStep = (i, j) => (i + 1) * SUB + j;
const isStep = idx => idx >= SUB;
const decStep = idx => [Math.floor(idx / SUB) - 1, idx % SUB];
function dateKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function daysAgoKey(n) { const d = new Date(); d.setDate(d.getDate() - n); return dateKey(d); }
function todayKey() { return dateKey(new Date()); }
function keyWeekday(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).getDay(); }

let template = normalize(load(LS_TEMPLATE, null));
let done = load(LS_DONE, {});

// "Just today" tasks: [{ id, text, day, done_on, position }]
// day = the date it was added for; done_on = the date it was ticked (or null).
// It shows on every date from `day` until the date it's ticked — that's the carry-over.
const LS_ONEOFFS = "checklist.oneoffs";
const LS_ONEOFF_DELETED = "checklist.oneoffs.deleted";   // removals not yet sent online
const LS_ONEOFF_SYNCED = "checklist.oneoffs.synced";     // local ones have been uploaded once
let oneoffs = cleanOneoffs(load(LS_ONEOFFS, []));
let oneoffDeleted = load(LS_ONEOFF_DELETED, []);
let oneoffSyncOff = false;   // true when the oneoffs table hasn't been set up in Supabase yet

function cleanSubs(list) {
  return (Array.isArray(list) ? list : [])
    .filter(s => s && typeof s.text === "string")
    .map(s => ({ text: s.text, done_on: s.done_on || null }));
}
function cleanOneoffs(list) {
  return (Array.isArray(list) ? list : [])
    .filter(o => o && o.id && typeof o.text === "string" && o.day)
    .map(o => ({ id: o.id, text: o.text, day: o.day, done_on: o.done_on || null, position: Number(o.position) || 0, subs: cleanSubs(o.subs) }))
    .sort((a, b) => a.position - b.position);
}
let oneoffSubsOff = false;   // true when the oneoffs table has no "subs" column yet
const LS_SUBS_PENDING = "checklist.oneoffs.subsPending";   // steps made while that column was missing

function prune() {
  const cutoff = daysAgoKey(KEEP_DAYS);
  Object.keys(done).forEach(k => { if (k < cutoff) delete done[k]; });
  oneoffs = oneoffs.filter(o => !o.done_on || o.done_on >= cutoff);
}
function saveLocal() {
  prune();
  save(LS_TEMPLATE, template); save(LS_DONE, done);
  save(LS_ONEOFFS, oneoffs); save(LS_ONEOFF_DELETED, oneoffDeleted);
}

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.random() * 256 | 0;
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}
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

// "Just today" tasks
function oneoffRow(o) {
  const row = { id: o.id, user_id: user.id, text: o.text, day: o.day, done_on: o.done_on, position: o.position };
  if (!oneoffSubsOff) row.subs = o.subs || [];
  return row;
}
function isMissingSubsColumn(e) {
  const msg = (e && (e.message || "")) + " " + (e && e.details || "");
  return !!e && (e.code === "42703" || e.code === "PGRST204" || (/subs/i.test(msg) && /column/i.test(msg)));
}
async function oneoffTry(fn) {
  if (oneoffSyncOff) return;
  try { await fn(); }
  catch (e) { if (isMissingTable(e)) { oneoffSyncOff = true; return; } throw e; }
}
async function pushOneoffs(list) {
  if (!list.length) return;
  if (oneoffSubsOff && list.some(o => o.subs && o.subs.length)) save(LS_SUBS_PENDING, true);
  await oneoffTry(async () => {
    try { await must(db.from("oneoffs").upsert(list.map(oneoffRow))); }
    catch (e) {
      if (oneoffSubsOff || !isMissingSubsColumn(e)) throw e;
      oneoffSubsOff = true;   // steps stay on this device until the SQL is re-run
      if (list.some(o => o.subs && o.subs.length)) save(LS_SUBS_PENDING, true);
      await must(db.from("oneoffs").upsert(list.map(oneoffRow)));
    }
  });
}
async function pushOneoffDeletes() {
  if (!oneoffDeleted.length) return;
  await oneoffTry(async () => {
    const ids = oneoffDeleted.slice();
    await must(db.from("oneoffs").delete().eq("user_id", user.id).in("id", ids));
    oneoffDeleted = oneoffDeleted.filter(id => !ids.includes(id));
    save(LS_ONEOFF_DELETED, oneoffDeleted);
  });
}
function isMissingTable(e) {
  const msg = (e && (e.message || "")) + " " + (e && e.details || "");
  return !!e && (e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST202" ||
    (/oneoffs/i.test(msg) && /(does not exist|could not find|schema cache)/i.test(msg)));
}

// Send everything this device has (used after being offline)
async function pushEverything() {
  await pushTemplate();
  await must(db.from("ticks").delete().eq("user_id", user.id).gte("day", daysAgoKey(KEEP_DAYS)));
  const rows = [];
  Object.keys(done).forEach(day => (done[day] || []).forEach(idx => rows.push({ user_id: user.id, day, idx })));
  if (rows.length) await must(db.from("ticks").insert(rows));
  await pushOneoffDeletes();
  await pushOneoffs(oneoffs);
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

    await pullOneoffs();

    saveLocal();
    setStatus("Saved");

    // Old ticks and finished one-offs: tidy up on the server too (not urgent if it fails)
    db.from("ticks").delete().eq("user_id", user.id).lt("day", daysAgoKey(KEEP_DAYS)).then(() => {}, () => {});
    if (!oneoffSyncOff) db.from("oneoffs").delete().eq("user_id", user.id).lt("done_on", daysAgoKey(KEEP_DAYS)).then(() => {}, () => {});

    redraw(before !== JSON.stringify(template));
  } catch (e) {
    console.warn("Load failed", e);
    setStatus("Offline", true);
  }
}

// Fetch "just today" tasks. If the table isn't set up yet, keep them on this device only.
async function pullOneoffs() {
  try {
    let rows;
    try {
      rows = await must(db.from("oneoffs").select("id,text,day,done_on,position,subs").eq("user_id", user.id).order("position"));
      oneoffSubsOff = false;
      // Steps added while the column was missing: put them back and upload them now
      if (load(LS_SUBS_PENDING, false) === true) {
        const local = Object.fromEntries(oneoffs.map(o => [o.id, o.subs || []]));
        const fixed = [];
        rows = rows.map(r => {
          const ls = local[r.id];
          if ((!r.subs || !r.subs.length) && ls && ls.length) { const nr = { ...r, subs: ls }; fixed.push(nr.id); return nr; }
          return r;
        });
        if (fixed.length) await pushOneoffs(cleanOneoffs(rows.filter(r => fixed.includes(r.id))));
        save(LS_SUBS_PENDING, false);
      }
    } catch (e) {
      if (!isMissingSubsColumn(e)) throw e;
      oneoffSubsOff = true;
      if (oneoffs.some(o => o.subs && o.subs.length)) save(LS_SUBS_PENDING, true);
      rows = await must(db.from("oneoffs").select("id,text,day,done_on,position").eq("user_id", user.id).order("position"));
      // keep the steps this device knows about
      const local = Object.fromEntries(oneoffs.map(o => [o.id, o.subs || []]));
      rows = rows.map(r => ({ ...r, subs: local[r.id] || [] }));
    }
    oneoffSyncOff = false;
    // First time online: upload anything this device already had
    if (load(LS_ONEOFF_SYNCED, false) !== true) {
      const serverIds = new Set((rows || []).map(r => r.id));
      const localOnly = oneoffs.filter(o => !serverIds.has(o.id));
      if (localOnly.length) await pushOneoffs(localOnly);
      save(LS_ONEOFF_SYNCED, true);
      oneoffs = cleanOneoffs([...(rows || []), ...localOnly]);
    } else {
      oneoffs = cleanOneoffs(rows);
    }
    if (channel) listenOneoffs();   // table just became available → start live updates
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    oneoffSyncOff = true;   // carry on with the local copy
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
  if (oneoffChannel) { db.removeChannel(oneoffChannel); oneoffChannel = null; }
  listenOneoffs();
}
let oneoffChannel = null;
function listenOneoffs() {
  if (oneoffChannel || oneoffSyncOff || !db || !user) return;
  oneoffChannel = db.channel("checklist-oneoffs-" + user.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "oneoffs", filter: "user_id=eq." + user.id }, scheduleRefresh)
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
  if (oneoffChannel) { db.removeChannel(oneoffChannel); oneoffChannel = null; }
  template = normalize(null);
  done = {};
  oneoffs = [];
  oneoffDeleted = [];
  save(LS_ONEOFF_SYNCED, false);
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

// remap: function(oldTaskIndex) → newIndex, or null if that task was removed.
// stepRemap: function(oldTaskIndex, oldStepIndex) → newStepIndex, or null if removed.
// Keeps ticks attached to the right tasks and steps on every date that uses this weekday.
function templateChanged(d, remap, stepRemap) {
  let keys = [];
  if (typeof remap === "function" || typeof stepRemap === "function") {
    const tr = typeof remap === "function" ? remap : i => i;
    const sr = typeof stepRemap === "function" ? stepRemap : (i, j) => j;
    keys = Object.keys(done).filter(k => keyWeekday(k) === d);
    keys.forEach(k => {
      done[k] = done[k].map(idx => {
        if (idx < 0) return idx;                       // carry-over marker, not a task
        if (!isStep(idx)) return tr(idx);
        const [i, j] = decStep(idx);
        const ni = tr(i), nj = sr(i, j);
        return ni === null || ni === undefined || nj === null || nj === undefined ? null : encStep(ni, nj);
      }).filter(v => v !== null && v !== undefined);
    });
  }
  saveLocal();

  sync(async () => {
    await pushTemplate();
    await pushTicks(keys);
  });
}

function addTask(d, text) {
  template[d].push({ t: text, s: [] });
  templateChanged(d);
}

function editTask(d, i, text) {
  if (!text || text === template[d][i].t) return;
  template[d][i].t = text;
  templateChanged(d);
}

function addStep(d, i, text) {
  template[d][i].s.push(text);
  templateChanged(d);
}
function editStep(d, i, j, text) {
  if (!text || text === template[d][i].s[j]) return;
  template[d][i].s[j] = text;
  templateChanged(d);
}
function removeStep(d, i, j) {
  const text = template[d][i].s[j];
  const saved = savedTicks(d, idx => idx === encStep(i, j));
  template[d][i].s.splice(j, 1);
  templateChanged(d, null, (ti, sj) => ti !== i ? sj : sj === j ? null : sj > j ? sj - 1 : sj);
  offerUndo(text, () => {
    if (!template[d][i]) return;
    template[d][i].s.splice(j, 0, text);
    restoreTicks(d, saved, idx => isStep(idx) && decStep(idx)[0] === i && decStep(idx)[1] >= j ? encStep(i, decStep(idx)[1] + 1) : idx);
  });
}

function removeTask(d, i) {
  const item = JSON.parse(JSON.stringify(template[d][i]));
  const saved = savedTicks(d, idx => isStep(idx) ? decStep(idx)[0] === i : idx === i);
  template[d].splice(i, 1);
  templateChanged(d, old => old === i ? null : old > i ? old - 1 : old);
  offerUndo(item.t, () => {
    template[d].splice(Math.min(i, template[d].length), 0, item);
    restoreTicks(d, saved, idx => {
      if (!isStep(idx)) return idx >= i ? idx + 1 : idx;
      const [ti, sj] = decStep(idx);
      return ti >= i ? encStep(ti + 1, sj) : idx;
    });
  });
}

// ----- Undo helpers for weekly tasks: keep the ticks that a delete removed -----
function savedTicks(d, match) {
  const out = {};
  Object.keys(done).filter(k => keyWeekday(k) === d).forEach(k => {
    const hit = done[k].filter(match);
    if (hit.length) out[k] = hit;
  });
  return out;
}
function restoreTicks(d, saved, shift) {
  const keys = Object.keys(done).filter(k => keyWeekday(k) === d);
  Object.keys(saved).forEach(k => { if (!keys.includes(k)) keys.push(k); });
  keys.forEach(k => { done[k] = (done[k] || []).map(x => x < 0 ? x : shift(x)).concat(saved[k] || []); });
  saveLocal();
  sync(async () => { await pushTemplate(); await pushTicks(keys); });
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
        // where the pointer is decides the new position (works for tall, opened rows too)
        const y = ev.pageY;
        to = 0;
        all.forEach((el, j) => { if (j !== from && rects[j].top + rects[j].h / 2 < y) to++; });
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

// ----- task status (with steps) -----
function weeklyStatus(item, i, ticked) {
  const n = item.s.length;
  if (!n) return { complete: ticked.includes(i), partial: false, k: 0, n: 0 };
  const k = item.s.filter((_, j) => ticked.includes(encStep(i, j))).length;
  return { complete: k === n, partial: k > 0 && k < n, k, n };
}
function stepDoneOn(s, key) { return !!s.done_on && s.done_on <= key; }
function oneoffStatus(o, key) {
  const n = (o.subs || []).length;
  if (!n) return { complete: o.done_on === key, partial: false, k: 0, n: 0 };
  const k = o.subs.filter(s => stepDoneOn(s, key)).length;
  return { complete: k === n, partial: k > 0 && k < n, k, n };
}

// Which rows are folded open (remembered on this device)
let openRows = new Set(load("checklist.open", []));
let addingKey = null;   // the row whose "add a step" box is showing
function setOpen(key, isOpen) {
  isOpen ? openRows.add(key) : openRows.delete(key);
  save("checklist.open", [...openRows].slice(-200));
}

const CHEVRON = '<svg class="chev" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M6 9l6 6 6-6"></path></svg>';
const SMALL_X = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M6 6l12 12M18 6L6 18"></path></svg>';

// One task row. cfg: { cls, handleHTML, handleLabel, text, tag, status, onToggle(checked),
//   steps:[{text, done}], stepNum(j), onStep(j, checked), onAddStep(text), onRemoveStep(j),
//   openKey, alwaysShowSteps, onRemove }
function buildTaskRow(cfg) {
  const li = document.createElement("li");
  const st = cfg.status;
  // finished tasks sit at the bottom and can't be dragged
  const locked = st.complete;
  li.className = "task " + (locked ? "locked " : "sortable ") + (cfg.cls || "") + (st.complete ? " done" : "") + (st.partial ? " partial" : "") +
    (cfg.steps.length ? " has-steps" : "") + (openRows.has(cfg.openKey) ? " open" : "");
  if (cfg.key) li.dataset.key = cfg.key;

  const handle = document.createElement(locked ? "span" : "button");
  if (!locked) handle.type = "button";
  handle.className = locked ? "num" : "num handle";
  handle.innerHTML = cfg.handleHTML + HANDLE_GRIP;
  if (locked) handle.setAttribute("aria-hidden", "true");
  else handle.setAttribute("aria-label", cfg.handleLabel);

  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = st.complete;
  cb.addEventListener("change", () => cfg.onToggle(cb.checked, li));
  const text = document.createElement("span");
  text.className = "text";
  const words = document.createElement("span");
  words.className = "words";
  words.textContent = cfg.text;
  text.appendChild(words);
  if (cfg.tag) {
    const tag = document.createElement("span");
    tag.className = "carried";
    tag.textContent = cfg.tag;
    text.appendChild(tag);
  }
  const box = document.createElement("span");
  box.className = "box";
  box.innerHTML = CHECK_SVG + '<span class="dash"></span>';
  label.append(cb, text, box);
  li.append(handle, label);

  const canAdd = typeof cfg.onAddStep === "function";
  if (canAdd && addingKey === cfg.openKey) li.classList.add("open", "adding");

  // small "+" next to the number: add a step
  if (canAdd) {
    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "add-step-btn";
    plus.setAttribute("aria-label", "Add a step to " + cfg.text);
    plus.innerHTML = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M12 5v14M5 12h14"></path></svg>';
    plus.addEventListener("click", () => {
      addingKey = cfg.openKey;
      li.classList.add("open", "adding");
      setOpen(cfg.openKey, true);
      const tg = li.querySelector(":scope > .step-toggle");
      if (tg) tg.setAttribute("aria-expanded", "true");
      const inp = li.querySelector(".step-add input");
      if (inp) inp.focus();
    });
    li.insertBefore(plus, label);
  }

  // fold-out toggle "1/3 ▾" — only on tasks that have steps
  if (cfg.steps.length) {
    const tog = document.createElement("button");
    tog.type = "button";
    tog.className = "step-toggle";
    tog.setAttribute("aria-expanded", String(li.classList.contains("open")));
    tog.setAttribute("aria-label", "Steps for " + cfg.text);
    tog.innerHTML = '<span class="step-count"></span>' + CHEVRON;
    tog.querySelector(".step-count").textContent = st.k + "/" + st.n;
    tog.addEventListener("click", e => {
      e.preventDefault();
      const nowOpen = !li.classList.contains("open");
      li.classList.toggle("open", nowOpen);
      if (!nowOpen) { li.classList.remove("adding"); if (addingKey === cfg.openKey) addingKey = null; }
      tog.setAttribute("aria-expanded", String(nowOpen));
      setOpen(cfg.openKey, nowOpen);
    });
    li.appendChild(tog);
  }

  if (cfg.onRemove) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "oneoff-remove";
    del.setAttribute("aria-label", "Delete " + cfg.text);
    del.innerHTML = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
    del.addEventListener("click", cfg.onRemove);
    li.appendChild(del);
  }

  // the steps
  const ul = document.createElement("ul");
  ul.className = "steps";
  cfg.steps.forEach((s, j) => {
    const sli = document.createElement("li");
    sli.className = "step" + (s.done ? " done" : "");
    const sl = document.createElement("label");
    const scb = document.createElement("input");
    scb.type = "checkbox";
    scb.checked = s.done;
    scb.addEventListener("change", () => cfg.onStep(j, scb.checked, sli, li));
    const num = document.createElement("span");
    num.className = "step-num";
    num.textContent = cfg.stepNum(j);
    const stx = document.createElement("span");
    stx.className = "step-text";
    stx.textContent = s.text;
    const sbox = document.createElement("span");
    sbox.className = "box small";
    sbox.innerHTML = CHECK_SVG;
    sl.append(scb, num, stx, sbox);
    sli.appendChild(sl);
    if (cfg.onRemoveStep) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "step-remove";
      x.setAttribute("aria-label", "Delete step " + s.text);
      x.innerHTML = SMALL_X;
      x.addEventListener("click", () => cfg.onRemoveStep(j));
      sli.appendChild(x);
    }
    ul.appendChild(sli);
  });
  if (canAdd) {
    const ali = document.createElement("li");
    ali.className = "step-add";
    const form = document.createElement("form");
    form.autocomplete = "off";
    form.innerHTML = '<span class="step-num" aria-hidden="true">+</span>';
    const inp = document.createElement("input");
    inp.type = "text";
    inp.maxLength = 200;
    inp.placeholder = cfg.addPlaceholder || "Add a step…";
    inp.setAttribute("aria-label", "New step for " + cfg.text);
    const btn = document.createElement("button");
    btn.type = "submit";
    btn.className = "small-btn add";
    btn.textContent = "Add";
    form.append(inp, btn);
    form.addEventListener("submit", e => {
      e.preventDefault();
      const v = inp.value.trim();
      if (!v) return;
      addingKey = cfg.openKey;   // keep the box open for the next step
      cfg.onAddStep(v);
    });
    // Esc, or leaving the box empty, closes it again
    const stopAdding = () => {
      if (addingKey === cfg.openKey) addingKey = null;
      li.classList.remove("adding");
      if (!cfg.steps.length) { li.classList.remove("open"); setOpen(cfg.openKey, false); }
    };
    inp.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); inp.value = ""; stopAdding(); inp.blur(); } });
    inp.addEventListener("blur", () => setTimeout(() => {
      if (!inp.isConnected || document.activeElement === inp || inp.value.trim()) return;
      if (form.contains(document.activeElement)) return;
      stopAdding();
    }, 150));
    ali.appendChild(form);
    ul.appendChild(ali);
  }
  li.appendChild(ul);
  return li;
}

// Update a row's look after its steps change, without redrawing (keeps the fade smooth)
function refreshRow(li, st) {
  li.classList.toggle("done", st.complete);
  li.classList.toggle("partial", st.partial);
  const cb = li.querySelector(":scope > label input");
  if (cb) cb.checked = st.complete;
  const c = li.querySelector(":scope > .step-toggle .step-count");
  if (c && st.n) c.textContent = st.k + "/" + st.n;
}

// After a tick, let the fade play, then move rows to their new places with a slide
let settleTimer = null;
function scheduleSettle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, 550);
}
function typingInLists() {
  const a = document.activeElement;
  return !!a && a.tagName === "INPUT" && a.type === "text" && !!a.closest("#task-list, #oneoff-list") && a.value.trim() !== "";
}
// Redraw Today, keeping the cursor in the same row's box or checkbox
function renderTodayKeepFocus() {
  const a = document.activeElement;
  const row = a && a.closest ? a.closest("li.task[data-key]") : null;
  const key = row ? row.dataset.key : null;
  const inStepBox = !!(a && a.closest && a.closest(".step-add"));
  renderToday();
  if (!key) return;
  const r = document.querySelector('li.task[data-key="' + key + '"]');
  const target = r && (inStepBox ? r.querySelector(".step-add input") : r.querySelector(":scope > label > input"));
  if (target) target.focus({ preventScroll: true });
}
function settle() {
  if (dragging) { scheduleSettle(); return; }
  // don't wipe a step you're halfway through typing — wait until you leave the box
  if (typingInLists()) {
    document.activeElement.addEventListener("blur", () => setTimeout(scheduleSettle, 200), { once: true });
    return;
  }
  const lists = [$("task-list"), $("oneoff-list")];
  const before = {};
  lists.forEach(l => l.querySelectorAll(":scope > li.task[data-key]").forEach(li => { before[li.dataset.key] = li.getBoundingClientRect().top; }));
  renderTodayKeepFocus();
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  lists.forEach(l => l.querySelectorAll(":scope > li.task[data-key]").forEach(li => {
    const old = before[li.dataset.key];
    if (old === undefined || reduce) return;
    const dy = old - li.getBoundingClientRect().top;
    if (Math.abs(dy) > 1 && li.animate) li.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.7,.2,1)" });
  }));
}

// After adding a step, keep the cursor in that row's step box
function refocusStepInput(listId, key) {
  const row = $(listId).querySelector(':scope > li.task[data-key="' + key + '"]');
  const inp = row && row.querySelector(".step-add input");
  if (inp) inp.focus();
}

function tallySVG(n, total) {
  if (!total) return "";
  const tilt = [0.8, -0.5, 1, -0.7];
  let lines = "";
  for (let k = 0; k < total; k++) {
    const g = Math.floor(k / 5), i = k % 5, x0 = g * 60, cls = k < n ? "on" : "off";
    if (i < 4) {
      const x = x0 + 7 + i * 11, t = tilt[i];
      lines += '<line class="' + cls + '" x1="' + (x - t) + '" y1="4" x2="' + (x + t) + '" y2="30"></line>';
    } else {
      lines += '<line class="' + cls + '" x1="' + (x0 + 1) + '" y1="25" x2="' + (x0 + 47) + '" y2="9"></line>';
    }
  }
  const w = Math.ceil(total / 5) * 60;
  return '<svg aria-hidden="true" width="' + w + '" height="34" viewBox="0 0 ' + w + ' 34">' + lines + "</svg>";
}

function updateCount() {
  const tasks = template[viewDate().getDay()] || [];
  const tickedNow = done[currentKey] || [];
  const wDone = tasks.filter((it, i) => weeklyStatus(it, i, tickedNow).complete).length;
  const wTotal = tasks.length;
  const oList = oneoffOn ? oneoffsFor(currentKey) : [];
  const oDone = oList.filter(o => oneoffStatus(o, currentKey).complete).length;
  const oTotal = oList.length;

  // nav counter (Swiss): everything on the day
  const all = wTotal + oTotal;
  $("count").textContent = all ? (wDone + oDone) + " / " + all : "";
  $("tab-weekly-count").textContent = wTotal ? wDone + " / " + wTotal : "";
  $("tab-oneoff-count").textContent = oTotal ? oDone + " / " + oTotal : "";
  // Midnight's desktop ring: everything done today, across both lists
  const ringPct = all ? Math.round((wDone + oDone) / all * 100) : 0;
  $("panel-ring").style.setProperty("--pct", ringPct);
  $("ring-n").textContent = all ? String(wDone + oDone) : "–";
  $("ring-of").textContent = all ? "of " + all + " done" : "nothing set";

  // a dot on any tab that still has something left to do
  $("tab-weekly").classList.toggle("has-left", wDone < wTotal);
  $("tab-oneoff").classList.toggle("has-left", oDone < oTotal);

  // progress bar / pills follow whichever list is showing
  const showingOneoff = oneoffOn && activeTab === "oneoff";
  const n = showingOneoff ? oDone : wDone;
  const total = showingOneoff ? oTotal : wTotal;

  // progress shown by the Atomic, Notebook and Midnight looks
  $("progress").classList.toggle("hidden", total === 0);
  const pills = $("progress-pills");
  if (pills.children.length !== total) {
    pills.innerHTML = "";
    for (let i = 0; i < total; i++) pills.appendChild(document.createElement("span"));
  }
  [...pills.children].forEach((p, i) => p.classList.toggle("on", i < n));
  $("progress-fill").style.width = total ? (n / total * 100) + "%" : "0";
  $("progress-text").textContent = total ? n + " of " + total + (theme === "notebook" ? " ticked off" : " done") : "";
  // Swiss: "3 left" beside the blocks
  $("progress-left").textContent = !total ? "" : n === total ? "All done" : (total - n) + " left";
  // Notebook: hand-drawn tally marks, grouped in fives (ink = done, pencil = to do)
  $("progress-tally").innerHTML = tallySVG(n, total);
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

  // tabs (only when the "just today" list is switched on)
  $("view-today").classList.toggle("with-tabs", oneoffOn);
  document.body.classList.toggle("with-tabs", oneoffOn);
  $("list-tabs").classList.toggle("hidden", !oneoffOn);
  $("tab-weekly-name").textContent = "Every " + DAYS[dayIndex];
  $("tab-oneoff-name").textContent = offset === 0 ? "Just today" : "Just " + DAYS[dayIndex];
  const showOneoff = oneoffOn && activeTab === "oneoff";
  $("tab-weekly").setAttribute("aria-selected", String(!showOneoff));
  $("tab-oneoff").setAttribute("aria-selected", String(showOneoff));
  $("task-list").classList.toggle("hidden", showOneoff);
  $("oneoff-panel").classList.toggle("hidden", !showOneoff);
  renderOneoffs();
  renderCarry();

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

  // active tasks first (in your order), finished ones underneath
  const wActive = [], wDoneIdx = [];
  tasks.forEach((item, i) => (weeklyStatus(item, i, ticked).complete ? wDoneIdx : wActive).push(i));
  [...wActive, ...wDoneIdx].forEach((i, pos) => {
    const item = tasks[i];
    const nn = String(pos + 1).padStart(2, "0");
    list.appendChild(buildTaskRow({
      key: "w" + i,
      handleHTML: '<span class="n">' + nn + "</span>",
      handleLabel: "Move task " + (pos + 1) + ". Drag, or use the up and down arrow keys",
      text: item.t,
      status: weeklyStatus(item, i, ticked),
      onToggle: (checked, li) => toggle(i, checked, li),
      steps: item.s.map((s, j) => ({ text: s, done: ticked.includes(encStep(i, j)) })),
      stepNum: j => nn + "." + (j + 1),
      onStep: (j, checked, sli, li) => toggleStep(i, j, checked, sli, li),
      onAddStep: v => { addStep(dayIndex, i, v); renderToday(); refocusStepInput("task-list", "w" + i); },
      addPlaceholder: "Add a step (every " + DAYS[dayIndex] + ")…",
      openKey: "w" + dayIndex + ":" + item.t
    }));
  });

  // only active tasks can be dragged; positions map back to your real order
  makeSortable(list,
    (from, to) => moveTask(dayIndex, wActive[from], wActive[to]),
    (to, kbd) => { renderToday(); refocusHandle($("task-list"), to, kbd); });
  updateCount();
}

function toggle(i, checked, li) {
  const day = currentKey;
  const item = template[viewDate().getDay()][i];
  const set = new Set(done[day] || []);

  if (item && item.s.length) {
    // ticking a task with steps ticks (or unticks) all its steps
    item.s.forEach((_, j) => checked ? set.add(encStep(i, j)) : set.delete(encStep(i, j)));
    done[day] = [...set];
    saveLocal();
    li.querySelectorAll(".steps li.step").forEach(s => {
      s.classList.toggle("done", checked);
      const c = s.querySelector("input"); if (c) c.checked = checked;
    });
    refreshRow(li, weeklyStatus(item, i, done[day]));
    updateCount();
    scheduleSettle();
    sync(() => pushTicks([day]));
    return;
  }

  checked ? set.add(i) : set.delete(i);
  done[day] = [...set];
  saveLocal();
  li.classList.toggle("done", checked);
  updateCount();
  scheduleSettle();

  sync(async () => {
    if (checked) await must(db.from("ticks").upsert({ user_id: user.id, day, idx: i }, { ignoreDuplicates: true }));
    else await must(db.from("ticks").delete().eq("user_id", user.id).eq("day", day).eq("idx", i));
  });
}

function toggleStep(i, j, checked, sli, li) {
  const day = currentKey;
  const item = template[viewDate().getDay()][i];
  const idx = encStep(i, j);
  const set = new Set(done[day] || []);
  checked ? set.add(idx) : set.delete(idx);
  done[day] = [...set];
  saveLocal();
  sli.classList.toggle("done", checked);
  refreshRow(li, weeklyStatus(item, i, done[day]));
  updateCount();
  scheduleSettle();

  sync(async () => {
    if (checked) await must(db.from("ticks").upsert({ user_id: user.id, day, idx }, { ignoreDuplicates: true }));
    else await must(db.from("ticks").delete().eq("user_id", user.id).eq("day", day).eq("idx", idx));
  });
}

// ---------------------------------------------------------------------
// "Just today" list
// ---------------------------------------------------------------------
let oneoffOn = lsGetRaw("checklist.oneoffs.on") !== "off";
let activeTab = lsGetRaw("checklist.tab") === "oneoff" ? "oneoff" : "weekly";
function lsGetRaw(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSetRaw(k, v) { try { localStorage.setItem(k, v); } catch {} }

// What's on the list for a given date: added on/before it, and not ticked before it
function oneoffsFor(key) {
  return oneoffs.filter(o => o.day <= key && (!o.done_on || o.done_on >= key));
}

function fromLabel(day, key) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12);
  const [y2, m2, d2] = key.split("-").map(Number);
  const gap = Math.round((new Date(y2, m2 - 1, d2, 12) - dt) / 86400000);
  if (gap === 1) return "From yesterday";
  if (gap < 7) return "From " + dt.toLocaleDateString("en-GB", { weekday: "short" });
  return "From " + dt.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function renderOneoffs() {
  const list = $("oneoff-list");
  list.innerHTML = "";
  const items = oneoffsFor(currentKey);
  const past = offset < 0;

  $("oneoff-add").classList.toggle("hidden", past);
  $("oneoff-input").placeholder = offset === 0 ? "Add something for today…" : "Add something for " + DAYS[viewDate().getDay()] + "…";
  $("oneoff-note").textContent = past
    ? "What was on the list that day."
    : "Ticked ones clear the next day. Unticked ones carry over.";
  if (SYNC_ON && user && oneoffSyncOff) {
    $("oneoff-note").textContent += " Saved on this device only until supabase-oneoffs.sql has been run.";
  } else if (SYNC_ON && user && oneoffSubsOff) {
    $("oneoff-note").textContent += " Steps are saved on this device only until supabase-oneoffs.sql is run again.";
  }

  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = past ? "Nothing extra that day." : "Nothing extra yet. Add something below.";
    list.appendChild(li);
    return;
  }

  const oActive = items.filter(o => !oneoffStatus(o, currentKey).complete);
  const oFinished = items.filter(o => oneoffStatus(o, currentKey).complete);
  [...oActive, ...oFinished].forEach((o, pos) => {
    const nn = String(pos + 1).padStart(2, "0");
    list.appendChild(buildTaskRow({
      key: "o" + o.id,
      cls: "oneoff",
      handleHTML: '<span class="n">' + nn + "</span>",
      handleLabel: "Move " + o.text + ". Drag, or use the up and down arrow keys",
      text: o.text,
      tag: o.day < currentKey ? fromLabel(o.day, currentKey) : "",
      status: oneoffStatus(o, currentKey),
      onToggle: (checked, li) => toggleOneoff(o.id, checked, li),
      steps: (o.subs || []).map(s => ({ text: s.text, done: stepDoneOn(s, currentKey) })),
      stepNum: j => nn + "." + (j + 1),
      onStep: (j, checked, sli, li) => toggleOneoffStep(o.id, j, checked, sli, li),
      onAddStep: past ? null : v => { addOneoffStep(o.id, v); renderToday(); refocusStepInput("oneoff-list", "o" + o.id); },
      onRemoveStep: past ? null : j => removeOneoffStep(o.id, j),
      openKey: "o" + o.id,
      onRemove: () => removeOneoff(o.id)
    }));
  });

  const ids = oActive.map(o => o.id);
  makeSortable(list,
    (from, to) => moveOneoff(ids, from, to),
    (to, kbd) => { renderToday(); refocusHandle($("oneoff-list"), to, kbd); });
}

function addOneoff(text) {
  const position = oneoffs.reduce((m, o) => Math.max(m, o.position), -1) + 1;
  const o = { id: newId(), text, day: currentKey, done_on: null, position, subs: [] };
  oneoffs.push(o);
  saveLocal();
  renderToday();
  sync(() => pushOneoffs([o]));
}

function toggleOneoff(id, checked, li) {
  const o = oneoffs.find(x => x.id === id);
  if (!o) return;
  o.done_on = checked ? currentKey : null;
  if (o.subs && o.subs.length) {
    // ticking the task ticks all its steps; unticking clears them
    o.subs.forEach(s => { if (checked) { if (!stepDoneOn(s, currentKey)) s.done_on = currentKey; } else s.done_on = null; });
    li.querySelectorAll(".steps li.step").forEach(s => {
      s.classList.toggle("done", checked);
      const c = s.querySelector("input"); if (c) c.checked = checked;
    });
    refreshRow(li, oneoffStatus(o, currentKey));
  } else {
    li.classList.toggle("done", checked);
  }
  saveLocal();
  updateCount();
  scheduleSettle();
  sync(() => pushOneoffs([o]));
}

function toggleOneoffStep(id, j, checked, sli, li) {
  const o = oneoffs.find(x => x.id === id);
  if (!o || !o.subs[j]) return;
  o.subs[j].done_on = checked ? currentKey : null;
  const st = oneoffStatus(o, currentKey);
  // the task counts as done on the day its last step is ticked
  o.done_on = st.complete ? currentKey : null;
  saveLocal();
  sli.classList.toggle("done", checked);
  refreshRow(li, st);
  updateCount();
  scheduleSettle();
  sync(() => pushOneoffs([o]));
}

function addOneoffStep(id, text) {
  const o = oneoffs.find(x => x.id === id);
  if (!o) return;
  o.subs = o.subs || [];
  o.subs.push({ text, done_on: null });
  if (o.done_on) o.done_on = null;   // a new step means it isn't finished
  saveLocal();
  sync(() => pushOneoffs([o]));
}

function removeOneoffStep(id, j) {
  const o = oneoffs.find(x => x.id === id);
  if (!o) return;
  const step = { ...o.subs[j] };
  const wasDone = o.done_on;
  offerUndo(step.text, () => {
    const t = oneoffs.find(x => x.id === id);
    if (!t) return;
    t.subs.splice(Math.min(j, t.subs.length), 0, step);
    t.done_on = wasDone;
    saveLocal();
    sync(() => pushOneoffs([t]));
  });
  o.subs.splice(j, 1);
  const st = oneoffStatus(o, currentKey);
  if (o.subs.length) o.done_on = st.complete ? (o.done_on || currentKey) : null;
  saveLocal();
  renderToday();
  sync(() => pushOneoffs([o]));
}

function removeOneoff(id) {
  const pos = oneoffs.findIndex(o => o.id === id);
  if (pos < 0) return;
  const copy = JSON.parse(JSON.stringify(oneoffs[pos]));
  offerUndo(copy.text, () => {
    if (oneoffs.some(o => o.id === id)) return;
    oneoffs.splice(Math.min(pos, oneoffs.length), 0, copy);
    oneoffDeleted = oneoffDeleted.filter(x => x !== id);   // not deleted after all
    saveLocal();
    sync(() => pushOneoffs([copy]));
  });
  oneoffs = oneoffs.filter(o => o.id !== id);
  oneoffDeleted.push(id);
  saveLocal();
  renderToday();
  sync(() => pushOneoffDeletes());
}

// Reorder within the visible list, keeping everything else where it was
function moveOneoff(ids, from, to) {
  if (from === to) return;
  const newIds = ids.slice();
  const [m] = newIds.splice(from, 1);
  newIds.splice(to, 0, m);
  const slots = ids.map(id => oneoffs.findIndex(o => o.id === id)).sort((a, b) => a - b);
  const byId = Object.fromEntries(oneoffs.map(o => [o.id, o]));
  slots.forEach((slot, k) => { oneoffs[slot] = byId[newIds[k]]; });
  oneoffs.forEach((o, i) => { o.position = i; });
  saveLocal();
  sync(() => pushOneoffs(oneoffs));
}

$("oneoff-add").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("oneoff-input");
  const v = input.value.trim();
  if (!v) return;
  input.value = "";
  addOneoff(v);
  input.focus();
});

function setTab(t) {
  activeTab = t;
  lsSetRaw("checklist.tab", t);
  renderToday();
}
$("tab-weekly").addEventListener("click", () => setTab("weekly"));
$("tab-oneoff").addEventListener("click", () => setTab("oneoff"));

function applyOneoffSetting() {
  document.querySelectorAll("[data-oneoff-option]").forEach(b =>
    b.setAttribute("aria-pressed", String((b.dataset.oneoffOption === "on") === oneoffOn)));
}
document.querySelectorAll("[data-oneoff-option]").forEach(b => b.addEventListener("click", () => {
  oneoffOn = b.dataset.oneoffOption === "on";
  lsSetRaw("checklist.oneoffs.on", oneoffOn ? "on" : "off");
  applyOneoffSetting();
}));
applyOneoffSetting();

// ---------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------
function settingsList(d) {
  return $("settings-days").children[ORDER.indexOf(d)].querySelector("ul");
}

let settingsAdding = null;   // which Settings task has its "add a step" box open
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

    template[d].forEach((item, i) => {
      const text = item.t;
      const li = document.createElement("li");
      const stepsKey = "s" + d + ":" + i;
      const adding = settingsAdding === stepsKey;
      // steps show under a task only when it has some (or while you're adding one)
      li.className = "sortable" + (item.s.length ? " has-steps" : "") + (adding ? " adding" : "");

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

      // "+" beside the grip adds a step — the same as on the Today screen
      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "add-step-btn";
      plus.setAttribute("aria-label", "Add a step to " + text);
      plus.innerHTML = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M12 5v14M5 12h14"></path></svg>';
      plus.addEventListener("click", () => {
        settingsAdding = stepsKey;
        renderSettings();
        const inp = settingsList(d).children[i].querySelector(".step-edit-add input");
        if (inp) inp.focus();
      });

      li.append(grip, plus, span, del);

      // The step editor (shown when open)
      const steps = document.createElement("ul");
      steps.className = "step-editor";
      item.s.forEach((s, j) => {
        const sli = document.createElement("li");
        const sn = document.createElement("span");
        sn.className = "step-num";
        sn.textContent = String(i + 1).padStart(2, "0") + "." + (j + 1);
        const st = document.createElement("button");
        st.type = "button";
        st.className = "task-text step-edit-text";
        st.textContent = s;
        st.title = "Click to edit";
        st.setAttribute("aria-label", "Edit step " + s);
        st.addEventListener("click", () => inlineEdit(st, s, v => { editStep(d, i, j, v); }, () => renderSettings()));
        const x = document.createElement("button");
        x.type = "button";
        x.className = "step-remove";
        x.setAttribute("aria-label", "Remove step " + s);
        x.innerHTML = SMALL_X;
        x.addEventListener("click", () => { removeStep(d, i, j); renderSettings(); });
        sli.append(sn, st, x);
        steps.appendChild(sli);
      });
      const addStepLi = document.createElement("li");
      addStepLi.className = "step-edit-add";
      const asn = document.createElement("span");
      asn.className = "step-num";
      asn.textContent = "+";
      const ain = document.createElement("input");
      ain.type = "text";
      ain.placeholder = "Add a step…";
      ain.maxLength = 200;
      ain.setAttribute("aria-label", "New step for " + text);
      const abtn = document.createElement("button");
      abtn.type = "button";
      abtn.className = "small-btn add";
      abtn.textContent = "Add";
      const addIt = () => {
        const v = ain.value.trim();
        if (!v) return;
        settingsAdding = stepsKey;   // keep the box open for the next one
        addStep(d, i, v);
        renderSettings();
        const again = settingsList(d).children[i].querySelector(".step-edit-add input");
        if (again) again.focus();
      };
      abtn.addEventListener("click", addIt);
      ain.addEventListener("keydown", e => {
        if (e.key === "Enter") addIt();
        if (e.key === "Escape") { e.preventDefault(); settingsAdding = null; renderSettings(); }
      });
      // leaving the box empty closes it again
      ain.addEventListener("blur", () => setTimeout(() => {
        if (!ain.isConnected || ain.value.trim() || addStepLi.contains(document.activeElement)) return;
        if (settingsAdding === stepsKey) { settingsAdding = null; renderSettings(); }
      }, 150));
      addStepLi.append(asn, ain, abtn);
      steps.appendChild(addStepLi);
      li.appendChild(steps);

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
      const fresh = settingsList(d).querySelector(".add-row input");
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

// Turn a piece of text into a text box. Enter or clicking away saves, Esc cancels.
function inlineEdit(el, initial, onSave, after) {
  if (el.dataset.editing) return;
  el.dataset.editing = "1";
  const row = el.closest("li");
  if (row) row.classList.add("editing");
  const input = document.createElement("input");
  input.type = "text";
  input.value = initial;
  input.setAttribute("aria-label", "Edit");
  el.replaceWith(input);
  let finished = false;
  const finish = keep => {
    if (finished) return;
    finished = true;
    if (keep) onSave(input.value.trim());
    after();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function startEdit(li, d, i) {
  if (li.classList.contains("editing")) return;
  li.classList.add("editing");
  const span = li.querySelector(".task-text");
  const input = document.createElement("input");
  input.type = "text";
  input.value = template[d][i].t;
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
  // the side panel's heading for this screen (date / "Weekly tasks" / sign-in)
  document.querySelectorAll("#panel [data-view]").forEach(el => el.classList.toggle("hidden", el.dataset.view !== v));
  document.body.dataset.view = v;
  $("view-auth").classList.toggle("hidden", v !== "auth");
  $("view-today").classList.toggle("hidden", v !== "today");
  $("view-settings").classList.toggle("hidden", v !== "settings");
  $("view-week").classList.toggle("hidden", v !== "week");
  $("nav").classList.toggle("hidden", v === "auth");
  $("nav-today").classList.toggle("active", v === "today");
  $("nav-week").classList.toggle("active", v === "week");
  $("nav-settings").classList.toggle("active", v === "settings");
  $("count").classList.toggle("hidden", v !== "today");
  if (v === "today") { offset = 0; renderToday(); }
  if (v === "week") { weekOffset = 0; renderWeek(); }
  if (v === "settings") renderSettings();
}

// Redraw after new data arrives, without interrupting a drag or an edit
function redraw(listsChanged) {
  if (dragging) { pendingRedraw = true; return; }
  if (view === "today") { if (typingInLists()) scheduleSettle(); else renderTodayKeepFocus(); }
  if (view === "week") renderWeek();
  if (view === "settings" && listsChanged) {
    const typing = document.activeElement && $("view-settings").contains(document.activeElement)
      && document.activeElement.tagName === "INPUT";
    if (!typing) renderSettings();
  }
}

$("nav-today").addEventListener("click", () => show("today"));

// ---------------------------------------------------------------------
// Carry over: on a new day, offer last time's unfinished weekly tasks
// ---------------------------------------------------------------------
const CARRY_DONE = -1;          // stored as a tick on the earlier day = "already dealt with"
const CARRY_LOOKBACK = 7;       // look back this far for the last day that had tasks

// The last earlier day with weekly tasks, and what wasn't finished on it
function carrySource() {
  for (let n = 1; n <= CARRY_LOOKBACK; n++) {
    const key = daysAgoKey(n);
    const tasks = template[keyWeekday(key)] || [];
    if (!tasks.length) continue;              // a day with nothing set: keep looking back
    const ticked = done[key] || [];
    if (ticked.includes(CARRY_DONE)) return null;
    const left = [];
    tasks.forEach((it, i) => { if (!weeklyStatus(it, i, ticked).complete) left.push(i); });
    return left.length ? { key, left } : null;
  }
  return null;
}

let carryPick = {};             // which rows are ticked to move (by task number)
let carryFor = null;            // the day the card is about
function renderCarry() {
  const card = $("carry");
  const src = offset === 0 && oneoffOn ? carrySource() : null;
  card.classList.toggle("hidden", !src);
  if (!src) { carryFor = null; return; }
  if (carryFor !== src.key) { carryFor = src.key; carryPick = {}; }

  const tasks = template[keyWeekday(src.key)];
  const today = todayKey();
  const onToday = new Set((template[keyWeekday(today)] || []).map(t => t.t.trim().toLowerCase()));
  oneoffsFor(today).forEach(o => { if (!oneoffStatus(o, today).complete) onToday.add(o.text.trim().toLowerCase()); });

  const gap = Math.round((new Date(today + "T12:00") - new Date(src.key + "T12:00")) / 86400000);
  const dt = new Date(src.key + "T12:00");
  $("carry-title").textContent = gap === 1 ? "Not done yesterday" : "Not done on " + DAYS[dt.getDay()];
  $("carry-from").textContent = dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });

  const list = $("carry-list");
  list.innerHTML = "";
  let movable = 0;
  src.left.forEach(i => {
    const text = tasks[i].t;
    const already = onToday.has(text.trim().toLowerCase());
    const li = document.createElement("li");
    li.className = "carry-item" + (already ? " already" : "");
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.disabled = already;
    box.checked = !already && carryPick[i] !== false;
    box.addEventListener("change", () => { carryPick[i] = box.checked; updateCarryButton(); });
    const words = document.createElement("span");
    words.className = "carry-text";
    words.textContent = text;
    label.append(box, words);
    if (already) {
      const note = document.createElement("span");
      note.className = "carry-note";
      note.textContent = "Already on today's list";
      label.appendChild(note);
    } else movable++;
    li.appendChild(label);
    list.appendChild(li);
  });
  $("carry-move").classList.toggle("hidden", movable === 0);
  updateCarryButton();
}
function carryChosen() {
  return [...$("carry-list").querySelectorAll("input")].map((b, n) => ({ b, n })).filter(x => x.b.checked && !x.b.disabled);
}
function updateCarryButton() {
  const n = carryChosen().length;
  const btn = $("carry-move");
  btn.disabled = n === 0;
  btn.textContent = n ? "Move " + n + " to Just today" : "Move to Just today";
}

function finishCarry(move) {
  const src = carrySource();
  if (!src) { renderToday(); return; }
  const key = src.key;
  const tasks = template[keyWeekday(key)];
  const today = todayKey();
  const boxes = [...$("carry-list").querySelectorAll("input")];
  const picked = move ? src.left.filter((i, n) => boxes[n] && boxes[n].checked && !boxes[n].disabled) : [];

  const before = (done[key] || []).slice();
  const set = new Set(before);
  set.add(CARRY_DONE);
  const made = [];
  let position = oneoffs.reduce((m, o) => Math.max(m, o.position), -1) + 1;
  picked.forEach(i => {
    const it = tasks[i];
    // a moved task counts as done on the day it came from…
    if (it.s.length) it.s.forEach((_, j) => set.add(encStep(i, j))); else set.add(i);
    // …and carries on in Just today, with any steps that weren't finished
    const subs = it.s.filter((_, j) => !before.includes(encStep(i, j))).map(t => ({ text: t, done_on: null }));
    made.push({ id: newId(), text: it.t, day: today, done_on: null, position: position++, subs });
  });
  done[key] = [...set];
  oneoffs.push(...made);
  saveLocal();
  if (made.length) { activeTab = "oneoff"; lsSetRaw("checklist.tab", "oneoff"); }
  renderToday();
  sync(async () => { await pushTicks([key]); await pushOneoffs(made); });

  const ids = made.map(o => o.id);
  offerUndo("", () => {
    done[key] = before;
    oneoffs = oneoffs.filter(o => !ids.includes(o.id));
    oneoffDeleted.push(...ids);
    saveLocal();
    sync(async () => { await pushTicks([key]); await pushOneoffDeletes(); });
  }, made.length ? "Moved " + made.length + " to Just today" : "Dismissed");
}
$("carry-move").addEventListener("click", () => finishCarry(true));
$("carry-dismiss").addEventListener("click", () => finishCarry(false));
$("nav-settings").addEventListener("click", () => show("settings"));
$("nav-week").addEventListener("click", () => show("week"));

// ---------------------------------------------------------------------
// Week page: each day's progress, what was missed, the week's total
// ---------------------------------------------------------------------
let weekOffset = 0;                                   // 0 = this week, -1 = last week …
const MIN_WEEK = -Math.floor((KEEP_DAYS - 7) / 7);    // as far back as we keep ticks
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekDays(off) {
  const t = new Date(); t.setHours(12, 0, 0, 0);
  const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7) + off * 7);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
}
function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x - y0) / 86400000 + 1) / 7);
}

// Everything on a given date: weekly tasks for that weekday + "just today" tasks
function dayStats(key) {
  const tasks = template[keyWeekday(key)] || [];
  const ticked = done[key] || [];
  const items = tasks.map((it, i) => ({ text: it.t, done: weeklyStatus(it, i, ticked).complete }));
  if (oneoffOn) oneoffsFor(key).forEach(o => items.push({ text: o.text, done: oneoffStatus(o, key).complete, oneoff: true }));
  const n = items.filter(x => x.done).length;
  return { n, t: items.length, missed: items.filter(x => !x.done).map(x => x.text), weeklyMissed: items.filter(x => !x.done && !x.oneoff).map(x => x.text) };
}

function renderWeek() {
  const days = weekDays(weekOffset);
  const today = todayKey();
  const wk = isoWeek(days[0]);
  const first = days[0], last = days[6];
  const mon = d => d.toLocaleDateString("en-GB", { month: "short" });
  const range = first.getMonth() === last.getMonth()
    ? first.getDate() + "–" + last.getDate() + " " + mon(last)
    : first.getDate() + " " + mon(first) + " – " + last.getDate() + " " + mon(last);

  // header
  $("wk-num").textContent = String(wk).padStart(2, "0");
  $("wk-kicker").textContent = "Week " + wk;
  $("wk-range").textContent = range;
  $("wk-year").textContent = String(last.getFullYear());
  $("wk-tag").textContent = weekOffset === 0 ? "This week" : weekOffset === -1 ? "Last week" : -weekOffset + " weeks ago";
  $("week-header").classList.toggle("is-today", weekOffset === 0);
  $("wk-back").classList.toggle("hidden", weekOffset === 0);
  $("wk-prev").disabled = weekOffset <= MIN_WEEK;
  $("wk-next").disabled = weekOffset >= 0;

  // one row per day
  const list = $("week-list");
  list.innerHTML = "";
  let sumN = 0, sumT = 0;
  const skips = {};
  days.forEach(d => {
    const key = dateKey(d);
    const st = dayStats(key);
    const isToday = key === today, future = key > today, past = key < today;
    if (!future) { sumN += st.n; sumT += st.t; }
    if (past) st.weeklyMissed.forEach(t => { skips[t] = (skips[t] || 0) + 1; });

    const li = document.createElement("li");
    li.className = "wk-day" + (isToday ? " is-today" : "") + (future ? " future" : "") + (st.t && st.n === st.t ? " all-done" : "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wk-row";
    btn.setAttribute("aria-label", d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) +
      ": " + st.n + " of " + st.t + " done. Open this day");
    const num = document.createElement("span"); num.className = "wk-dnum"; num.textContent = d.getDate();
    const name = document.createElement("span"); name.className = "wk-dname"; name.textContent = DAY_SHORT[d.getDay()] + (isToday ? " · today" : "");
    const bar = document.createElement("span"); bar.className = "wk-bar";
    if (st.t) {
      const blocks = document.createElement("span"); blocks.className = "wk-blocks";
      for (let k = 0; k < st.t; k++) { const c = document.createElement("span"); if (k < st.n) c.className = "on"; blocks.appendChild(c); }
      const tally = document.createElement("span"); tally.className = "wk-tally"; tally.innerHTML = tallySVG(st.n, st.t);
      bar.append(blocks, tally);
    } else {
      const none = document.createElement("span"); none.className = "wk-none"; none.textContent = "Nothing set";
      bar.appendChild(none);
    }
    const count = document.createElement("span"); count.className = "wk-count"; count.textContent = st.t ? st.n + "/" + st.t : "";
    btn.append(num, name, bar, count);
    btn.addEventListener("click", () => openDay(key));
    li.appendChild(btn);
    if (past && st.missed.length) {
      const m = document.createElement("p"); m.className = "wk-missed";
      m.textContent = "Missed: " + st.missed.join(", ");
      li.appendChild(m);
    }
    list.appendChild(li);
  });

  // the week's total and the task skipped most
  $("wk-total-n").textContent = sumN;
  $("wk-total-of").textContent = "/" + sumT;
  $("wk-total-label").textContent = weekOffset === 0 ? "done so far this week" : "done that week";
  $("wk-summary").classList.toggle("hidden", sumT === 0);
  const top = Object.entries(skips).sort((a, b) => b[1] - a[1])[0];
  $("wk-skip").textContent = top && top[1] >= 2 ? "Most skipped: " + top[0] + " (" + top[1] + " days)" : "";
  $("wk-skip").classList.toggle("hidden", !(top && top[1] >= 2));
}

// Tap a day on the Week page → open it on Today
function openDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  const a = new Date(y, m - 1, d, 12), b = new Date(); b.setHours(12, 0, 0, 0);
  const diff = Math.round((a - b) / 86400000);
  show("today");
  if (diff !== 0) { offset = Math.max(MIN_OFFSET, diff); renderToday(); }
}

function goToWeek(n) {
  n = Math.min(0, Math.max(MIN_WEEK, n));
  if (n === weekOffset) return;
  const dir = n > weekOffset ? 1 : -1;
  weekOffset = n;
  renderWeek();
  [$("week-header").querySelector(".date-inner"), $("week-list")].forEach(el => {
    if (el && el.animate) el.animate([{ transform: "translateX(" + (dir * 40) + "px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 220, easing: "ease-out" });
  });
}
$("wk-prev").addEventListener("click", () => goToWeek(weekOffset - 1));
$("wk-next").addEventListener("click", () => goToWeek(weekOffset + 1));
$("wk-back").addEventListener("click", () => goToWeek(0));

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
  [$("date-inner"), $("task-list"), $("oneoff-panel")].forEach(el => {
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
  if ((view !== "today" && view !== "week") || dragging) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  e.preventDefault();
  if (view === "week") { goToWeek(weekOffset + (e.key === "ArrowRight" ? 1 : -1)); return; }
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
  if (view === "week") renderWeek();
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
  if (currentKey) updateCount();   // progress wording differs per look
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
// "Deleted … — Undo" bar
// ---------------------------------------------------------------------
let undoTimer = null;
let undoAction = null;
function offerUndo(what, restore, message) {
  const bar = $("toast");
  undoAction = restore;
  $("toast-text").textContent = message || "Deleted “" + what + "”";
  bar.classList.remove("hidden");
  (window.requestAnimationFrame || (f => setTimeout(f, 16)))(() => bar.classList.add("show"));
  startUndoTimer();
}
function startUndoTimer() { clearTimeout(undoTimer); undoTimer = setTimeout(hideUndo, 6000); }
function hideUndo() {
  clearTimeout(undoTimer);
  undoAction = null;
  const bar = $("toast");
  bar.classList.remove("show");
  setTimeout(() => { if (!bar.classList.contains("show")) bar.classList.add("hidden"); }, 250);
}
$("toast-undo").addEventListener("click", () => {
  const fn = undoAction;
  hideUndo();
  if (!fn) return;
  fn();
  if (view === "settings") renderSettings(); else renderToday();
});
$("toast-close").addEventListener("click", hideUndo);
// don't vanish while you're reaching for it
$("toast").addEventListener("pointerenter", () => clearTimeout(undoTimer));
$("toast").addEventListener("pointerleave", () => { if (undoAction) startUndoTimer(); });
$("toast").addEventListener("focusin", () => clearTimeout(undoTimer));
$("toast").addEventListener("focusout", () => { if (undoAction) startUndoTimer(); });

// ---------------------------------------------------------------------
// Install as an app + offline support
// ---------------------------------------------------------------------
const isInstalled = () =>
  (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let installPrompt = null;

function showInstall() {
  const block = $("install-block");
  if (isInstalled()) { block.classList.add("hidden"); return; }
  if (installPrompt) {
    $("install-note").textContent = "Opens in its own window with its own icon, and works offline.";
    $("install-btn").classList.remove("hidden");
    block.classList.remove("hidden");
  } else if (isIOS) {
    // iPhone/iPad don't offer an install button: explain the Share menu instead
    $("install-note").textContent = "In Safari, tap the Share button, then “Add to Home Screen”.";
    $("install-btn").classList.add("hidden");
    block.classList.remove("hidden");
  } else {
    block.classList.add("hidden");
  }
}

window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();          // we show our own Install button instead
  installPrompt = e;
  showInstall();
});
window.addEventListener("appinstalled", () => { installPrompt = null; showInstall(); });
$("install-btn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  try { await installPrompt.userChoice; } catch {}
  installPrompt = null;
  showInstall();
});
showInstall();

// Offline support (only works on the real https site, not when opening the file directly)
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

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
