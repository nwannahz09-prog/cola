// -----------------------------------------------------------------------
// Point this at wherever the backend from /backend/server.js is running.
// -----------------------------------------------------------------------
const API_BASE = 'http://localhost:4000';

const TIERS = {
  'First Sip':            { price: 5000,   shares: 50 },
  'Bottle Backer':        { price: 20000,  shares: 250 },
  'Crate Founder':        { price: 50000,  shares: 700 },
  "Distributor's Circle": { price: 150000, shares: 2500 }
};

const PERKS = {
  'First Sip': ['Name on the backer wall', 'Backer dashboard access'],
  'Bottle Backer': [
    'Everything in First Sip',
    'Chance to receive free bottles per run',
    'Early look at new flavours'
  ],
  'Crate Founder': [
    'Everything in Bottle Backer',
    'Founder badge on dashboard',
    'Opportunity to join select bottling events'
  ],
  "Distributor's Circle": [
    'Everything in Crate Founder',
    'First look at future revenue-share terms, if offered',
    'Chance at a quarterly 1:1 with the founder'
  ]
};

let authToken = localStorage.getItem('keloToken');
let currentUser = null;      // last user object we got back from the API
let pendingAction = null;    // 'dash' or 'back'
let pendingTier = null;      // tier name, only set when pendingAction === 'back'

/* ------------------------- generic small helpers ------------------------- */

