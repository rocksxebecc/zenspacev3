/* =========================================================
   ZENSPACE — Supabase Client & Auth Helpers
   ---------------------------------------------------------
   Setup:
     1. Go to https://supabase.com and create a free project.
     2. In your project dashboard → Settings → API, copy:
          • Project URL  → paste as SUPABASE_URL below
          • anon/public key → paste as SUPABASE_ANON_KEY below
     3. Replace every `localStorage`-based auth call in your
        HTML files with the async helpers exported here.
   ========================================================= */

// ── 1. Configuration ──────────────────────────────────────
const SUPABASE_URL = 'https://bqtyvvzhnkesitodaqgu.supabase.co'; // base project URL only — no /rest/v1/
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxdHl2dnpobmtlc2l0b2RhcWd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0NjE4MDYsImV4cCI6MjA5NDAzNzgwNn0.lhIemhIriOqlqMDm1jJW-97pAlqhl0izkycK_gfBDUo';                 // ← replace

// ── 2. Load the Supabase JS SDK (CDN) ────────────────────
//  This file must be loaded AFTER the Supabase CDN script tag, OR you can
//  add the script tag here dynamically (shown below). Either approach works.
//  Recommended: add this once in your <head> before loading supabase.js:
//
//  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//  <script src="assets/supabase.js"></script>

(function ensureSupabaseSDK() {
  if (typeof window.supabase !== 'undefined') return; // already loaded
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  script.async = false; // block until loaded so client can be built synchronously
  document.head.appendChild(script);
})();

// ── 3. Create Supabase client ─────────────────────────────
//  We defer creation until the SDK is guaranteed to be ready.
let _client = null;

function getSupabaseClient() {
  if (_client) return _client;
  if (typeof window.supabase === 'undefined') {
    console.error('[Zenspace] Supabase SDK not loaded yet. Make sure the CDN script is included before supabase.js, or await initSupabase().');
    return null;
  }
  _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Persist the session in localStorage so the user stays logged in
      // across page reloads (mirrors the old zs-user behaviour).
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,   // required for OAuth & magic-link callbacks
    },
  });
  return _client;
}

/**
 * initSupabase()
 * Call this once at app boot (e.g. in DOMContentLoaded) to guarantee the
 * SDK has loaded and the client is ready before making any auth calls.
 * Returns the Supabase client instance.
 */
async function initSupabase() {
  return new Promise((resolve) => {
    if (typeof window.supabase !== 'undefined') {
      resolve(getSupabaseClient());
      return;
    }
    // Poll until the CDN script has executed
    const timer = setInterval(() => {
      if (typeof window.supabase !== 'undefined') {
        clearInterval(timer);
        resolve(getSupabaseClient());
      }
    }, 50);
  });
}

// ── 4. Auth helpers ───────────────────────────────────────

/**
 * signUpWithEmail(email, password, meta)
 * Creates a new user account.
 * @param {string} email
 * @param {string} password
 * @param {{ firstName?: string, lastName?: string }} [meta]
 * @returns {{ user, error }}
 *
 * Usage (replace the localStorage block in signup.html):
 *   const { user, error } = await signUpWithEmail(email, password, { firstName: fname, lastName: lname });
 *   if (error) { showToast(error.message, 'error'); return; }
 *   showToast('Check your email to confirm your account!', 'success');
 */
async function signUpWithEmail(email, password, meta = {}) {
  const client = getSupabaseClient();
  if (!client) return { user: null, error: new Error('Supabase not initialised') };

  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: {
      data: {
        first_name: meta.firstName || '',
        last_name: meta.lastName || '',
        full_name: [meta.firstName, meta.lastName].filter(Boolean).join(' ') || email.split('@')[0],
      },
      emailRedirectTo: 'https://rocksxebecc.github.io/zenspace/dashboard.html',
    },
  });

  return { user: data?.user ?? null, error };
}

/**
 * signInWithEmail(email, password)
 * Signs in an existing user.
 * @returns {{ user, session, error }}
 *
 * Usage (replace the localStorage block in login.html):
 *   const { user, error } = await signInWithEmail(email, password);
 *   if (error) { showToast(error.message, 'error'); return; }
 *   window.location.href = 'dashboard.html';
 */
async function signInWithEmail(email, password) {
  const client = getSupabaseClient();
  if (!client) return { user: null, session: null, error: new Error('Supabase not initialised') };

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  return { user: data?.user ?? null, session: data?.session ?? null, error };
}

/**
 * signInWithGoogle()
 * Redirects the user to Google OAuth.
 * After the redirect, Supabase calls back to your site and
 * detectSessionInUrl picks up the token automatically.
 *
 * Usage (replace the SSO button handler in zenspace.js):
 *   await signInWithGoogle();
 */
async function signInWithGoogle() {
  const client = getSupabaseClient();
  if (!client) return { error: new Error('Supabase not initialised') };

  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + '/dashboard.html',
    },
  });
  return { error };
}

/**
 * signInWithGitHub()
 * Redirects the user to GitHub OAuth.
 */
async function signInWithGitHub() {
  const client = getSupabaseClient();
  if (!client) return { error: new Error('Supabase not initialised') };

  const { error } = await client.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: window.location.origin + '/dashboard.html',
    },
  });
  return { error };
}

/**
 * sendPasswordReset(email)
 * Sends a password-reset email (used in forgot.html).
 * @returns {{ error }}
 *
 * Usage:
 *   const { error } = await sendPasswordReset(email);
 *   if (!error) showToast('Reset link sent — check your inbox!', 'success');
 */
