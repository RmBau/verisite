/**
 * VeriSite × Procore — Dashboard Integration Layer
 * Add this script block to verisite-dashboard.html
 * Place it BEFORE the closing </body> tag
 *
 * What this does:
 *   1. Detects when the dashboard is running inside a Procore iFrame
 *   2. Handles OAuth token receipt from the Cloudflare Worker callback
 *   3. Stores tokens in sessionStorage (cleared when browser closes)
 *   4. Exposes procoreAPI helper for pushing photos and daily logs
 *   5. Adds a "Connected to Procore" status badge to the dashboard header
 */

const VeriSiteProcore = (() => {

  const WORKER_BASE = 'https://api.verisite.build';

  // ── Token Storage (sessionStorage — never localStorage) ──────────────────
  const Tokens = {
    set(access, refresh, expiresIn) {
      const expiresAt = Date.now() + (expiresIn * 1000);
      sessionStorage.setItem('pc_access',     access);
      sessionStorage.setItem('pc_refresh',    refresh);
      sessionStorage.setItem('pc_expires_at', expiresAt.toString());
    },
    get() {
      return {
        access:    sessionStorage.getItem('pc_access'),
        refresh:   sessionStorage.getItem('pc_refresh'),
        expiresAt: parseInt(sessionStorage.getItem('pc_expires_at') || '0'),
      };
    },
    isExpired() {
      const { expiresAt } = Tokens.get();
      return Date.now() >= (expiresAt - 60000); // refresh 60s early
    },
    clear() {
      ['pc_access', 'pc_refresh', 'pc_expires_at'].forEach(k =>
        sessionStorage.removeItem(k)
      );
    },
  };

  // ── Read tokens from URL fragment (set by callback redirect) ─────────────
  function readTokensFromFragment() {
    const hash = window.location.hash.slice(1);
    if (!hash.includes('procore_token=')) return false;

    const params = new URLSearchParams(hash);
    const access    = params.get('procore_token');
    const refresh   = params.get('procore_refresh');
    const expiresIn = parseInt(params.get('procore_expires_in') || '5400');

    if (access && refresh) {
      Tokens.set(access, refresh, expiresIn);
      // Clean the fragment from the URL without reloading
      history.replaceState(null, '', window.location.pathname + window.location.search);
      return true;
    }
    return false;
  }

  // ── Refresh access token via Worker ──────────────────────────────────────
  async function refreshToken() {
    const { refresh } = Tokens.get();
    if (!refresh) return null;

    const res = await fetch(`${WORKER_BASE}/procore/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refresh_token: refresh }),
    });

    if (!res.ok) {
      Tokens.clear();
      updateBadge('disconnected');
      return null;
    }

    const data = await res.json();
    Tokens.set(data.access_token, data.refresh_token, data.expires_in);
    return data.access_token;
  }

  // ── Get a valid access token (refresh if needed) ──────────────────────────
  async function getAccessToken() {
    if (Tokens.isExpired()) return await refreshToken();
    return Tokens.get().access;
  }

  // ── Push photo to Procore Photos ──────────────────────────────────────────
  // Call this after a successful NFC tap that includes a photo
  // imageBase64: base64 string of the compressed JPEG (no data:image/... prefix)
  async function pushPhoto({ projectId, companyId, imageBase64, filename, location, trade, timestamp }) {
    const token = await getAccessToken();
    if (!token) return { success: false, error: 'not_authenticated' };

    const res = await fetch(`${WORKER_BASE}/procore/push/photo`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        access_token:  token,
        project_id:    projectId,
        company_id:    companyId,
        image_base64:  imageBase64,
        filename,
        location,
        trade,
        timestamp,
      }),
    });

    const data = await res.json();
    if (data.success) {
      console.log(`[VeriSite→Procore] Photo pushed. Procore ID: ${data.procore_image_id}`);
    }
    return data;
  }

  // ── Push daily log entry to Procore ───────────────────────────────────────
  // Call this after every NFC tap regardless of whether it has a photo
  async function pushDailyLog({ projectId, companyId, location, trade, status, task, timestamp, verifiedBy }) {
    const token = await getAccessToken();
    if (!token) return { success: false, error: 'not_authenticated' };

    const res = await fetch(`${WORKER_BASE}/procore/push/dailylog`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        access_token: token,
        project_id:   projectId,
        company_id:   companyId,
        location,
        trade,
        status,
        task,
        timestamp,
        verified_by:  verifiedBy,
      }),
    });

    const data = await res.json();
    if (data.success) {
      console.log(`[VeriSite→Procore] Daily log pushed. Procore log ID: ${data.procore_log_id}`);
    }
    return data;
  }

  // ── Detect Procore iFrame context ─────────────────────────────────────────
  function isInsideProcore() {
    try {
      return window.self !== window.top;
    } catch {
      return true; // Cross-origin frame — assume Procore context
    }
  }

  // ── Connect Button ────────────────────────────────────────────────────────
  function renderConnectButton() {
    const btn = document.createElement('button');
    btn.id = 'procore-connect-btn';
    btn.innerHTML = '🔗 Connect to Procore';
    btn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #F0AE3C;
      color: #1A1B1E;
      border: none;
      border-radius: 8px;
      padding: 10px 18px;
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 1px;
      cursor: pointer;
      z-index: 9999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    btn.addEventListener('click', () => {
      window.location.href = `${WORKER_BASE}/procore/auth`;
    });
    document.body.appendChild(btn);
  }

  // ── Status Badge ──────────────────────────────────────────────────────────
  function updateBadge(state) {
    let badge = document.getElementById('procore-status-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'procore-status-badge';
      badge.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 12px;
        border-radius: 20px;
        font-family: 'Poppins', sans-serif;
        font-size: 11px;
        font-weight: 500;
        margin-left: 12px;
        vertical-align: middle;
      `;
      // Append near the VERISITE header wordmark if it exists
      const header = document.querySelector('header, .header, h1, .wordmark');
      if (header) header.appendChild(badge);
      else document.body.prepend(badge);
    }

    const states = {
      connected:    { bg: 'rgba(34,197,94,0.15)',  color: '#22C55E', dot: '#22C55E', text: 'Procore Connected' },
      disconnected: { bg: 'rgba(107,114,128,0.15)', color: '#6B7280', dot: '#6B7280', text: 'Procore Disconnected' },
      syncing:      { bg: 'rgba(240,174,60,0.15)',  color: '#F0AE3C', dot: '#F0AE3C', text: 'Syncing to Procore…' },
    };

    const s = states[state] || states.disconnected;
    badge.style.background = s.bg;
    badge.style.color = s.color;
    badge.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:${s.dot};display:inline-block;"></span>${s.text}`;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    // Check if we're returning from OAuth callback with tokens in fragment
    const gotTokens = readTokensFromFragment();

    if (gotTokens || Tokens.get().access) {
      // Already authenticated
      updateBadge('connected');
      console.log('[VeriSite→Procore] Authenticated. Token ready.');

      // Remove connect button if it exists
      const btn = document.getElementById('procore-connect-btn');
      if (btn) btn.remove();
    } else {
      // Not authenticated — show connect button
      updateBadge('disconnected');
      renderConnectButton();
    }
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    pushPhoto,
    pushDailyLog,
    getAccessToken,
    isInsideProcore,
    updateBadge,
    isConnected: () => !!Tokens.get().access && !Tokens.isExpired(),
  };

})();