function money(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setLoading(button, loading, loadingText) {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText || 'Please wait…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function showError(el, message) {
  el.textContent = message;
  el.classList.add('show');
}
function hideError(el) {
  el.textContent = '';
  el.classList.remove('show');
}

async function apiRequest(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && authToken) headers.Authorization = `Bearer ${authToken}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (networkErr) {
    // Backend unreachable, CORS blocked, offline, etc.
    return { ok: false, status: 0, data: { success: false, message: "Couldn't reach the server. Check your connection and try again." } };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    data = { success: false, message: 'Unexpected response from the server.' };
  }

  return { ok: response.ok, status: response.status, data };
}

/* ------------------------------ modal control ------------------------------ */

function openAuth(action, tierName) {
  pendingAction = action;
  pendingTier = tierName || null;

  if (authToken) {
    proceedAfterAuth();
    return;
  }
  openSignup();
}

function openSignup() {
  closeLogin();
  closePayment();
  document.getElementById('signupOverlay').classList.add('open');
}
function closeSignup() {
  document.getElementById('signupOverlay').classList.remove('open');
  hideError(document.getElementById('signupError'));
}
function openLogin() {
  closeSignup();
  closePayment();
  document.getElementById('loginOverlay').classList.add('open');
}
function closeLogin() {
  document.getElementById('loginOverlay').classList.remove('open');
  hideError(document.getElementById('loginError'));
}
function switchToLogin() { openLogin(); }
function switchToSignup() { openSignup(); }

/* --------------------------------- sign up --------------------------------- */

async function submitSignup(e) {
  e.preventDefault();
  const errorEl = document.getElementById('signupError');
  hideError(errorEl);

  const payload = {
    name: document.getElementById('signupName').value.trim(),
    email: document.getElementById('signupEmail').value.trim(),
    phone: document.getElementById('signupPhone').value.trim(),
    password: document.getElementById('signupPassword').value
  };

  const btn = document.getElementById('signupSubmitBtn');
  setLoading(btn, true, 'Creating account…');
  const { ok, data } = await apiRequest('/api/signup', { method: 'POST', body: payload });
  setLoading(btn, false);

  if (!ok || !data.success) {
    showError(errorEl, data.message || 'Something went wrong creating your account.');
    return;
  }

  authToken = data.token;
  localStorage.setItem('keloToken', authToken);
  currentUser = data.user;
  document.getElementById('signupForm').reset();
  closeSignup();
  await proceedAfterAuth();
}

/* --------------------------------- log in --------------------------------- */

async function submitLogin(e) {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  hideError(errorEl);

  const payload = {
    email: document.getElementById('loginEmail').value.trim(),
    password: document.getElementById('loginPassword').value
  };

  const btn = document.getElementById('loginSubmitBtn');
  setLoading(btn, true, 'Logging in…');
  const { ok, data } = await apiRequest('/api/login', { method: 'POST', body: payload });
  setLoading(btn, false);

  if (!ok || !data.success) {
    showError(errorEl, data.message || 'Could not log you in.');
    return;
  }

  authToken = data.token;
  localStorage.setItem('keloToken', authToken);
  currentUser = data.user;
  document.getElementById('loginForm').reset();
  closeLogin();
  await proceedAfterAuth();
}

function logout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('keloToken');
  showSite();
}

/* --------------------- what to do once we have a logged-in user --------------------- */

async function proceedAfterAuth() {
  // Backing a tier needs a (simulated) payment first — the dashboard only
  // shows the new backing once that "payment" has succeeded.
  if (pendingAction === 'back' && pendingTier) {
    openPayment(pendingTier);
    return;
  }

  // Otherwise (e.g. "Backer dashboard" link): just load whatever they already have.
  const { ok, data } = await apiRequest('/api/dashboard', { auth: true });
  if (!ok || !data.success) {
    // token probably expired/invalid — send them back to log in
    logout();
    openLogin();
    return;
  }
  currentUser = data.user;
  renderDashboard(currentUser);
  showDash();
}

/* ------------------------------------------------------------------------- */
/* PAYMENT MODAL — simulated Stripe-style checkout. DEMO ONLY.               */
/* No card network, gateway, or Stripe API is ever contacted. The "payment"  */
/* is a client-side delay + success animation; only after it "succeeds" do   */
/* we call /api/back, which is what actually adds the backing.               */
/* ------------------------------------------------------------------------- */

function openPayment(tierName) {
  const tier = TIERS[tierName];
  if (!tier) return;

  closeSignup();
  closeLogin();

  document.getElementById('paySummaryTier').textContent = `Back ${tierName}`;
  document.getElementById('paySummarySub').textContent = 'Simulated checkout — enter your card details to continue.';
  document.getElementById('paySummaryBox').innerHTML = `
    <div>
      <div class="ps-tier">${tierName}</div>
      <div class="ps-shares">${tier.shares.toLocaleString('en-NG')} backer shares</div>
    </div>
    <div class="ps-price">${money(tier.price)}</div>
  `;

  resetPaymentModal();
  document.getElementById('paymentOverlay').classList.add('open');
}

function closePayment() {
  document.getElementById('paymentOverlay').classList.remove('open');
  resetPaymentModal();
}

function resetPaymentModal() {
  document.getElementById('paymentForm').reset();
  hideError(document.getElementById('payError'));
  document.getElementById('payFormStage').style.display = 'block';
  document.getElementById('payProcessingStage').style.display = 'none';
  document.getElementById('paySuccessStage').style.display = 'none';
  const btn = document.getElementById('paySubmitBtn');
  setLoading(btn, false, 'Pay now (simulated)');
}

// real card, just spacing/shape as the user types.
document.addEventListener('DOMContentLoaded', () => {
  const cardInput = document.getElementById('payCardNumber');
  if (cardInput) {
    cardInput.addEventListener('input', () => {
      const digits = cardInput.value.replace(/\D/g, '').slice(0, 19);
      cardInput.value = digits.replace(/(.{4})/g, '$1 ').trim();
    });
  }
  const expiryInput = document.getElementById('payExpiry');
  if (expiryInput) {
    expiryInput.addEventListener('input', () => {
      let digits = expiryInput.value.replace(/\D/g, '').slice(0, 4);
      if (digits.length > 2) digits = digits.slice(0, 2) + '/' + digits.slice(2);
      expiryInput.value = digits;
    });
  }
  const cvcInput = document.getElementById('payCvc');
  if (cvcInput) {
    cvcInput.addEventListener('input', () => {
      cvcInput.value = cvcInput.value.replace(/\D/g, '').slice(0, 4);
    });
  }
});

function validatePaymentForm() {

const payName = document.getElementById('payName').value.trim();
let cardDigits = document.getElementById('payCardNumber').value.replace(/\D/g, '');
let expiry = document.getElementById('payExpiry').value.trim();
let cvc = document.getElementById('payCvc').value.trim();


  if (!payName) return 'Enter the name on the card.';
  if (cardDigits.length < 13 || cardDigits.length > 19) return 'Enter a valid card number.';

  const expiryMatch = /^(\d{2})\/(\d{2})$/.exec(expiry);
  if (!expiryMatch) return 'Enter the expiry as MM/YY.';
  const month = Number(expiryMatch[1]);
  if (month < 1 || month > 12) return 'Enter a valid expiry month.';

  if (cvc.length < 3 || cvc.length > 4) return {error: 'Enter a valid CVC.',payName,cardDigits,expiry,cvc};

  return {error:null ,payName,cardDigits,expiry,cvc};
}

async function submitPayment(e) {
  e.preventDefault();
  const errorEl = document.getElementById('payError');
  hideError(errorEl);

  const {error: validationError,payName,cardDigits,expiry,cvc} = validatePaymentForm()
  if (validationError) {
    showError(errorEl, validationError);
    return;
  }

  // --- Stage 1: "processing" (simulated — no gateway is ever contacted) ---
  document.getElementById('payFormStage').style.display = 'none';
  document.getElementById('payProcessingStage').style.display = 'flex';
  await sleep(1400);

  // --- Stage 2: "confirmed" ---
  document.getElementById('payProcessingStage').style.display = 'none';
  document.getElementById('paySuccessStage').style.display = 'flex';
  document.getElementById('paySuccessSub').textContent = 'Adding your shares to your dashboard…';

  const simulatedPaymentRef = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const { ok, data } = await apiRequest('/api/back', {
    method: 'POST',
    auth: true,
    body: { tierName: pendingTier, simulatedPaymentRef, payName,cardDigits,expiry,cvc}
  });

  if (!ok || !data.success) {
    // Roll back to the form so they can try again.
    document.getElementById('paySuccessStage').style.display = 'none';
    document.getElementById('payFormStage').style.display = 'block';
    showError(errorEl, data.message || 'Could not record your backing right now. Please try again.');
    return;
  }

  currentUser = data.user;
  await sleep(600); // let the success state register before we jump away
  pendingAction = null;
  pendingTier = null;
  closePayment();
  renderDashboard(currentUser);
  showDash();
  refreshStats();
}

/* ------------------------------ dashboard render ------------------------------ */

function renderDashboard(user) {
  document.getElementById('dashName').textContent = user.name ? `Welcome back, ${user.name.split(' ')[0]}` : 'Welcome back';

  const backings = user.backings || [];
  const hasTier = backings.length > 0;
  document.getElementById('dashNoTier').style.display = hasTier ? 'none' : 'block';
  document.getElementById('dashHasTier').style.display = hasTier ? 'contents' : 'none';

  if (!hasTier) {
    document.getElementById('dashSub').textContent = `BACKER #${user.backerNumber ?? '—'} · NOT YET BACKING A TIER`;
    return;
  }

  document.getElementById('dashSub').textContent =
    `BACKER #${user.backerNumber} · ${backings.length} BACKING${backings.length > 1 ? 'S' : ''}`;

  const totals = user.totals || { shares: 0, amountBacked: 0, projected7: 0, projected30: 0 };
  document.getElementById('totShares').textContent = totals.shares.toLocaleString('en-NG');
  document.getElementById('totAmount').textContent = money(totals.amountBacked);
  document.getElementById('totProjected7').textContent = money(totals.projected7);
  document.getElementById('totProjected30').textContent = money(totals.projected30);

  const grid = document.getElementById('backingGrid');
  grid.innerHTML = '';
  backings.forEach(b => {
    const date = new Date(b.createdAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
    const tile = document.createElement('div');
    tile.className = 'backing-tile';
    tile.innerHTML = `
      <div class="bt-head">
        <div class="bt-tier">${b.tier}</div>
        <div class="bt-date">${date}</div>
      </div>
      <div class="bt-shares">${b.shares.toLocaleString('en-NG')}</div>
      <div class="bt-shares-label">Backer shares</div>
      <div class="bt-row">
        <div><b>${money(b.amount)}</b><span>Backed</span></div>
        <div><b>${money(b.projected7)}</b><span>7-day proj.</span></div>
        <div><b>${money(b.projected30)}</b><span>30-day proj.</span></div>
      </div>
    `;
    grid.appendChild(tile);
  });
}

