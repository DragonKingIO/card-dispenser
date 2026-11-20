// Stripe：回调验签 + 最小 API 客户端（退款、查流水）。
// 跑在 Worker 里，用 crypto.subtle 做 HMAC-SHA256，不依赖任何 SDK。

// 验签：Stripe-Signature 形如 t=1492774577,v1=abc...,v0=...。
// 签名体是 `${t}.${rawBody}`，时间戳超过 5 分钟直接拒掉，防重放。
export async function verifyStripeSignature(rawBody, signatureHeader, webhookSecret, toleranceSec = 300) {
  if (!signatureHeader || !webhookSecret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const [k, ...rest] = p.split('=');
      return [k, rest.join('=')];
    })
  );
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const signedPayload = `${t}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expectedHex = [...new Uint8Array(expected)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expectedHex, parts.v1 || '');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function stripeRefund(secretKey, paymentIntentId, amountCents, reason) {
  const res = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      payment_intent: paymentIntentId,
      amount: String(amountCents),
      reason: reason || 'requested_by_customer',
    }),
  });
  if (!res.ok) throw new Error(`stripe refund failed: ${res.status}`);
  return res.json();
}

export async function stripeListCharges(secretKey, { limit = 100, startingAfter, createdGte } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (startingAfter) params.set('starting_after', startingAfter);
  if (createdGte) params.set('created[gte]', String(createdGte));
  const res = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) throw new Error(`stripe list charges failed: ${res.status}`);
  return res.json();
}
