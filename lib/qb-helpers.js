// /lib/qb-helpers.js
// Shared helpers for talking to QuickBooks. Not a route itself —
// required by files under /api/qb/. Keep this OUTSIDE the /api folder
// so Vercel doesn't try to treat it as its own serverless function.

async function getSupabaseUser(accessToken) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: process.env.SUPABASE_ANON_KEY
    }
  });
  if (!res.ok) throw new Error('Invalid or expired session');
  const user = await res.json();
  if (!user.id) throw new Error('No user id on session');
  return user.id;
}

async function getIntegration(userId, provider) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/integrations?user_id=eq.${userId}&provider=eq.${provider}&select=*`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );
  if (!res.ok) throw new Error('Failed to look up integration');
  const rows = await res.json();
  return rows[0] || null;
}

async function saveIntegrationTokens(userId, provider, tokens, realmId) {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/integrations?on_conflict=user_id,provider`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        user_id: userId,
        provider,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        realm_id: realmId,
        expires_at: expiresAt,
        connected_at: new Date().toISOString()
      })
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Failed to save refreshed tokens: ' + errText);
  }
}

async function refreshQuickBooksToken(refreshToken) {
  const basicAuth = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('QuickBooks token refresh failed: ' + errText);
  }
  return res.json();
}

// Returns a valid, non-expired access token + realmId for a user's
// QuickBooks connection. Refreshes automatically if the stored token
// is expired or about to expire.
async function getValidQuickBooksAuth(userId) {
  const integration = await getIntegration(userId, 'quickbooks');
  if (!integration) {
    const err = new Error('QuickBooks is not connected for this user');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const expiresAt = new Date(integration.expires_at).getTime();
  const bufferMs = 2 * 60 * 1000; // refresh 2 minutes before actual expiry
  if (Date.now() < expiresAt - bufferMs) {
    return { accessToken: integration.access_token, realmId: integration.realm_id };
  }

  const tokens = await refreshQuickBooksToken(integration.refresh_token);
  await saveIntegrationTokens(userId, 'quickbooks', tokens, integration.realm_id);
  return { accessToken: tokens.access_token, realmId: integration.realm_id };
}

const QB_API_BASE = process.env.QB_ENVIRONMENT === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

async function qbRequest(accessToken, realmId, path, options = {}) {
  const res = await fetch(`${QB_API_BASE}/v3/company/${realmId}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('QuickBooks API error: ' + JSON.stringify(data));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Finds a customer by display name, creating one if it doesn't exist yet.
async function findOrCreateCustomer(accessToken, realmId, client) {
  const safeName = (client.name || 'Client').replace(/'/g, "\\'");
  const query = `select * from Customer where DisplayName = '${safeName}'`;
  const searchRes = await qbRequest(accessToken, realmId, `/query?query=${encodeURIComponent(query)}`);
  const existing = searchRes.QueryResponse?.Customer?.[0];
  if (existing) return existing;

  const newCustomer = {
    DisplayName: client.name || 'Client',
    PrimaryEmailAddr: client.email ? { Address: client.email } : undefined,
    PrimaryPhone: client.phone ? { FreeFormNumber: client.phone } : undefined,
    BillAddr: client.address ? { Line1: client.address } : undefined
  };
  const createRes = await qbRequest(accessToken, realmId, '/customer', {
    method: 'POST',
    body: JSON.stringify(newCustomer)
  });
  return createRes.Customer;
}

// QuickBooks requires every invoice line to reference an Item.
// We use one generic "Services" item for all QForge line items,
// creating it in the QB company the first time it's needed.
async function findOrCreateServiceItem(accessToken, realmId) {
  const query = `select * from Item where Name = 'Services'`;
  const searchRes = await qbRequest(accessToken, realmId, `/query?query=${encodeURIComponent(query)}`);
  const existing = searchRes.QueryResponse?.Item?.[0];
  if (existing) return existing;

  const acctQuery = `select * from Account where AccountType = 'Income'`;
  const acctRes = await qbRequest(accessToken, realmId, `/query?query=${encodeURIComponent(acctQuery)}`);
  const incomeAccount = acctRes.QueryResponse?.Account?.[0];
  if (!incomeAccount) throw new Error('No income account found in QuickBooks company to attach a service item to');

  const createRes = await qbRequest(accessToken, realmId, '/item', {
    method: 'POST',
    body: JSON.stringify({
      Name: 'Services',
      Type: 'Service',
      IncomeAccountRef: { value: incomeAccount.Id }
    })
  });
  return createRes.Item;
}

module.exports = {
  getSupabaseUser,
  getValidQuickBooksAuth,
  qbRequest,
  findOrCreateCustomer,
  findOrCreateServiceItem
};
