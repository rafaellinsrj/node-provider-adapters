import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ProviderError} from '../src/errors.ts';
import {fakeEmailProvider} from '../src/fakes/email-provider.ts';
import {createOperations} from '../src/operations/operations.ts';
import {createMailer} from '../src/operations/outbox.ts';
import {resendLikeEmail} from '../src/providers/email.ts';
import {hostedKyc} from '../src/providers/kyc.ts';
import {providerStatus} from '../src/providers/registry.ts';
import {graphLikeSocial} from '../src/providers/social.ts';
import {memoryStore} from '../src/store/memory.ts';
import {fakeTransport} from '../src/transport/fake.ts';
import {clock, fakeSecret} from './helpers.ts';

test('e-mail outbox: lost response -> unknown -> reconcile -> resent with the same key -> exactly one e-mail', async () => {
  const apiKey = fakeSecret('re');
  const fake = fakeEmailProvider({apiKey});
  const transport = fakeTransport(fake.handler);
  const store = memoryStore();
  const time = clock();
  const operations = createOperations(store, {configDigest: 'mail-1', now: time.now});
  const mailer = createMailer({store, operations, email: resendLikeEmail({apiKey, transport})});

  const op = await mailer.enqueue('ord_1', {from: 'shop@example.com', to: 'buyer@example.com', subject: 'Recibo', text: 'Obrigado'});
  transport.failNext(() => true, {kind: 'timeout-after'});
  await assert.rejects(mailer.deliver(op.id), (e: ProviderError) => e.code === 'outcome_unknown');
  time.advance(60_000);
  await mailer.reconcileDue();
  assert.equal(fake.sent.length, 1);
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[0]!.headers['idempotency-key'], transport.calls[1]!.headers['idempotency-key']);
  assert.equal((await store.tx((tx) => tx.getOperation(op.id)))!.status, 'succeeded');
});

test('KYC session: only HTTPS URLs without credentials are accepted from the provider', async () => {
  const replies = [
    {status: 201, body: {session_id: 'sess-0001', url: 'https://verify.example/s/1', status: 'Not Started'}},
    {status: 201, body: {session_id: 'sess-0002', url: 'http://verify.example/s/2', status: 'Not Started'}},
  ];
  const kyc = hostedKyc({apiKey: fakeSecret('key'), workflowId: 'wf', webhookSecret: fakeSecret('kyc'), baseUrl: 'https://kyc.example', transport: fakeTransport(() => replies.shift()!)});
  assert.deepEqual(await kyc.createSession({reference: 'req-1', callbackUrl: 'https://app.example/back'}), {sessionId: 'sess-0001', url: 'https://verify.example/s/1', result: 'started'});
  await assert.rejects(kyc.createSession({reference: 'req-2', callbackUrl: 'https://app.example/back'}), (e: ProviderError) => e.code === 'invalid_result');
});

test('registry explains why a provider is off; social adapter refuses to start before app review', () => {
  const status = providerStatus({enabled: true, payments: {apiKey: 'x', webhookSecrets: []}, social: {network_a: {clientId: 'c', clientSecret: 's', apiVersion: 'v1.0'}}});
  assert.deepEqual(status.payments, {available: false, reason: 'payments_configuration_required'});
  assert.deepEqual(status.network_a, {available: false, reason: 'app_review_required'});
  assert.deepEqual(providerStatus({enabled: false}).email, {available: false, reason: 'integrations_disabled'});
  assert.throws(() => graphLikeSocial('network_a', {clientId: 'c', clientSecret: 's', apiVersion: 'v1.0'}, fakeTransport(() => ({status: 200, body: {}})), 'https://graph.example'));
});

test('social publish goes through the transport and validates ids', async () => {
  const transport = fakeTransport(() => ({status: 200, body: {id: '123_456'}}));
  const social = graphLikeSocial('network_a', {clientId: 'c', clientSecret: 's', apiVersion: 'v1.0', reviewApproved: true}, transport, 'https://graph.example');
  assert.deepEqual(await social.publish({accountId: '123', accessToken: fakeSecret('tok'), text: 'Oi', outboxId: 'o1'}), {postId: '123_456'});
  assert.equal(transport.calls[0]!.url.pathname, '/v1.0/123/feed');
  await assert.rejects(social.publish({accountId: '../me', accessToken: 't', text: 'x', outboxId: 'o2'}), (e: ProviderError) => e.code === 'path_denied');
});
