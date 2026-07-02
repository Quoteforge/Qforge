const crypto = require('crypto');

module.exports = async (req, res) => {
  const { access_token } = req.query;

  if (!access_token) {
    return res.status(400).send('Missing access_token — you must be logged in to connect QuickBooks.');
  }

  let userId;
  try {
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        apikey: process.env.SUPABASE_ANON_KEY
      }
    });
    if (!userRes.ok) throw new Error('Session invalid');
    const user = await userRes.json();
    userId = user.id;
    if (!userId) throw new Error('No user id on session');
  } catch (e) {
    console.error('QB connect - auth check failed:', e.message);
    return res.status(401).send('Your session has expired. Please log in again and retry.');
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now();
  const payload = `${userId}.${nonce}.${timestamp}`;
  const signature = crypto
    .createHmac('sha256', process.env.QB_CLIENT_SECRET)
    .update(payload)
    .digest('hex');
  const state = Buffer.from(`${payload}.${signature}`).toString('base64url');

  const authUrl = new URL('https://appcenter.intuit.com/connect/oauth2');
  authUrl.searchParams.set('client_id', process.env.QB_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', process.env.QB_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
  authUrl.searchParams.set('state', state);

  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
};