/* ------------------------------ site/dash switching ------------------------------ */

function showDash() {
  document.getElementById('site').style.display = 'none';
  document.getElementById('dash').style.display = 'block';
  window.scrollTo(0, 0);
}
function showSite() {
  document.getElementById('dash').style.display = 'none';
  document.getElementById('site').style.display = 'block';
  window.scrollTo(0, 0);
}

/* ------------------------------ live, real stats ------------------------------ */

async function refreshStats() {
  const { ok, data } = await apiRequest('/api/stats');
  if (!ok || !data.success) return;

  document.getElementById('statTotalBackers').textContent = data.totalBackers.toLocaleString('en-NG');
  document.getElementById('catTotal').textContent = data.totalBackers.toLocaleString('en-NG');
  document.getElementById('bottleCaption').textContent = `${data.totalBackers.toLocaleString('en-NG')} BACKERS AND COUNTING`;

  document.getElementById('catFirstSip').textContent = data.categories['First Sip'] ?? 0;
  document.getElementById('catBottleBacker').textContent = data.categories['Bottle Backer'] ?? 0;
  document.getElementById('catCrateFounder').textContent = data.categories['Crate Founder'] ?? 0;
  document.getElementById('catDistributorsCircle').textContent = data.categories["Distributor's Circle"] ?? 0;
}

