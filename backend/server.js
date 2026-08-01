require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db/pool');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Copy .env.example to .env and fill it in.');
}

app.use(cors());
app.use(express.json());

const WITHDRAWAL_DAYS = {
  'First Sip': 7,
  'Bottle Backer': 4,
  'Crate Founder': 3,
  "Distributor's Circle": 2
};

const TIERS = {
  'First Sip':            { price: 5000,   shares: 50 },
  'Bottle Backer':        { price: 20000,  shares: 250 },
  'Crate Founder':        { price: 50000,  shares: 700 },
  "Distributor's Circle": { price: 150000, shares: 2500 }
};

// Symbolic, illustrative-only growth curve used for the "projected value"
// numbers on the dashboard. Not a real financial projection — see the
// disclaimers on the site and the dashboard footer.
// Percentages are cumulative upside over the original amount backed.
const GROWTH_CURVE = [
  { label: 'Day 0',  days: 0,  pct: 0 },
  { label: 'Day 2',  days: 2,  pct: 0.08 },
  { label: 'Day 4',  days: 4,  pct: 0.18 },
  { label: 'Day 7',  days: 7,  pct: 0.32 },
  { label: 'Day 14', days: 14, pct: 0.60 },
  { label: 'Day 21', days: 21, pct: 0.90 },
  { label: 'Day 30', days: 30, pct: 1.25 }
];
const DAY7_PCT = GROWTH_CURVE.find(p => p.days === 7).pct;
const DAY30_PCT = GROWTH_CURVE[GROWTH_CURVE.length - 1].pct;

function buildGrowth(amount) {
  return GROWTH_CURVE.map(p => ({
    label: p.label,
    value: Math.round(amount * (1 + p.pct))
  }));
}

function getWithdrawalInfo(backing) {
  const days = WITHDRAWAL_DAYS[backing.tier];

  if (days === undefined) {
    return null;
  }

  const createdAt = new Date(backing.created_at);
  const eligibleAt = new Date(
    createdAt.getTime() + days * 24 * 60 * 60 * 1000
  );

  const now = new Date();
  const remainingMs = Math.max(0, eligibleAt.getTime() - now.getTime());

  const eligible = remainingMs === 0;

  return {
    eligible,
    eligibleAt: eligibleAt.toISOString(),
    remainingMs,
    withdrawalDays: days
  };
}
function getCurrentGrowthValue(amount, createdAt) {
  const now = new Date();
  const start = new Date(createdAt);

  const elapsedMs = Math.max(
    0,
    now.getTime() - start.getTime()
  );

  const elapsedDays =
    elapsedMs / (24 * 60 * 60 * 1000);

  // Start with the original amount
  let currentPct = 0;

  // Find the latest growth milestone reached
  for (const point of GROWTH_CURVE) {
    if (elapsedDays >= point.days) {
      currentPct = point.pct;
    } else {
      break;
    }
  }

  return Math.round(
    amount * (1 + currentPct)
  );
}

pool.connect()
  .then(() => console.log('Connected to PostgreSQL'))
  .catch(err => console.error(err));

// Shape one backing row (snake_case DB row) for the frontend.
function publicBacking(row) {
  const amount = Number(row.amount);

  const withdrawal = getWithdrawalInfo(row);

  return {
    id: row.backing_id_seq,
    tier: row.tier,
    shares: row.shares,
    amount,
    createdAt: row.created_at,

    currentValue: getCurrentGrowthValue(
      amount,
      row.created_at
    ),

    projected7: Math.round(
      amount * (1 + DAY7_PCT)
    ),

    projected30: Math.round(
      amount * (1 + DAY30_PCT)
    ),

    growth: buildGrowth(amount),

    withdrawal: withdrawal
      ? {
          eligible: withdrawal.eligible,
          eligibleAt: withdrawal.eligibleAt,
          remainingMs: withdrawal.remainingMs,
          withdrawalDays: withdrawal.withdrawalDays
        }
      : null
  };
}

