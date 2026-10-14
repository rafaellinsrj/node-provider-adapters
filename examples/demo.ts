// End-to-end tour with fake transports. No keys, no network (the web part listens on 127.0.0.1 only).
// Run: npm run demo
import {randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {fakeEmailProvider} from '../src/fakes/email-provider.ts';
import {fakePaymentsProvider} from '../src/fakes/payments-provider.ts';
import {createMarketplace} from '../src/marketplace/orders.ts';
import {createOperations} from '../src/operations/operations.ts';
import {createMailer} from '../src/operations/outbox.ts';
import {resendLikeEmail} from '../src/providers/email.ts';
import {stripeLikePayments} from '../src/providers/payments.ts';
import {memoryStore} from '../src/store/memory.ts';
import {fakeTransport} from '../src/transport/fake.ts';
import {createWebServer} from '../src/web/server.ts';
import {createWebhookProcessor} from '../src/webhooks/processor.ts';
import {signStripeStyle} from '../src/webhooks/signature.ts';

const fake = (prefix: string) => `${prefix}_FAKE${randomBytes(8).toString('hex')}`;
const usd = (c: number) => `US$ ${(c / 100).toFixed(2)}`;
const step = (title: string) => console.log(`\n== ${title}`);

let offset = 0;
const now = () => new Date(Date.now() + offset);

const store = memoryStore();
const payKey = fake('sk_test');
const provider = fakePaymentsProvider({apiKey: payKey});
const payTransport = fakeTransport(provider.handler);
const payments = stripeLikePayments({apiKey: payKey, transport: payTransport});
const operations = createOperations(store, {configDigest: 'demo-config', now});
const market = createMarketplace({store, payments, operations});
const mailKey = fake('re');
const mailbox = fakeEmailProvider({apiKey: mailKey});
const mailTransport = fakeTransport(mailbox.handler);
const mailer = createMailer({store, operations, email: resendLikeEmail({apiKey: mailKey, transport: mailTransport})});

provider.addAccount('acct_demoCreator');
await store.tx((tx) => tx.putCreator({id: 'creator-demo', tier: 'basic', payoutAccount: 'acct_demoCreator'}));
const isCharge = (r: {method: string; url: URL}) => r.method === 'POST' && r.url.pathname.endsWith('/payment_intents');

step('1. Venda com comissão dentro do mesmo pagamento');
const o1 = await market.createOrder({creatorId: 'creator-demo', amountCents: 5000, currency: 'usd', paymentMethod: 'pm_card_ok'});
const s = o1.split;
console.log(`pedido ${usd(s.grossCents)} -> comissão ${usd(s.commissionCents)} (${s.rateBps / 100}%), processamento ${usd(s.processingCents)}, líquido do criador ${usd(s.sellerNetCents)}`);
const p1 = await market.pay(o1.id);
console.log(`status: ${p1.status}; saldo do criador no provedor ${usd(provider.balance('acct_demoCreator'))}, plataforma ${usd(provider.balance('platform'))}`);

step('2. Timeout depois da cobrança: estado unknown e conciliação');
const o2 = await market.createOrder({creatorId: 'creator-demo', amountCents: 2000, currency: 'usd', paymentMethod: 'pm_card_ok'});
payTransport.failNext(isCharge, {kind: 'timeout-after'});
await market.pay(o2.id).catch((e) => console.log(`pay() falhou com: ${e.code}`));
const op2 = (await store.tx((tx) => tx.findOperation(o2.id, 'charge')))!;
console.log(`operação: ${op2.status}; cobranças no provedor para ela: ${provider.countFor(op2.id)}`);
await market.pay(o2.id).catch((e) => console.log(`nova tentativa às cegas recusada: ${e.code}`));
offset += 5 * 60_000;
console.log('conciliação:', JSON.stringify(await market.reconcileDue()));
console.log(`cobranças para a operação depois da conciliação: ${provider.countFor(op2.id)}`);

step('3. Cartão recusado escondido atras de um timeout');
const o3 = await market.createOrder({creatorId: 'creator-demo', amountCents: 1500, currency: 'usd', paymentMethod: 'pm_card_declined'});
payTransport.failNext(isCharge, {kind: 'timeout-after'});
await market.pay(o3.id).catch(() => undefined);
offset += 5 * 60_000;
console.log('conciliação:', JSON.stringify(await market.reconcileDue()));

step('4. Pagamento assíncrono concluido por webhook assinado (e reentregue)');
const whSecret = fake('whsec');
const handle = createWebhookProcessor({
  store, provider: 'payments', secrets: () => [whSecret],
  handlers: {'payment_intent.succeeded': (e) => market.paymentEvent(String(e.data.object.id))},
});
const o4 = await market.createOrder({creatorId: 'creator-demo', amountCents: 3000, currency: 'usd', paymentMethod: 'pm_async'});
console.log(`depois do pay(): ${(await market.pay(o4.id)).status}`);
const op4 = (await store.tx((tx) => tx.findOperation(o4.id, 'charge')))!;
const event = provider.settle((await payments.findByOperation(op4.id))!.id);
for (let i = 1; i <= 2; i++) {
  const r = await handle(Buffer.from(event), signStripeStyle(event, whSecret));
  console.log(`entrega ${i}: duplicate=${r.duplicate}`);
}
await handle(Buffer.from(event.replace('3000', '1')), signStripeStyle(event, whSecret)).catch((e) => console.log(`corpo adulterado: ${e.code}`));
console.log(`pedido: ${(await store.tx((tx) => tx.getOrder(o4.id)))!.status}`);

step('5. Reembolso parcial devolve a comissão proporcional');
const r1 = await market.refund(o1.id, 2000);
console.log(`pedido 1: ${r1.status}, reembolsado ${usd(r1.refundedCents)}; plataforma agora ${usd(provider.balance('platform'))}`);

step('6. E-mail pelo outbox (resposta perdida, reenviado com a mesma chave)');
const mailOp = await mailer.enqueue(o1.id, {from: 'loja@example.com', to: 'comprador@example.com', subject: 'Recibo', text: 'Obrigado pela compra.'});
mailTransport.failNext(() => true, {kind: 'timeout-after'});
await mailer.deliver(mailOp.id).catch((e) => console.log(`envio: ${e.code}`));
offset += 60_000;
await mailer.reconcileDue();
console.log(`tentativas: ${mailTransport.calls.length}, mesma chave: ${mailTransport.calls[0]!.headers['idempotency-key'] === mailTransport.calls[1]!.headers['idempotency-key']}`);
console.log(`e-mails enviados: ${mailbox.sent.length}`);

step('7. CSP com nonce por requisição e consentimento');
const server = createWebServer({thirdParty: [{purpose: 'measurement', src: 'https://analytics.example/tag.js'}], secureCookies: false});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const nonceOf = async (cookie?: string) => {
  const res = await fetch(base + '/', {headers: cookie ? {cookie} : {}});
  const csp = res.headers.get('content-security-policy')!;
  const html = await res.text();
  return {nonce: /'nonce-([^']+)'/.exec(csp)![1], tag: html.includes('analytics.example'), cspAllows: csp.includes('analytics.example')};
};
const a = await nonceOf();
const b = await nonceOf();
console.log(`nonce A=${a.nonce} B=${b.nonce} (diferentes: ${a.nonce !== b.nonce})`);
console.log(`sem consentimento: tag=${a.tag}, CSP libera origem=${a.cspAllows}`);
const c = await nonceOf('consent=v1.m1.k0');
console.log(`com consentimento: tag=${c.tag}, CSP libera origem=${c.cspAllows}`);
server.close();

step('Resumo');
const ledger = await store.tx((tx) => tx.ledger());
console.log(`objetos de pagamento no provedor: ${provider.intentCount()} (4 pedidos, nenhuma cobrança duplicada)`);
console.log(`lançamentos no razão: ${ledger.length}; soma ${usd(ledger.reduce((t, e) => t + e.amountCents, 0))}`);