/* ------------------------------ boot ------------------------------ */

window.addEventListener('load', () => {
  requestAnimationFrame(() => {
    document.querySelector('.fill-rect').style.transform = 'translateY(60px)';
  });
  refreshStats();
});


let withdrawalTimer = null;
let withdrawalData = null;


/* =========================================
   OPEN WITHDRAWAL MODAL
========================================= */

async function openWithdrawalModal() {

  const overlay =
    document.getElementById(
      'withdrawalOverlay'
    );

  overlay.classList.add('open');

  const message =
    document.getElementById(
      'withdrawModalMessage'
    );

  message.textContent =
    'Loading your withdrawal information…';

  await loadWithdrawalStatus();

}


/* =========================================
   CLOSE WITHDRAWAL MODAL
========================================= */

function closeWithdrawalModal() {

  const overlay =
    document.getElementById(
      'withdrawalOverlay'
    );

  overlay.classList.remove('open');

  if (withdrawalTimer) {

    clearInterval(
      withdrawalTimer
    );

    withdrawalTimer = null;

  }

}


/* =========================================
   LOAD WITHDRAWAL STATUS
========================================= */

async function loadWithdrawalStatus() {

  const {
    ok,
    data
  } = await apiRequest(
    '/api/withdrawal-status',
    {
      auth: true
    }
  );

  if (!ok || !data.success) {

    document.getElementById(
      'withdrawModalMessage'
    ).textContent =
      data.message ||
      'Could not load withdrawal information.';

    return;

  }

  withdrawalData = data;

  renderWithdrawalModal(data);

}


/* =========================================
   RENDER WITHDRAWAL MODAL
========================================= */

function renderWithdrawalModal(data) {

  const currentBalance =
    document.getElementById(
      'withdrawCurrentBalance'
    );

  const originalAmount =
    document.getElementById(
      'withdrawOriginalAmount'
    );

  const growthAmount =
    document.getElementById(
      'withdrawGrowthAmount'
    );

  const button =
    document.getElementById(
      'withdrawConfirmButton'
    );

  const countdownBox =
    document.getElementById(
      'withdrawCountdownBox'
    );

  const availableBox =
    document.getElementById(
      'withdrawAvailableBox'
    );

  const message =
    document.getElementById(
      'withdrawModalMessage'
    );


  /*
    Update balance
  */

  currentBalance.textContent =
    money(data.currentBalance);

  originalAmount.textContent =
    money(data.originalAmount);

  growthAmount.textContent =
    money(data.growthAmount);


  /*
    Clear previous timer
  */

  if (withdrawalTimer) {

    clearInterval(
      withdrawalTimer
    );

    withdrawalTimer = null;

  }


  /*
    Withdrawal available
  */

  if (data.eligible) {

    countdownBox.style.display =
      'none';

    availableBox.style.display =
      'flex';

    button.disabled = false;

    button.textContent =
      'Request Withdrawal';

    message.textContent =
      'Your eligible funds are ready to be withdrawn.';

    renderWithdrawalBackings(
      data.availableBackings
    );

    return;

  }


  /*
    Withdrawal not available
  */

  countdownBox.style.display =
    'block';

  availableBox.style.display =
    'none';

  button.disabled = true;

  button.textContent =
    'Withdrawal Locked';


  renderWithdrawalBackings(
    data.backings
  );


  if (data.remainingMs > 0) {

    startWithdrawalCountdown(
      data.remainingMs
    );

  } else {

    document.getElementById(
      'withdrawCountdown'
    ).textContent =
      'Not available';

  }

}