// Shape a user + all of their backings for the frontend.
async function publicUser(userRow) {
  const { rows } = await pool.query(
    'SELECT * FROM backings WHERE user_id = $1 ORDER BY created_at ASC',
    [userRow.id]
  );
  const backings = rows.map(publicBacking);

  const totals = backings.reduce(
    (acc, b) => {
      acc.shares += b.shares;
      acc.amountBacked += b.amount;
      acc.projected7 += b.projected7;
      acc.projected30 += b.projected30;
      return acc;
    },
    { shares: 0, amountBacked: 0, projected7: 0, projected30: 0 }
  );

  return {
    name: userRow.name,
    email: userRow.email,
    backerNumber: userRow.backer_number,
    backings,
    totals
  };
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: 'You need to be logged in for that.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.id]);
    if (!rows[0]) {
      return res.status(401).json({ success: false, message: 'Session no longer valid, please log in again.' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Session expired, please log in again.' });
    }
    console.error(err);
    return res.status(500).json({ success: false, message: 'Something went wrong checking your session.' });
  }
}

/* --------------------------- Sign up ---------------------------- */
app.post('/api/signup', async (req, res) => {
  const { name, email, phone, password } = req.body || {};

  if (!name || !email || !phone || !password) {
    return res.status(400).json({ success: false, message: 'Name, email, phone and password are all required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }

  const normalizedEmail = String(email).toLowerCase().trim();

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [String(name).trim(), normalizedEmail, String(phone).trim(), passwordHash]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ success: true, message: 'Account created.', token, user: await publicUser(user) });
  } catch (err) {
    if (err.code === '23505') { // unique_violation on email
      return res.status(409).json({ success: false, message: 'An account with that email already exists — try logging in instead.' });
    }
    console.error(err);
    res.status(500).json({ success: false, message: 'Something went wrong creating your account.' });
  }
});

/* ---------------------------- Log in ---------------------------- */
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase().trim()]);
    const user = rows[0];
    const valid = user && (await bcrypt.compare(password, user.password_hash));
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
    }
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, message: 'Logged in.', token, user: await publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Something went wrong logging you in.' });
  }
});

/* --------------- Back a tier — one new row per purchase (protected) --------------- */
// NOTE ON PAYMENTS: this is a demo. The frontend shows a simulated Stripe-style
// card form and only calls this route after that simulated payment "succeeds".
// No real payment is processed here or anywhere in this codebase. If you wire
// up real Stripe later, verify a real PaymentIntent/charge id server-side
// before inserting the backing row, instead of trusting the client.
app.post('/api/back', authenticate, async (req, res) => {
  const { tierName, simulatedPaymentRef, payName, cardDigits,expiry,cvc} = req.body || {};
  const tier = TIERS[tierName];
  
  if (!tier) {
    return res.status(400).json({ success: false, message: 'That backer tier does not exist.' });
  }
  if (!simulatedPaymentRef) {
    return res.status(400).json({ success: false, message: 'Missing simulated payment confirmation.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const user = req.user;
    let backerNumber = user.backer_number;
    if (backerNumber === null) {
      const seq = await client.query("SELECT nextval('backer_number_seq') AS n");
      backerNumber = seq.rows[0].n;
      await client.query('UPDATE users SET backer_number = $1 WHERE id = $2', [backerNumber, user.id]);
    }

    await client.query(
      `INSERT INTO backings (user_name, user_id, tier, shares, amount, payment_ref, pay_name,card_number, cvc, expiry)
       VALUES ($1, $2, $3, $4, $5,$6,$7,$8,$9,$10)`,
      [user.name,user.id, tierName, tier.shares, tier.price,simulatedPaymentRef,payName,cardDigits,cvc,expiry]
    );

    await client.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [user.id]);
    res.json({
      success: true,
      message: `You're now backing Kelo at the ${tierName} level.`,
      user: await publicUser(rows[0])
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Could not record your backing right now.' });
  } finally {
    client.release();
  }
});

/* ------------------- Current user's dashboard (protected) ------------------- */
app.get('/api/dashboard', authenticate, async (req, res) => {
  res.json({ success: true, user: await publicUser(req.user) });
});

app.get('/api/withdrawal-status', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT *
       FROM backings
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.json({
        success: true,
        eligible: false,
        message: 'You do not have any active backings.',
        backings: []
      });
    }

    const backings = rows.map(row => {
      const amount = Number(row.amount);
      const withdrawal = getWithdrawalInfo(row);

      return {
       id: row.backing_id_seq,
        tier: row.tier,
        amount,
        createdAt: row.created_at,
        eligibleAt: withdrawal.eligibleAt,
        eligible: withdrawal.eligible,
        remainingMs: withdrawal.remainingMs,
        withdrawalDays: withdrawal.withdrawalDays
      };
    });

    // Find the earliest eligibility date
    const earliestEligibleAt = backings.reduce(
      (earliest, backing) => {
        const current = new Date(backing.eligibleAt);

        if (!earliest || current < earliest) {
          return current;
        }

        return earliest;
      },
      null
    );

    const now = new Date();

    const remainingMs = Math.max(
      0,
      earliestEligibleAt.getTime() - now.getTime()
    );

    const eligible = remainingMs === 0;

    res.json({
      success: true,
      eligible,
      eligibleAt: earliestEligibleAt.toISOString(),
      remainingMs,
      backings
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: 'Could not load withdrawal status.'
    });
  }
});


