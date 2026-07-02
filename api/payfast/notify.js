// /api/payfast/notify.js
// PayFast calls this server-to-server after a payment completes (the "ITN" —
// Instant Transaction Notification). This is NOT the customer's browser
// redirect — it's a separate background POST from PayFast's own servers,
// which is why we trust it to mark an invoice as paid.
//
// IMPORTANT — before relying on this for real money, PayFast's own docs
// require two additional checks this file does NOT yet do:
//   1. Verify the request signature against your passphrase
//   2. Post the received data back to PayFast's validate endpoint
//      (https://www.payfast.co.za/eng/query/validate) and confirm it
//      returns VALID, to rule out spoofed requests
// Right now this trusts the m_payment_id + amount match, which is fine
// for testing but should be hardened with the above before go-live.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Use POST');
  }

  const data = req.body || {};
  const paymentStatus = data.payment_status;
  const mPaymentId = data.m_payment_id; // this is the invoice docNumber we sent, e.g. "INV-001"
  const amountGross = data.amount_gross;

  console.log('PayFast ITN received:', { mPaymentId, paymentStatus, amountGross });

  if (paymentStatus !== 'COMPLETE' || !mPaymentId) {
    // Acknowledge receipt either way — PayFast expects a 200 regardless,
    // we just don't mark anything paid unless it's a genuine completion.
    return res.status(200).send('OK');
  }

  try {
    // Find the invoice by matching the tail of its composite id
    const searchRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/quotes?id=like.*%7C${encodeURIComponent(mPaymentId)}&select=id`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );
    const rows = await searchRes.json();
    const invoice = rows[0];

    if (invoice) {
      await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/quotes?id=eq.${encodeURIComponent(invoice.id)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            payment_status: 'paid',
            paid_at: new Date().toISOString()
          })
        }
      );
    } else {
      console.error('PayFast ITN: no matching invoice found for', mPaymentId);
    }
  } catch (e) {
    console.error('PayFast ITN: failed to update invoice:', e.message);
  }

  res.status(200).send('OK');
};
