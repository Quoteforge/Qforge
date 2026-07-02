// /api/qb/sync-invoice.js
// Creates an invoice in the user's connected QuickBooks company.
// Call this from the browser with a POST request once a quote is
// accepted (or from a manual "Send to QuickBooks" button).
//
// Expected JSON body:
// {
//   "access_token": "<supabase session access token>",
//   "client": { "name": "...", "email": "...", "phone": "...", "address": "..." },
//   "items": [ { "name": "...", "desc": "...", "qty": 1, "price": 100 } ],
//   "quoteNumber": "QUO-001"   // optional, used as the QB invoice DocNumber
// }

const {
  getSupabaseUser,
  getValidQuickBooksAuth,
  qbRequest,
  findOrCreateCustomer,
  findOrCreateServiceItem
} = require('../../lib/qb-helpers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }

  const { access_token, client, items, quoteNumber } = body || {};
  if (!access_token) return res.status(400).json({ error: 'Missing access_token' });
  if (!client?.name) return res.status(400).json({ error: 'Missing client.name' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Missing items' });

  let userId;
  try {
    userId = await getSupabaseUser(access_token);
  } catch (e) {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }

  let accessToken, realmId;
  try {
    ({ accessToken, realmId } = await getValidQuickBooksAuth(userId));
  } catch (e) {
    if (e.code === 'NOT_CONNECTED') {
      return res.status(409).json({ error: 'QuickBooks is not connected. Please connect it first.' });
    }
    console.error('QB auth error:', e.message);
    return res.status(502).json({ error: 'Could not authenticate with QuickBooks' });
  }

  try {
    const customer = await findOrCreateCustomer(accessToken, realmId, client);
    const serviceItem = await findOrCreateServiceItem(accessToken, realmId);

    const line = items.map(item => ({
      DetailType: 'SalesItemLineDetail',
      Amount: (item.qty || 1) * (item.price || 0),
      Description: item.name + (item.desc ? ' - ' + item.desc : ''),
      SalesItemLineDetail: {
        ItemRef: { value: serviceItem.Id },
        Qty: item.qty || 1,
        UnitPrice: item.price || 0
      }
    }));

    const invoicePayload = {
      CustomerRef: { value: customer.Id },
      Line: line
    };
    if (quoteNumber) invoicePayload.DocNumber = quoteNumber;

    const invoiceRes = await qbRequest(accessToken, realmId, '/invoice', {
      method: 'POST',
      body: JSON.stringify(invoicePayload)
    });

    return res.status(200).json({
      success: true,
      quickbooksInvoiceId: invoiceRes.Invoice.Id,
      quickbooksDocNumber: invoiceRes.Invoice.DocNumber
    });
  } catch (e) {
    console.error('QB sync-invoice error:', e.message, e.data ? JSON.stringify(e.data) : '');
    return res.status(502).json({ error: 'Failed to create invoice in QuickBooks' });
  }
};
