// /api/payfast/disconnect.js
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }

  const { access_token } = body || {};
  if (!access_token) return res.status(400).json({ error: 'Missing access_token' });

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
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }

  try {
    const delRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/payfast_settings?user_id=eq.${userId}`,
      {
        method: 'DELETE',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );
    if (!delRes.ok) {
      const errText = await delRes.text();
      throw new Error(errText);
    }
  } catch (e) {
    console.error('PayFast disconnect failed:', e.message);
    return res.status(500).json({ error: 'Failed to disconnect PayFast' });
  }

  return res.status(200).json({ success: true });
};