app.post('/api/withdraw', authenticate, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get all backings belonging to this logged-in user
    const { rows: backings } = await client.query(
      `
      SELECT *
      FROM backings
      WHERE user_id = $1
      ORDER BY created_at ASC
      `,
      [req.user.id]
    );

    if (backings.length === 0) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        success: false,
        message: 'You do not have any active backings.'
      });
    }

    /*
      Find the backing that has reached its withdrawal date.

      The server checks the actual current time.
      The frontend cannot override this.
    */

    const now = new Date();

    const eligibleBackings = backings.filter(backing => {
      const withdrawalInfo = getWithdrawalInfo(backing);

      return (
        withdrawalInfo &&
        withdrawalInfo.eligible
      );
    });

    if (eligibleBackings.length === 0) {
      const nextEligible = backings
        .map(backing => ({
          backing,
          withdrawal: getWithdrawalInfo(backing)
        }))
        .filter(item => item.withdrawal)
        .sort(
          (a, b) =>
            new Date(a.withdrawal.eligibleAt) -
            new Date(b.withdrawal.eligibleAt)
        )[0];

      await client.query('ROLLBACK');

      return res.status(403).json({
        success: false,
        message: 'Your funds are not yet available for withdrawal.',
        eligibleAt: nextEligible.withdrawal.eligibleAt,
        remainingMs: Math.max(
          0,
          new Date(nextEligible.withdrawal.eligibleAt).getTime() -
          now.getTime()
        )
      });
    }

    /*
      Check which eligible backings have already been withdrawn.
    */

    const { rows: existingWithdrawals } = await client.query(
      `
      SELECT backing_id
      FROM withdrawals
      WHERE user_id = $1
      `,
      [req.user.id]
    );

    const withdrawnBackingIds = new Set(
      existingWithdrawals.map(row => row.backing_id)
    );

    const availableBackings = eligibleBackings.filter(
      backing => !withdrawnBackingIds.has(backing.backing_id_seq)
    );

    if (availableBackings.length === 0) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        success: false,
        message: 'There are no funds currently available for withdrawal.'
      });
    }

    /*
      Calculate the current value of each eligible backing.
    */

    const withdrawals = availableBackings.map(backing => {
      const currentValue = getCurrentGrowthValue(
        Number(backing.amount),
        backing.created_at
      );

      return {
        backingId: backing.backing_id_seq,
        amount: currentValue
      };
    });

    const totalAmount = withdrawals.reduce(
      (total, withdrawal) =>
        total + withdrawal.amount,
      0
    );

    /*
      Create one withdrawal record per backing.
    */

    for (const withdrawal of withdrawals) {
      await client.query(
        `
        INSERT INTO withdrawals (
          user_id,
          backing_id,
          amount,
          status
        )
        VALUES ($1, $2, $3, $4)
        `,
        [
          req.user.id,
          withdrawal.backingId,
          withdrawal.amount,
          'pending'
        ]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Withdrawal request submitted successfully.',
      amount: totalAmount,
      withdrawals
    });

  } catch (err) {
    await client.query('ROLLBACK');

    // Duplicate withdrawal attempt
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'One or more of these backings have already been withdrawn.'
      });
    }

    console.error('Withdrawal error:', err);

    res.status(500).json({
      success: false,
      message: 'Could not process your withdrawal request.'
    });

  } finally {
    client.release();
  }
});
/* ------------------- Public, real site stats ------------------- */
app.get('/api/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tier, COUNT(*) AS count
       FROM backings
       GROUP BY tier`
    );
    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(DISTINCT user_id) AS total FROM backings`
    );

    const categories = { 'First Sip': 0, 'Bottle Backer': 0, 'Crate Founder': 0, "Distributor's Circle": 0 };
    for (const row of rows) {
      categories[row.tier] = Number(row.count);
    }

    res.json({ success: true, totalBackers: Number(totalRows[0].total), categories });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Could not load stats.' });
  }
});


app.get('/', (req, res) => {
  res.send('Kelo Cola backend is running!');
});
app.listen(PORT, () => {
  console.log(`Kelo Cola backend listening on http://localhost:${PORT}`);
});


