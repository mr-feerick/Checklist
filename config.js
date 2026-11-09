// ------------------------------------------------------------------
// Online saving settings
//
// Leave both blank and the checklist saves in this browser only.
// Fill them in (Supabase → Project Settings → API) and it saves online,
// so your phone and computer show the same tasks.
//
// The "publishable" / "anon" key is designed to be public — it's fine
// in a public GitHub repo. Your data is protected by your login and the
// security rules in supabase-setup.sql. NEVER put the "secret" or
// "service_role" key here.
// ------------------------------------------------------------------
window.CHECKLIST_CONFIG = {
  supabaseUrl: "https://amxeywjqrmhakkindwuv.supabase.co",   // e.g. "https://abcdefghijkl.supabase.co"
  supabaseKey: "sb_publishable_TossDdLk8jy9SSOA9kSNzw_1c-eROhp"    // the publishable / anon public key
};
