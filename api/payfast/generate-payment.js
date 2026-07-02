// /api/payfast/generate-payment.js
// PUBLIC endpoint — called from invoice.html when a client clicks
// "Pay Now with PayFast". Looks up which QForge user owns the invoice,
// fetches THEIR PayFast credentials, and builds a signed payment request.
// The passphrase never leaves the server — only the final signed field
// set is returned, which the browser turns into an auto-submitting form.

const crypto = require('crypto');

async function getQuote(invoiceId) {
  // Direct ID match first (composite ids like "userId|INV-001")
  let res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/quotes?id=eq.${encodeURIComponent(invoiceId)}&select=*`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );
  if (!res.ok) throw new Error('Failed to look up invoice');
  let rows = await res.json();
  if (rows[0]) return rows[0];

  // Fallback: someone passed just "INV-001" without the userId prefix
  if (!invoiceId.includes('|')) {
    res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/quotes?id=like.*%7C${encodeURIComponent(invoiceId)}&select=*`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );
    if (res.ok) {
      rows = await res.json();
      if (rows[0]) return rows[0];
    }
  }
  return null;
}

async function getPayfastSettings(userId) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/payfast_settings?user_id=eq.${userId}&select=*`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );
  if (!res.ok) throw new Error('Failed to look up PayFast settings');
  const rows = await res.json();
  return rows[0] || null;
}

// Matches PayFast's required encoding: trim, URL-encode, spaces as '+'
function pfEncode(val) {
  return encodeURIComponent(String(val).trim()).replace(/%20/g, '+');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }

  const { invoiceId } = body || {};
  if (!invoiceId) return res.status(400).json({ error: 'Missing invoiceId' });

  let quote;
  try {
    quote = await getQuote(invoiceId);
  } catch (e) {
    console.error('generate-payment: quote lookup failed:', e.message);
    return res.status(500).json({ error: 'Could not look up this invoice' });
  }
  if (!quote) return res.status(404).json({ error: 'Invoice not found' });

  let settings;
  try {
    settings = await getPayfastSettings(quote.user_id);
  } catch (e) {
    console.error('generate-payment: settings lookup failed:', e.message);
    return res.status(500).json({ error: 'Could not look up payment settings' });
  }

  if (!settings) {
    return res.status(200).json({ connected: false });
  }

  const siteUrl = process.env.PUBLIC_SITE_URL || 'https://myquoteforge.co.za';
  const docNumber = (quote.id || '').split('|').pop();
  const amount = parseFloat(quote.amount || 0).toFixed(2);

  const fields = [];
  fields.push(['merchant_id', settings.merchant_id]);
  fields.push(['merchant_key', settings.merchant_key]);
  fields.push(['return_url', `${siteUrl}/invoice.html?id=${encodeURIComponent(invoiceId)}&payment=success`]);
  fields.push(['cancel_url', `${siteUrl}/invoice.html?id=${encodeURIComponent(invoiceId)}&payment=cancelled`]);
  fields.push(['notify_url', `${siteUrl}/api/payfast/notify`]);
  if (quote.client) fields.push(['name_first', quote.client]);
  fields.push(['m_payment_id', docNumber]);
  fields.push(['amount', amount]);
  fields.push(['item_name', 'Invoice ' + docNumber]);

  const parts = fields.map(([k, v]) => k + '=' + pfEncode(v));
  const sigString = parts.join('&') + '&passphrase=' + pfEncode(settings.passphrase);
  const signature = crypto.createHash('md5').update(sigString).digest('hex');

  return res.status(200).json({
    connected: true,
    actionUrl: 'https://www.payfast.co.za/eng/process',
    fields: Object.fromEntries(fields), // safe — passphrase itself is never included
    signature
  });
};
