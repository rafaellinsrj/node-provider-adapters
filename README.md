# node-provider-adapters

Padrões para integrar provedores externos (pagamentos, e-mail, verificação de identidade, redes sociais) em Node.js sem perder dinheiro nem dados quando a rede falha. Tudo roda localmente, com transportes falsos e sem chaves.

Este repositório destila padrões de um produto de comércio para criadores de conteúdo que o autor construiu. O domínio foi trocado por um genérico (criadores, pedidos, repasses), e os valores, percentuais e identificadores são fictícios.

## O problema

Quem cobra em nome de terceiros vive três situações que o caminho feliz ignora:

1. **A chamada ao provedor expira, mas a cobrança aconteceu.** Tentar de novo às cegas cobra duas vezes; desistir deixa o comprador pago e sem pedido.
2. **Webhooks chegam repetidos, fora de ordem ou forjados.** Processar duas vezes duplica lançamentos; confiar no corpo permite marcar como pago o que não foi.
3. **O SDK do provedor se espalha pelo código.** Testar vira depender de rede e chaves, e trocar de provedor vira reescrever regras de negócio.

No navegador, o equivalente é o script de terceiros: com `'unsafe-inline'` ou carregado antes do consentimento, qualquer injeção vira execução e qualquer visita vira rastreamento.

## Como funciona

```mermaid
flowchart LR
  subgraph App["Código de negócio"]
    M["Marketplace<br/>(pedidos, reembolsos)"]
    O["Operations<br/>(outbox + estados)"]
    W["Webhook processor"]
    R["Worker de conciliação"]
  end
  subgraph Adapters["Adaptadores"]
    P["PaymentsAdapter"]
    E["EmailAdapter"]
    K["KycAdapter"]
  end
  subgraph T["Transporte (injetado)"]
    F["fetchTransport<br/>(HTTP real)"]
    FK["fakeTransport<br/>(provedor em memória)"]
    RP["replayTransport<br/>(cassete gravado)"]
  end
  DB[("Store<br/>memória ou PostgreSQL")]

  M -- "1. pedido + intenção<br/>na mesma transação" --> DB
  M -- "2. execute(op)" --> O
  O -- "chave = op.id" --> P
  P --> T
  O -- "timeout ⇒ unknown" --> DB
  R -- "busca pelo op.id" --> P
  R -- "succeeded / failed<br/>ou repete com a mesma chave" --> O
  W -- "assinatura ⇒ relê o objeto ⇒<br/>grava evento + aplica" --> DB
  E --> T
  K --> T
```

Máquina de estados de uma operação com provedor:

```mermaid
stateDiagram-v2
  [*] --> prepared: gravada antes da chamada
  prepared --> running: lease de 1 min
  running --> succeeded: resposta definitiva
  running --> failed: recusa definitiva (ex.: cartão)
  running --> blocked: 4xx inesperado
  running --> unknown: timeout, 5xx, resposta inválida, worker morto
  unknown --> succeeded: conciliação encontrou
  unknown --> failed: conciliação encontrou recusado
  unknown --> prepared: nada no provedor e chave ainda válida
  unknown --> blocked: nada no provedor e janela da chave vencida
```

## Decisões e por quê

