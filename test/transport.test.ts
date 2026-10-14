import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {test} from 'node:test';
import {fakePaymentsProvider} from '../src/fakes/payments-provider.ts';
import {stripeLikePayments, type CreatePayment} from '../src/providers/payments.ts';
import {fakeTransport} from '../src/transport/fake.ts';
import {fetchTransport} from '../src/transport/http.ts';
import {recordingTransport, replayTransport, type Interaction} from '../src/transport/recorded.ts';
import type {ProviderError} from '../src/errors.ts';
import {fakeSecret} from './helpers.ts';

const input: CreatePayment = {amountCents: 4200, currency: 'USD', destination: 'acct_creatorA', applicationFeeCents: 640, paymentMethod: 'pm_card_ok', orderId: 'ord_1', operationId: 'op_1'};

function setup() {
  const apiKey = fakeSecret('sk_test');
  const provider = fakePaymentsProvider({apiKey});
  provider.addAccount('acct_creatorA');
  return {apiKey, provider};
}

test('same adapter, three transports: in-process fake, real HTTP over loopback, recorded cassette', async () => {
  // 1. In-process fake.
  const a = setup();
  const viaFake = await stripeLikePayments({apiKey: a.apiKey, transport: fakeTransport(a.provider.handler)}).createPayment(input, 'k1');

  // 2. Real fetch() against a local HTTP server that plays the provider: exercises the production transport.
  const b = setup();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const out = await b.provider.handler({method: req.method as 'GET', url: new URL(req.url!, 'http://x'), headers: req.headers as Record<string, string>, body: Buffer.concat(chunks).toString()});
    res.writeHead(out.status, {'content-type': 'application/json'}).end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const viaHttp = await stripeLikePayments({apiKey: b.apiKey, transport: fetchTransport({timeoutMs: 2000}), baseUrl: base}).createPayment(input, 'k1');
  server.close();

  // 3. Record once, replay offline.
  const c = setup();
  const cassette: Interaction[] = [];
  const recorder = stripeLikePayments({apiKey: c.apiKey, transport: recordingTransport(fakeTransport(c.provider.handler), cassette)});
  const recorded = await recorder.createPayment(input, 'k1');
  const fetched = await recorder.getPayment(recorded.id);
  const replayer = stripeLikePayments({apiKey: 'any-key-replay-ignores-auth', transport: replayTransport(cassette)});
  assert.deepEqual(await replayer.createPayment(input, 'k1'), recorded);
  assert.deepEqual(await replayer.getPayment(recorded.id), fetched);

  for (const p of [viaFake, viaHttp, recorded]) {
    assert.equal(p.status, 'succeeded');
    assert.equal(p.applicationFeeCents, 640);
    assert.equal(p.destination, 'acct_creatorA');
  }
  assert.ok(cassette.every((i) => !JSON.stringify(i).includes(c.apiKey)), 'cassette must not contain the API key');
  assert.equal(cassette[0]!.idempotencyKey, 'k1');
});

test('replay fails loudly when the code drifts from the cassette', async () => {
  const replayer = stripeLikePayments({apiKey: 'x', transport: replayTransport([])});
  await assert.rejects(replayer.getPayment('pi_X1'), (e: ProviderError) => e.code === 'unavailable');
});

test('error classification: mutation vs read, rate limit, path allowlist, kill switch', async () => {
  const {apiKey, provider} = setup();
  const transport = fakeTransport(provider.handler);
  let paused = false;
  const payments = stripeLikePayments({apiKey, transport, pause: {isPaused: () => paused}});

  transport.failNext(() => true, {kind: 'status', status: 503});
  await assert.rejects(payments.createPayment(input, 'k'), (e: ProviderError) => e.code === 'outcome_unknown');
  transport.failNext(() => true, {kind: 'status', status: 503});
  await assert.rejects(payments.getPayment('pi_X1'), (e: ProviderError) => e.code === 'unavailable');
  transport.failNext(() => true, {kind: 'timeout-before'});
  await assert.rejects(payments.createPayment(input, 'k'), (e: ProviderError) => e.code === 'outcome_unknown');
  transport.failNext(() => true, {kind: 'status', status: 429});
  await assert.rejects(payments.getPayment('pi_X1'), (e: ProviderError) => e.code === 'rate_limited' && e.retryAfterSeconds === 60);
  await assert.rejects(payments.getPayment('../accounts'), (e: ProviderError) => e.code === 'path_denied');

  paused = true;
  const before = transport.calls.length;
  await assert.rejects(payments.createPayment(input, 'k'), (e: ProviderError) => e.code === 'provider_paused');
  assert.equal(transport.calls.length, before, 'a paused provider receives no request');
});
