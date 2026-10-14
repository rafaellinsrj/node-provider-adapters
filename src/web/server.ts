import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {ProviderError} from '../errors.ts';
import type {WebhookResult} from '../webhooks/processor.ts';
import {allowedScripts, consentCookie, parseConsent, type ThirdPartyScript} from './consent.ts';
import {contentSecurityPolicy, newNonce} from './csp.ts';

export interface WebServerOptions {
  thirdParty?: ThirdPartyScript[];
  webhook?: (raw: Buffer, signature: string | null) => Promise<WebhookResult>;
  secureCookies?: boolean;
}

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const MAX_BODY = 256 * 1024;

// Minimal framework-free server showing the web-side patterns: per-request CSP nonce, consent-gated third-party
// scripts, and a webhook endpoint that verifies the raw body. The same ideas map to a Next.js proxy/middleware.
export function createWebServer(opts: WebServerOptions = {}): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') return page(req, res, opts);
      if (req.method === 'POST' && url.pathname === '/consent') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        const choice = {measurement: form.get('measurement') === '1', marketing: form.get('marketing') === '1'};
        res.writeHead(303, {...BASE_HEADERS, location: '/', 'set-cookie': consentCookie(choice, {secure: opts.secureCookies ?? true})});
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/payments' && opts.webhook) {
        const signature = req.headers['stripe-signature'];
        const result = await opts.webhook(await readBody(req), typeof signature === 'string' ? signature : null);
        return json(res, 200, {received: true, duplicate: result.duplicate});
      }
      json(res, 404, {error: 'not_found'});
    } catch (e) {
      // Stable codes only; never echo internal messages.
      const status = e instanceof ProviderError ? e.status : 500;
      json(res, status, {error: e instanceof ProviderError ? e.code : 'internal_error'});
    }
  });
}

function page(req: IncomingMessage, res: ServerResponse, opts: WebServerOptions) {
  const nonce = newNonce();
  const consent = parseConsent(req.headers.cookie);
  const scripts = allowedScripts(consent, opts.thirdParty ?? []);
  const origins = [...new Set(scripts.map((s) => new URL(s.src).origin))];
  const banner = consent
    ? ''
    : `<form method="post" action="/consent" class="banner">
  <p>Usamos cookies de medição somente com a sua permissão.</p>
  <button name="measurement" value="1">Aceitar medição</button>
  <button name="measurement" value="0">Recusar</button>
</form>`;
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Demo CSP</title>
<style nonce="${nonce}">body{font-family:system-ui;margin:2rem}.banner{border:1px solid #ccc;padding:1rem}</style>
<script nonce="${nonce}">document.documentElement.dataset.js = '1';</script>
${scripts.map((s) => `<script nonce="${nonce}" src="${s.src}" async></script>`).join('\n')}
</head><body><h1>Página com CSP estrita</h1>${banner}</body></html>`;
  res.writeHead(200, {
    ...BASE_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': contentSecurityPolicy(nonce, {scriptOrigins: origins, connectOrigins: origins}),
    // The nonce is per response: a shared cache must never serve this HTML to someone else.
    'cache-control': 'private, no-store',
    vary: 'Cookie',
  });
  res.end(html);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {...BASE_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store'});
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ProviderError(413, 'bad_payload');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