| Decisão | Por quê |
| --- | --- |
| **Adaptador por provedor, transporte injetado** (`Transport = (url, init) => Response`). O código de negócio conhece `PaymentsAdapter`, nunca um SDK; o ESLint barra imports de SDKs. | O mesmo código roda com HTTP real, com um provedor falso em memória ou com um cassete gravado. Os testes ficam determinísticos e trocar de provedor fica restrito a um arquivo. |
| **Lista de caminhos permitidos no adaptador.** | Um bug em outra camada não transforma o adaptador num proxy genérico com a chave da plataforma. |
| **Mutação que falha vira `outcome_unknown`; leitura que falha vira `unavailable`.** | Timeout numa escrita não diz se ela aconteceu. Tratar como falha leva a cobrar duas vezes; tratar como sucesso leva a entregar sem receber. |
| **Intenção gravada antes da chamada, na mesma transação do pedido** (outbox). O `id` da operação é a chave de idempotência. | Não existe pedido sem intenção, nem chamada sem registro. Repetir a mesma operação reaproveita a mesma chave, e o provedor deduplica. |
| **`unknown` não aceita nova tentativa direta: exige conciliação.** O worker pergunta ao provedor pelo nosso `operation_id` (gravado em metadata). | Consultar é barato e responde a pergunta certa. Se o objeto existe, registra; se foi recusado, marca falha; só se não existe é que repete, e com a mesma chave. |
| **Janela de 23 h para repetir; depois disso, `blocked`.** | Provedores descartam chaves de idempotência por volta de 24 h. Passado isso, repetir pode executar duas vezes, então a decisão fica com uma pessoa. |
| **Lease com expiração em `running`.** Worker que morre no meio da chamada é tratado como timeout. | Sem lease, uma operação ficaria presa para sempre; com lease curto, duas execuções concorrentes não acontecem. |
| **Digest da configuração na operação.** | Se a conta ou a chave do provedor mudar, as chaves antigas não significam nada na conta nova: a operação para em vez de repetir. |
| **Comissão dentro do mesmo pagamento** (destination charge + `application_fee_amount`). | Não existe uma segunda cobrança da comissão que possa falhar depois da venda. Reembolsos devolvem a taxa proporcionalmente, calculada sobre o acumulado para não haver deriva de centavos. |
| **Dinheiro em inteiros (centavos) e taxas em basis points.** | Sem ponto flutuante em valores; arredondamento explícito e testado. |
| **Webhook: assinatura sobre os bytes crus, timestamp assinado, várias chaves aceitas durante a rotação.** | Verificar antes de qualquer parse; o timestamp assinado dá sentido à janela de 5 min; a rotação não derruba entregas. |
| **Webhook: o corpo é só uma dica.** O processador relê o objeto no provedor e grava o `event_id` na mesma transação que aplica a mudança. | Um evento bem assinado mas precoce ou forjado não marca pedido como pago. Entregas repetidas ou concorrentes viram no-op, e "evento registrado" nunca diverge de "evento aplicado". |
| **Transições só a partir de `pending`, e sucesso nunca é rebaixado.** | Resposta síncrona, webhook e conciliação podem chegar em qualquer ordem e convergem no mesmo estado. |
| **CSP com nonce novo por resposta, sem `'unsafe-inline'`, sem `'strict-dynamic'`, com `no-store`.** | Script injetado não executa. Sem `strict-dynamic`, um script de terceiros aceito não pode carregar outros hosts. HTML com nonce não pode ser servido de cache para outra pessoa. |
| **Consentimento lido no servidor (cookie primário).** Sem consentimento, a tag não está no HTML e a origem não está na CSP. | Duas travas independentes: mesmo que um bug inclua a tag, o navegador bloqueia. |
| **Adaptador de KYC devolve só um resultado grosseiro** (`approved`, `declined`, ...). | O payload de decisão de um provedor de identidade traz documentos e dados pessoais; a plataforma não precisa guardá-los. |
| **Kill switch por provedor, consultado em toda chamada, inclusive leituras de conciliação.** | Em incidente, para tudo sem deploy. Uma pausa detectada depois do claim desfaz a tentativa e mantém a chave. |

## Como rodar

Requer Node 24 (ou 22.18+), que executa TypeScript diretamente (type stripping). Não há etapa de build.

```bash
npm install
npm run demo        # tour de ponta a ponta com transportes falsos, sem chaves
npm test            # node:test
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
```

O teste do store PostgreSQL roda quando `DATABASE_URL` aponta para um banco descartável (ele cria e apaga o próprio schema). O CI sobe um `postgres:18`:

```bash
DATABASE_URL=postgres://postgres:senha@127.0.0.1:5432/postgres npm test
```

### O que os testes cobrem

- Troca de transporte: o mesmo adaptador com o falso em memória, com `fetch` real contra um servidor HTTP local e com um cassete gravado (sem a chave no arquivo).
- Reuso de chave de idempotência: preparar duas vezes, pagar duas vezes, `pay()` concorrente, mesma chave com corpo diferente, troca de conta.
- Timeout depois da cobrança ⇒ `unknown` ⇒ conciliação ⇒ pago, com uma cobrança só; timeout antes ⇒ repetição com a mesma chave; recusa atrás de timeout ⇒ `failed`; janela vencida ⇒ `blocked`; worker morto ⇒ conciliado.
- Webhook: assinatura válida, corpo adulterado, assinatura adulterada, expirada, do futuro, rotação de segredo nos dois lados; reentrega e entregas concorrentes sem efeito; corpo forjado não marca pagamento.
- CSP: nonce diferente a cada requisição, todo `<script>` com o nonce da resposta, script inline sem nonce (ou com nonce antigo) bloqueado pela política.
- Consentimento: sem escolha, recusa e versão antiga não carregam nada; aceitação libera a tag e a origem na CSP.

## Estrutura

