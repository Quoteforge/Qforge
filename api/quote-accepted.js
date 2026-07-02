// /api/quote-accepted.js
// Called from quote.html when a client clicks "Accept & Sign".
// This is a PUBLIC endpoint (the client accepting a quote is not a
// logged-in QForge user) — it identifies the quote's owner from the
// quote record itself, not from a session token.
//
// What it does:
//  1. Marks the quote as accepted in Supabase (idempotent — safe to call twice)
//  2. If the quote owner has QuickBooks connected, creates an invoice there
//  3. Never lets a QuickBooks failure block the acceptance itself —
//     the client's "quote accepted" experience always succeeds even if
//     the QuickBooks sync fails behind the scenes (logged for follow-up)

const { getValidQuickBooksAuth, createInvoice } = require('../lib/qb-helpers');

async function getQuote(quoteId) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/quotes?id=eq.${encodeURIComponent(quoteId)}&select=*`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );
  if (!res.ok) throw new Error('Failed to look up quote');
  const rows = await res.json();
  return rows[0] || null;
}

async function updateQuote(quoteId, fields) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/quotes?id=eq.${encodeURIComponent(quoteId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(fields)
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Failed to update quote: ' + errText);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }

  const { quoteId, signerName, signatureDataUrl } = body || {};
  if (!quoteId) return res.status(400).json({ error: 'Missing quoteId' });
  if (!signerName) return res.status(400).json({ error: 'Missing signerName' });

  let quote;
  try {
    quote = await getQuote(quoteId);
  } catch (e) {
    console.error('quote-accepted: lookup failed:', e.message);
    return res.status(500).json({ error: 'Could not look up this quote' });
  }
  if (!quote) return res.status(404).json({ error: 'Quote not found' });

  // Idempotent: if already accepted, don't re-run the sync or overwrite
  // the original acceptance details — just report the existing state.
  if (quote.status === 'accepted') {
    return res.status(200).json({
      success: true,
      alreadyAccepted: true,
      acceptedBy: quote.accepted_by,
      acceptedAt: quote.accepted_at,
      quickbooksSynced: !!quote.qb_invoice_id,
      quickbooksInvoiceId: quote.qb_invoice_id || null
    });
  }

  // Save the acceptance itself first — this is the part that must not fail
  const acceptedAt = new Date().toISOString();
  try {
    await updateQuote(quoteId, {
      status: 'accepted',
      accepted_by: signerName,
      accepted_at: acceptedAt,
      signature: signatureDataUrl || null
    });
  } catch (e) {
    console.error('quote-accepted: save failed:', e.message);
    return res.status(500).json({ error: 'Could not save your acceptance. Please try again.' });
  }

  // From here on, QuickBooks sync is best-effort. Any failure here is
  // logged but does NOT change the response the client sees — they've
  // already successfully accepted the quote.
  let quickbooksSynced = false;
  let quickbooksInvoiceId = null;
  let quickbooksError = null;

  try {
    const ownerId = quote.user_id;
    const { accessToken, realmId } = await getValidQuickBooksAuth(ownerId);

    const client = {
      name: quote.client || 'Client',
      email: quote.email || undefined,
      phone: quote.contact || undefined,
      address: quote.address || undefined
    };
    const items = quote.items || [];
    const docNumber = (quote.id || '').split('|').pop(); // e.g. "QUO-001" from "userId|QUO-001"

    const invoice = await createInvoice(accessToken, realmId, client, items, docNumber);
    quickbooksSynced = true;
    quickbooksInvoiceId = invoice.Id;

    await updateQuote(quoteId, {
      qb_invoice_id: invoice.Id,
      qb_synced_at: new Date().toISOString()
    });
  } catch (e) {
    if (e.code === 'NOT_CONNECTED') {
      // Owner just hasn't connected QuickBooks — not an error, nothing to log
    } else {
      quickbooksError = e.message;
      console.error('quote-accepted: QuickBooks sync failed:', e.message, e.data ? JSON.stringify(e.data) : '');
    }
  }

  return res.status(200).json({
    success: true,
    acceptedBy: signerName,
    acceptedAt,
    quickbooksSynced,
    quickbooksInvoiceId,
    quickbooksError // null unless something genuinely broke (not just "not connected")
  });
};
