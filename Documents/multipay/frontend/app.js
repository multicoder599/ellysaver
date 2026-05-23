// MultiPay - Shared Frontend Utilities
const API_BASE = window.location.origin;

function getToken() { return localStorage.getItem('mp_token'); }
function getUser() { try { return JSON.parse(localStorage.getItem('mp_user')); } catch { return null; } }
function setAuth(token, user) { localStorage.setItem('mp_token', token); localStorage.setItem('mp_user', JSON.stringify(user)); }
function clearAuth() { localStorage.removeItem('mp_token'); localStorage.removeItem('mp_user'); }
function logout() { clearAuth(); window.location.href = '/login'; }

async function apiFetch(url, opts = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) { logout(); return null; }
  return res;
}

function showAlert(el, msg, type = 'error') {
  if (!el) return;
  el.textContent = msg;
  el.className = `alert alert-${type} show`;
  setTimeout(() => { el.className = `alert alert-${type}`; el.textContent = ''; }, 5000);
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => alert('Copied to clipboard!'));
}

function formatCurrency(num, currency = 'KES') {
  return `${currency} ${parseFloat(num || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusBadge(status) {
  const map = {
    pending: { cls: 'badge-pending', label: 'Pending' },
    success: { cls: 'badge-success', label: 'Success' },
    failed: { cls: 'badge-failed', label: 'Failed' },
    cancelled: { cls: 'badge-failed', label: 'Cancelled' }
  };
  const s = map[status] || { cls: 'badge-pending', label: status };
  return `<span class="badge ${s.cls}">${s.label}</span>`;
}

// Auth guard
(function authGuard() {
  const publicPages = ['/login', '/register', '/', '/docs'];
  const path = window.location.pathname;
  if (!publicPages.includes(path) && !getToken()) {
    window.location.href = '/login';
  }
})();