// ── HOW TO CALL AFTER EACH NFC TAP ──────────────────────────────────────────
//
// After your existing Apps Script webhook fires, add these calls:
//
// if (VeriSiteProcore.isConnected()) {
//
//   VeriSiteProcore.updateBadge('syncing');
//
//   // Always push a daily log entry
//   await VeriSiteProcore.pushDailyLog({
//     projectId:  'YOUR_PROCORE_PROJECT_ID',   // e.g. 12345678
//     companyId:  'YOUR_PROCORE_COMPANY_ID',   // e.g. 87654321
//     location:   locationName,                // e.g. "Door 204 - Room 204"
//     trade:      selectedTrade,               // e.g. "Hollow Metal Frames"
//     status:     selectedStatus,              // e.g. "Inspection Ready"
//     task:       selectedTask || '',
//     timestamp:  new Date().toISOString(),
//     verifiedBy: superintendentName || 'Field Superintendent',
//   });
//
//   // If there's a photo, push it too
//   if (photoBase64) {
//     await VeriSiteProcore.pushPhoto({
//       projectId:   'YOUR_PROCORE_PROJECT_ID',
//       companyId:   'YOUR_PROCORE_COMPANY_ID',
//       imageBase64: photoBase64.replace(/^data:image\/jpeg;base64,/, ''),
//       filename:    `${locationName}_${Date.now()}.jpg`,
//       location:    locationName,
//       trade:       selectedTrade,
//       timestamp:   new Date().toISOString(),
//     });
//   }
//
//   VeriSiteProcore.updateBadge('connected');
// }
