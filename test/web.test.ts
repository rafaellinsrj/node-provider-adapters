import assert from 'node:assert/strict';
import type {AddressInfo} from 'node:net';
import {after, before, test} from 'node:test';
import {allowedScripts, parseConsent} from '../src/web/consent.ts';
import {contentSecurityPolicy} from '../src/web/csp.ts';
import {createWebServer} from '../src/web/server.ts';

const TAG = {purpose: 'measurement' as const, src: 'https://analytics.example/tag.js'};
const server = createWebServer({thirdParty: [TAG], secureCookies: false});
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/**
 * Minimal CSP Level 3 evaluation for inline <script> elements: allowed only if script-src lists the element's nonce,
 * or has 'unsafe-inline' and no nonce/hash (browsers ignore 'unsafe-inline' when a nonce is present).
 */
function inlineScriptAllowed(policy: string, scriptNonce: string | null): boolean {
  const directive = policy.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src ')) ?? policy.split(';').find((d) => d.trim().startsWith('default-src')) ?? '';
  const sources = directive.split(/\s+/).slice(1);
  const nonces = sources.filter((s) => s.startsWith("'nonce-")).map((s) => s.slice(7, -1));
  if (scriptNonce && nonces.includes(scriptNonce)) return true;
  return sources.includes("'unsafe-inline'") && nonces.length === 0 && !sources.some((s) => s.startsWith("'sha"));
}

const get = (cookie?: string) => fetch(base + '/', {headers: cookie ? {cookie} : {}});
const scriptNonces = (html: string) => [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => /nonce="([^"]+)"/.exec(m[1]!)?.[1] ?? null);
const policyNonce = (csp: string) => /'nonce-([^']+)'/.exec(csp)![1]!;

test('a fresh nonce on every response, carried by every script and never cached', async () => {
  const [a, b] = await Promise.all([get(), get()]);
  const cspA = a.headers.get('content-security-policy')!;
  const cspB = b.headers.get('content-security-policy')!;
  assert.notEqual(policyNonce(cspA), policyNonce(cspB));
  const html = await a.text();
  assert.ok(scriptNonces(html).length > 0);
  assert.ok(scriptNonces(html).every((n) => n === policyNonce(cspA)), 'every script tag carries this response nonce');
  assert.equal(a.headers.get('cache-control'), 'private, no-store');
  assert.ok(!cspA.includes('unsafe-inline') && !cspA.includes('unsafe-eval'));
  assert.match(cspA, /object-src 'none'/);
  assert.match(cspA, /base-uri 'none'/);
  assert.match(cspA, /frame-ancestors 'none'/);
  assert.equal(a.headers.get('x-content-type-options'), 'nosniff');
});

test('inline scripts without the current nonce are blocked by the policy', async () => {
  const res = await get();
  const csp = res.headers.get('content-security-policy')!;
  assert.equal(inlineScriptAllowed(csp, policyNonce(csp)), true);
  assert.equal(inlineScriptAllowed(csp, null), false, 'injected <script> without nonce');
  assert.equal(inlineScriptAllowed(csp, 'guessed-nonce'), false);
  const old = (await get()).headers.get('content-security-policy')!;
  assert.equal(inlineScriptAllowed(csp, policyNonce(old)), false, 'a nonce from another response');
  // Sanity check of the evaluator itself: a lax policy would allow it.
  assert.equal(inlineScriptAllowed("script-src 'self' 'unsafe-inline'", null), true);
  assert.throws(() => contentSecurityPolicy("abc' 'unsafe-inline"));
});

test('consent gate: no choice -> banner, no tag, origin not allowed by CSP', async () => {
  const res = await get();
  const html = await res.text();
  assert.ok(html.includes('action="/consent"'));
  assert.ok(!html.includes('analytics.example'));
  assert.ok(!res.headers.get('content-security-policy')!.includes('analytics.example'));
});

test('consent gate: accepting sets a first-party cookie; then the tag loads with the nonce and its origin is allowed', async () => {
  const post = await fetch(base + '/consent', {method: 'POST', body: 'measurement=1', headers: {'content-type': 'application/x-www-form-urlencoded'}, redirect: 'manual'});
  assert.equal(post.status, 303);
  const cookie = post.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal(cookie, 'consent=v1.m1.k0');
  const res = await get(cookie);
  const html = await res.text();
  const csp = res.headers.get('content-security-policy')!;
  assert.match(html, new RegExp(`<script nonce="${policyNonce(csp).replace(/[+/]/g, '\\$&')}" src="https://analytics.example/tag.js"`));
  assert.match(csp, /script-src 'self' 'nonce-[^']+' https:\/\/analytics\.example/);
  assert.ok(!html.includes('action="/consent"'));
});

test('consent gate: refusal and unknown cookie versions load nothing', async () => {
  for (const cookie of ['consent=v1.m0.k0', 'consent=v0.m1.k1', 'consent=garbage']) {
    const html = await (await get(cookie)).text();
    assert.ok(!html.includes('analytics.example'), cookie);
  }
  assert.equal(parseConsent('a=1; consent=v0.m1.k1'), null);
  assert.deepEqual(allowedScripts(null, [TAG]), []);
  assert.deepEqual(allowedScripts({measurement: false, marketing: true}, [TAG]), []);
});