```
src/
  errors.ts                 códigos estáveis; UNCERTAIN = "não sabemos o que aconteceu"
  transport/                http.ts (fetch real) · fake.ts (falhas injetáveis) · recorded.ts (gravar/reproduzir)
  providers/                payments.ts · email.ts · kyc.ts · social.ts · registry.ts · http-json.ts
  fakes/                    provedores em memória que honram chaves de idempotência e mantêm saldos
  operations/               operations.ts (outbox, lease, conciliação) · outbox.ts (e-mail)
  marketplace/              split.ts (comissão, taxas, reembolso proporcional) · orders.ts
  webhooks/                 signature.ts (HMAC estilo Stripe e hex) · processor.ts (deduplicação atômica)
  web/                      csp.ts · consent.ts · server.ts (node:http)
  store/                    types.ts · memory.ts · postgres.ts
migrations/001_init.sql     schema do store PostgreSQL
examples/demo.ts            tour de ponta a ponta
test/                       node:test
```

### Next.js

O `server.ts` usa `node:http` para não prender o núcleo a um framework. Num app Next.js (16+, `proxy.ts`), a mesma ideia fica assim:

```ts
import {NextResponse, type NextRequest} from 'next/server';
import {contentSecurityPolicy, newNonce} from './src/web/csp';
import {allowedScripts, parseConsent} from './src/web/consent';

export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const scripts = allowedScripts(parseConsent(request.headers.get('cookie')), THIRD_PARTY);
  const origins = scripts.map((s) => new URL(s.src).origin);
  const csp = contentSecurityPolicy(nonce, {scriptOrigins: origins, connectOrigins: origins});
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce); // lido no layout com headers() e passado aos <Script nonce>
  const response = NextResponse.next({request: {headers}});
  response.headers.set('content-security-policy', csp);
  return response;
}
```

## Limites

- Os adaptadores seguem o formato público das APIs (Stripe, Resend, provedores de KYC com sessão hospedada, Graph APIs), mas cobrem só o subconjunto usado aqui. Antes de produção, confira caminhos, versões e status com a conta real.
- O store em memória serializa todas as transações; serve para testes e demonstração, não para carga.
- Isolamento por tenant (RLS) e criptografia de colunas ficaram de fora para manter o foco.

## Autor

Rafael Lins Gaspar · [rafaellinsrj.github.io](https://rafaellinsrj.github.io) · [linspartners.com](https://linspartners.com)

Licença MIT.

---

## English

**node-provider-adapters** distills patterns from a creator-commerce product the author built, rewritten for a generic domain (creators, orders, payouts) with fictional numbers.

**Problem.** Calls to payment, e-mail, KYC and social providers fail in ambiguous ways: a timeout after the charge went through, duplicated or forged webhooks, SDKs leaking into business code. On the browser side, inline scripts and third-party tags loaded before consent.

**Patterns.**

- *Adapters with an injected transport.* Business code depends on `PaymentsAdapter`/`EmailAdapter`/`KycAdapter`; the transport is real `fetch`, an in-memory fake with fault injection, or a recorded cassette.
- *Uncertain operations.* An intent row is written in the same transaction as the order, before the call; its id is the idempotency key. A failed mutation becomes `unknown`, which cannot be retried blindly: a reconciliation worker looks the object up at the provider by our operation id and resolves to `succeeded`/`failed`, or retries with the *same* key while the provider still honours it (23 h), otherwise blocks for human review. Leases cover crashed workers; a config digest stops replays against a different account.
- *Commission inside the payment.* Destination charge with an application fee: one charge, seller gets the net, platform keeps the fee; refunds return the fee proportionally from cumulative totals (no cent drift). Integer cents, basis points.
- *Webhooks.* Stripe-style HMAC over the raw bytes with a signed timestamp, 5-minute tolerance, multiple secrets during rotation. The payload is only a hint: the object is re-read from the provider, and the event id is recorded in the same transaction that applies the change, so replays and concurrent deliveries are no-ops.
- *Strict CSP and consent.* Fresh nonce per response, no `'unsafe-inline'`/`'strict-dynamic'`, `no-store`. Consent lives in a first-party cookie read by the server: without it, the tag is neither in the HTML nor allowed by the CSP.

**Run.** Node 24 (or 22.18+) runs the TypeScript directly: `npm install && npm run demo && npm test`. Set `DATABASE_URL` to also test the PostgreSQL store (`migrations/001_init.sql`). CI runs lint, typecheck, tests and the demo on Node 22 and 24 with a PostgreSQL 18 service.

**Author.** Rafael Lins Gaspar · [rafaellinsrj.github.io](https://rafaellinsrj.github.io) · [linspartners.com](https://linspartners.com) · MIT License.
