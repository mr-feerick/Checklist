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
  supabaseUrl: "",   // e.g. "https://abcdefghijkl.supabase.co"
  supabaseKey: ""    // the publishable / anon public key
};
