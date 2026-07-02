const crypto = require('crypto');

module.exports = async (req, res) => {
  const { code, state, realmId, error } = req.query;

  if (error) {
    return res.redirect(`/billing.html?qb_error=${encodeURIComponent(error)}`);
  }

  if (!code || !state || !realmId) {
    return res.status(400).send('Missing required parameters from QuickBooks.');
  }

  let userId;
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    const signature = parts.pop();
    const timestamp = parts.pop();
    const nonce = parts.pop();
    userId = parts.join('.');

    const payload = `${userId}.${nonce}.${timestamp}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.QB_CLIENT_SECRET)
      .update(payload)
      .digest('hex');

    if (signature !== expectedSignature) throw new Error('Signature mismatch');
    if (Date.now() - Number(timestamp) > 10 * 60 * 1000) throw new Error('State expired (older than 10 minutes)');
  } catch (e) {
    console.error('QB callback - state verification failed:', e.message);
    return res.status(400).send('This connection link has expired or is invalid. Please try connecting again.');
  }

  let tokens;
  try {
    const basicAuth = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.QB_REDIRECT_URI
      })
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('QB token exchange failed:', tokenRes.status, errText);
      return res.status(502).send('Failed to connect to QuickBooks. Please try again.');
    }

    tokens = await tokenRes.json();
  } catch (e) {
    console.error('QB callback - token exchange error:', e.message);
    return res.status(502).send('Failed to connect to QuickBooks. Please try again.');
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  try {
    const upsertRes = await fetch(
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
          provider: 'quickbooks',
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          realm_id: realmId,
          expires_at: expiresAt,
          connected_at: new Date().toISOString()
        })
      }
    );

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.error('Supabase upsert failed:', upsertRes.status, errText);
      return res.status(500).send('Connected to QuickBooks, but failed to save the connection. Please contact support.');
    }
  } catch (e) {
    console.error('QB callback - Supabase write error:', e.message);
    return res.status(500).send('Connected to QuickBooks, but failed to save the connection. Please contact support.');
  }

  res.writeHead(302, { Location: '/billing.html?qb_connected=1' });
  res.end();
};