/* =========================================
   RENDER BACKING LIST
========================================= */

function renderWithdrawalBackings(
  backings
) {

  const container =
    document.getElementById(
      'withdrawBackingList'
    );

  container.innerHTML = '';

  if (!backings || backings.length === 0) {

    container.innerHTML =
      '<p>No active backings found.</p>';

    return;

  }


  backings.forEach(backing => {

    const date =
      new Date(
        backing.createdAt
      ).toLocaleDateString(
        'en-NG',
        {
          day: 'numeric',
          month: 'short',
          year: 'numeric'
        }
      );


    const card =
      document.createElement(
        'div'
      );

    card.className =
      'withdraw-backing-card';


    card.innerHTML = `

      <div>

        <div class="withdraw-backing-tier">
          ${backing.tier}
        </div>

        <div class="withdraw-backing-date">
          Backed ${date}
        </div>

      </div>


      <div class="withdraw-backing-value">

        <strong>
          ${money(backing.currentValue)}
        </strong>

        <span>
          ${
            backing.eligible
              ? 'Available'
              : 'Locked'
          }
        </span>

      </div>

    `;


    container.appendChild(
      card
    );

  });

}


/* =========================================
   COUNTDOWN
========================================= */

function startWithdrawalCountdown(
  initialMs
) {

  let remaining =
    Math.max(
      0,
      initialMs
    );


  const timer =
    document.getElementById(
      'withdrawCountdown'
    );


  function update() {

    if (remaining <= 0) {

      timer.textContent =
        'Withdrawal available';

      clearInterval(
        withdrawalTimer
      );

      withdrawalTimer =
        null;

      /*
        Refresh data from backend
      */

      loadWithdrawalStatus();

      return;

    }


    const totalSeconds =
      Math.floor(
        remaining / 1000
      );


    const days =
      Math.floor(
        totalSeconds / 86400
      );


    const hours =
      Math.floor(
        (totalSeconds % 86400) /
        3600
      );


    const minutes =
      Math.floor(
        (totalSeconds % 3600) /
        60
      );


    const seconds =
      totalSeconds % 60;


    timer.textContent =
      `${days}d ` +
      `${String(hours).padStart(2, '0')}h ` +
      `${String(minutes).padStart(2, '0')}m ` +
      `${String(seconds).padStart(2, '0')}s`;


    remaining -= 1000;

  }


  update();


  withdrawalTimer =
    setInterval(
      update,
      1000
    );

}


/* =========================================
   WITHDRAW FUNDS
========================================= */

async function withdrawFunds() {

  const button =
    document.getElementById(
      'withdrawConfirmButton'
    );

  const message =
    document.getElementById(
      'withdrawModalMessage'
    );


  button.disabled = true;

  button.textContent =
    'Processing…';


  message.textContent =
    'Submitting your withdrawal request…';


  const {
    ok,
    data
  } = await apiRequest(
    '/api/withdraw',
    {
      method: 'POST',

      auth: true
    }
  );


  if (!ok || !data.success) {

    button.disabled =
      false;

    button.textContent =
      'Request Withdrawal';

    message.textContent =
      data.message ||
      'Your withdrawal could not be processed.';

    return;

  }


  /*
    SUCCESS
  */

  button.textContent =
    'Withdrawal Requested';

  message.textContent =
    `Withdrawal request submitted successfully. ` +
    `Amount: ${money(data.amount)}`;


  /*
    Reload dashboard data
  */

  const dashboard =
    await apiRequest(
      '/api/dashboard',
      {
        auth: true
      }
    );


  if (
    dashboard.ok &&
    dashboard.data.success
  ) {

    currentUser =
      dashboard.data.user;

    renderDashboard(
      currentUser
    );

  }


  /*
    Refresh withdrawal data
  */

  await loadWithdrawalStatus();

}