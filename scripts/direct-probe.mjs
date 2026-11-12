// Sandbox-only capability probe. Never logs credentials, OAuth or payment tokens.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
process.loadEnvFile('.env.sandbox');
const base = 'https://api-m.sandbox.paypal.com';
const id = process.env.PAYPAL_SANDBOX_CLIENT_ID?.trim();
const secret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET?.trim();
if (!id || !secret) throw new Error('Missing sandbox credentials');
const auth = await fetch(base + '/v1/oauth2/token', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
  headers: { authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});
console.log('Sandbox OAuth HTTP:', auth.status);
if (!auth.ok) process.exit(1);
const { access_token: token, scope = '' } = await auth.json();
console.log('Vault-related OAuth scope present:', /vault|payment-tokens/.test(scope));
const res = await fetch(base + '/v3/vault/setup-tokens', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'paypal-request-id': randomUUID() },
  body: JSON.stringify({ payment_source: { paypal: {
    description: 'Coffee restock sandbox: one merchant, one purchase after explicit consent',
    usage_type: 'MERCHANT', customer_type: 'CONSUMER', permit_multiple_payment_tokens: false,
    experience_context: { return_url: 'http://localhost:4030/paypal/vault-return', cancel_url: 'http://localhost:4030/?vault=cancelled', shipping_preference: 'GET_FROM_FILE' },
  } } }),
});
const body = await res.json().catch(() => ({}));
const result = { checkedAt: new Date().toISOString(), environment: 'sandbox', oauth: auth.status,
  vaultSetupHttp: res.status, vaultSetupStatus: body.status, error: body.name,
  issues: body.details?.map(d => ({ issue: d.issue, field: d.field })),
  offSessionVerified: false, directCaptureVerified: false };
mkdirSync('data', { recursive: true });
writeFileSync('data/capabilities.json', JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
if (res.ok) {
  const approveUrl = body.links?.find(l => l.rel === 'approve')?.href;
  writeFileSync('data/vault-probe.json', JSON.stringify({ setupTokenId: body.id, approveUrl }), { mode: 0o600 });
  console.log('Consent URL saved locally. No wallet saved and no payment attempted.');
}