async function sendPasswordReset(email) {
  const client = getSupabaseClient();
  if (!client) return { error: new Error('Supabase not initialised') };

  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/reset-password.html',
  });
  return { error };
}

/**
 * updatePassword(newPassword)
 * Updates the current user's password (used on the reset-password page).
 * @returns {{ error }}
 */
async function updatePassword(newPassword) {
  const client = getSupabaseClient();
  if (!client) return { error: new Error('Supabase not initialised') };

  const { error } = await client.auth.updateUser({ password: newPassword });
  return { error };
}

/**
 * getUser()
 * Drop-in async replacement for the synchronous localStorage getUser().
 * Returns the currently authenticated Supabase user, or null.
 *
 * NOTE: Because this is now async, call it with await:
 *   const user = await getUser();
 *   if (!user) window.location.href = 'login.html';
 */
async function getUserAsync() {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data } = await client.auth.getUser();
  return data?.user ?? null;
}

/**
 * getSession()
 * Returns the current Supabase session (includes access_token, refresh_token, etc.).
 */
async function getSession() {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data?.session ?? null;
}

/**
 * signOut()
 * Drop-in replacement for the localStorage signOut().
 * Clears the Supabase session and redirects to login.
 */
async function signOutUser() {
  const client = getSupabaseClient();
  if (client) await client.auth.signOut();
  // Clean up any legacy localStorage keys just in case
  localStorage.removeItem('zs-user');
  localStorage.removeItem('zs-accounts');
  window.location.href = 'login.html';
}

/**
 * requireAuth()
 * Drop-in async replacement for the synchronous requireAuth().
 * Redirects to login if no valid session exists.
 * Returns true if authenticated, false otherwise.
 *
 * Usage at the top of dashboard.html script:
 *   if (!await requireAuth()) return;
 */
async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = 'login.html';
    return false;
  }
  return true;
}

/**
 * onAuthStateChange(callback)
 * Subscribe to auth state changes (SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, etc.)
 * @param {(event: string, session: object|null) => void} callback
 * @returns unsubscribe function
 *
 * Usage:
 *   const { data: { subscription } } = onAuthStateChange((event, session) => {
 *     if (event === 'SIGNED_OUT') window.location.href = 'login.html';
 *   });
 *   // Later: subscription.unsubscribe();
 */
function onAuthStateChange(callback) {
  const client = getSupabaseClient();
  if (!client) return { data: { subscription: { unsubscribe: () => { } } } };
  return client.auth.onAuthStateChange(callback);
}

// ── 5. Notes — Supabase DB helpers ──────────────────────────────────────────

/**
 * fetchNotes()
 * Returns all notes for the current user, newest first.
 * @returns {Array} array of note objects
 */
async function fetchNotes() {
  const client = getSupabaseClient();
  if (!client) return [];
  const { data, error } = await client
    .from('notes')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) { console.error('[Zenspace] fetchNotes error:', error.message); return []; }
  // Normalise to the shape the dashboard expects
  return (data || []).map(r => ({
    id: r.id,
    title: r.title || '',
    body: r.body || '',
    updated: new Date(r.updated_at).getTime(),
  }));
}

/**
 * upsertNote(note)
 * Inserts a new note or updates an existing one (matched by id).
 * @param {{ id: string, title: string, body: string }} note
 * @returns {{ error }}
 */
async function upsertNote(note) {
  const client = getSupabaseClient();
  if (!client) return { error: new Error('Supabase not initialised') };
  const user = await getUserAsync();
  if (!user) return { error: new Error('Not authenticated') };
  const { error } = await client.from('notes').upsert({
    id: note.id,
    user_id: user.id,
    title: note.title || '',
    body: note.body || '',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) console.error('[Zenspace] upsertNote error:', error.message);
  return { error };
}

/**
 * deleteNoteById(id)
 * Deletes a note by its UUID.
 * @param {string} id
 * @returns {{ error }}
 */
async function deleteNoteById(id) {
  const client = getSupabaseClient();
  if (!client) return { error: new Error('Supabase not initialised') };
  const { error } = await client.from('notes').delete().eq('id', id);
  if (error) console.error('[Zenspace] deleteNoteById error:', error.message);
  return { error };
}

// ── 6. Convenience: build a profile object matching the old zs-user shape ──
/**
 * getUserProfile()
 * Returns a plain object { email, name, loginTime } matching the old
 * localStorage format so dashboard.html can read it with minimal changes.
 */
async function getUserProfile() {
  const user = await getUserAsync();
  if (!user) return null;
  const meta = user.user_metadata || {};
  return {
    email: user.email,
    name: meta.full_name || meta.name || user.email.split('@')[0],
    loginTime: new Date(user.last_sign_in_at).getTime(),
    id: user.id,
  };
}

// ── 7. Expose on window for use in inline <script> tags ──────────────────
window.ZenAuth = {
  initSupabase,
  getSupabaseClient,
  signUpWithEmail,
  signInWithEmail,
  signInWithGoogle,
  signInWithGitHub,
  sendPasswordReset,
  updatePassword,
  getUserAsync,
  getSession,
  signOutUser,
  requireAuth,
  onAuthStateChange,
  getUserProfile,
  // Notes DB
  fetchNotes,
  upsertNote,
  deleteNoteById,
};
