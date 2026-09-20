// ==========================================
// CALL BUDGET TRACKER
// ==========================================

function getTodayKey() {
  const d = new Date();
  return `awais_codex_calls_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getCallCount() {
  const key = getTodayKey();
  return parseInt(localStorage.getItem(key) || '0', 10);
}

export function recordApiCall() {
  const key = getTodayKey();
  const count = getCallCount() + 1;
  localStorage.setItem(key, String(count));
  updateCallBudgetUI();
}

export const incrementCallCount = recordApiCall;

export async function updateCallBudgetUI() {
  const localCount = getCallCount();
  const elBudget = document.getElementById('call-budget-indicator');
  
  let serverCount = 0;
  try {
    const secret = localStorage.getItem('awais_whatsapp_admin_secret') || 'wa_admin_secret_change_me_in_prod';
    const res = await fetch('/api/call-budget', {
      headers: {
        'Authorization': `Bearer ${secret}`,
        'x-whatsapp-admin-secret': secret
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.totalCount === 'number') {
        serverCount = data.totalCount;
      }
    }
  } catch (_) {}

  const displayCount = Math.max(localCount, serverCount);

  if (elBudget) {
    elBudget.textContent = `${displayCount}/100 today`;
    if (displayCount >= 90) {
      elBudget.style.color = '#ef4444';
      elBudget.style.fontWeight = '600';
    } else {
      elBudget.style.color = 'var(--text-subtle)';
      elBudget.style.fontWeight = 'normal';
    }
  }
}
