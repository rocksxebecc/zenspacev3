/* =========================================================
   ZENSPACE — Shared JS Utilities (Fully Functional)
   ========================================================= */

// ── Toast ─────────────────────────────────────────────────
function showToast(msg, type = 'default', duration = 3000) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show' + (type !== 'default' ? ' toast-' + type : '');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), duration);
}

// ── Password toggle ───────────────────────────────────────
function initPasswordToggles() {
  document.querySelectorAll('.toggle-pw').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.closest('.input-wrap').querySelector('input');
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      btn.setAttribute('aria-pressed', String(!shown));
      btn.querySelector('svg').innerHTML = shown
        ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
        : '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
    });
  });
}

// ── Field validation ──────────────────────────────────────
function validateEmail(val) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim());
}
function validatePassword(val) {
  return val.length >= 8;
}
function setFieldError(inputEl, errorEl, show) {
  inputEl.classList.toggle('error', show);
  errorEl.classList.toggle('visible', show);
}
function clearFieldError(inputEl, errorEl) {
  setFieldError(inputEl, errorEl, false);
}

// ── Button loading state ──────────────────────────────────
function setBtnLoading(btn, loading) {
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
  btn.setAttribute('aria-busy', String(loading));
}

// ── SSO buttons ───────────────────────────────────────────
function initSSOButtons() {
  const g  = document.getElementById('googleBtn');
  const gh = document.getElementById('githubBtn');
  if (g) g.addEventListener('click', async e => {
    e.preventDefault();
    showToast('Redirecting to Google…');
    if (window.ZenAuth) {
      const { error } = await ZenAuth.signInWithGoogle();
      if (error) showToast(error.message, 'error');
    }
  });
  if (gh) gh.addEventListener('click', async e => {
    e.preventDefault();
    showToast('Redirecting to GitHub…');
    if (window.ZenAuth) {
      const { error } = await ZenAuth.signInWithGitHub();
      if (error) showToast(error.message, 'error');
    }
  });
}

// ── Dark Mode ─────────────────────────────────────────────
function initDarkMode() {
  const saved = localStorage.getItem('zs-dark');
  if (saved === 'true') document.documentElement.classList.add('dark');
}
function toggleDarkMode() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('zs-dark', isDark);
}

// ── Auth helpers (legacy stubs — real auth via ZenAuth in supabase.js) ───────
// These are kept so any remaining inline references don't throw ReferenceErrors.
// All new code should use window.ZenAuth.* directly.
function getUser() {
  // Synchronous fallback only — prefer await ZenAuth.getUserProfile()
  try { return JSON.parse(localStorage.getItem('zs-user')) || null; } catch { return null; }
}
function saveUser(u) { localStorage.setItem('zs-user', JSON.stringify(u)); }
function requireAuth() {
  // Async version: await ZenAuth.requireAuth()
  if (!getUser()) { window.location.href = 'login.html'; return false; }
  return true;
}
function signOut() {
  // Delegates to ZenAuth for full Supabase session teardown
  if (window.ZenAuth) { ZenAuth.signOutUser(); return; }
  localStorage.removeItem('zs-user');
  window.location.href = 'login.html';
}

// ── Modal helper ──────────────────────────────────────────
function openModal(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.add('open'); m.setAttribute('aria-hidden', 'false'); }
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); }
}

// ── Init shared behaviours ────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initDarkMode();
  initPasswordToggles();
  initSSOButtons();
});
