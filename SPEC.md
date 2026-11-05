# PayWings — especificação técnica do MVP

> Versão 0.1 — 2026-10-02.

PayWings dá a agentes de IA uma forma de pagar (via MCP, CLI, SDK ou API) **dentro de regras definidas por um humano**, sem que o agente veja credenciais financeiras reais e com prova verificável de cada decisão.

## 1. Princípios

1. **A política vive no servidor, nunca no agente.** Injeção de prompt pode convencer um agente de qualquer coisa; não pode mudar uma regra que o agente não controla.
2. **O agente pede, o servidor decide.** Toda compra é um `PaymentIntent` avaliado por um motor de políticas determinístico. O agente não tem ferramenta para aprovar, alterar limites ou recarregar saldo.
3. **Confiar no dado, não na alegação.** Quando o trilho permite, o recebedor é extraído do próprio instrumento (ex.: o BR Code do Pix), não do texto que o agente informa.
4. **Exposição mínima.** Cartões são de uso único, travados em lojista e valor, com validade curta.
5. **Tudo auditável.** Log append-only encadeado por hash: intenção → decisão → aprovação → execução.
6. **Idempotência obrigatória.** Agentes repetem chamadas; a mesma `idempotency_key` nunca gera dois pagamentos.

## 2. Atores

| Ator | Pode | Não pode |
| --- | --- | --- |
| Dono (humano, com KYC) | Criar agentes, definir políticas, recarregar, aprovar/rejeitar, congelar | — |
| Agente (credencial própria) | Consultar carteira, solicitar pagamento, consultar status | Aprovar, mudar política, recarregar, ver PAN fora do cartão de uso único |
| Lojista / recebedor | Receber via cartão ou Pix | — |

## 3. Modelo de domínio

Valores monetários sempre em **centavos inteiros**; moeda do MVP: **BRL**.

- **Agent**: `id`, `name`, `status` (`active` | `frozen`), `key_hash`, `wallet_id`.
- **Wallet**: `id`, `balance_cents`.
- **Policy** (1 por agente):
  - `max_per_tx_cents` — teto por transação
  - `monthly_limit_cents` — teto no mês corrente (conta pendentes + executados)
  - `approval_above_cents` — acima disso, exige aprovação humana
  - `max_tx_per_hour` — limite de velocidade
  - `allowed_rails` — `card`, `pix`
  - `allowed_merchants` — domínios ou chaves Pix; vazio = qualquer
  - `blocked_categories` — ex.: `gambling`, `crypto`, `gift_cards`
- **PaymentIntent**: `id`, `agent_id`, `amount_cents`, `rail`, `merchant` (`name`, `domain?`, `pix_key?`), `category`, `justification`, `idempotency_key`, `status`, `reasons[]`, `created_at`, `expires_at`, `execution?`.
- **AuditEntry**: `seq`, `at`, `actor`, `event`, `data`, `prev_hash`, `hash` (SHA-256 de `prev_hash` + conteúdo).

### Estados do PaymentIntent

```
            ┌──────────► denied            (política recusou)
request ────┼──────────► executed          (aprovado automaticamente e executado)
            └──► pending_approval ──┬──► executed  (humano aprovou)
                                    ├──► rejected  (humano recusou)
                                    └──► expired   (24 h sem resposta)
```

## 4. Motor de políticas

Função pura `evaluate(intent, agent, policy, context) → { outcome, reasons }`. Ordem de checagem (a primeira falha bloqueante encerra, mas todas as falhas são reportadas):

1. Agente `active` (kill switch).
2. Valor > 0 e moeda suportada.
3. Trilho permitido.
4. Para Pix: BR Code válido (CRC16) e valor do código igual ao valor pedido, quando presente.
5. Recebedor na lista permitida — para Pix, comparado com a **chave extraída do BR Code**.
6. Categoria não bloqueada.
7. `amount ≤ max_per_tx`.
8. `gasto_mês + pendentes + amount ≤ monthly_limit` (mês no fuso `America/Sao_Paulo` por padrão).
9. Transações na última hora < `max_tx_per_hour`.
10. Saldo suficiente.
11. `amount > approval_above` → `pending_approval`; senão → `approved` (executa na hora). Pix com BR Code dinâmico vai sempre para aprovação (`PAYEE_UNVERIFIED`): o código só identifica o PSP, não o recebedor final.

Os motivos retornam com código estável (ex.: `MERCHANT_NOT_ALLOWED`) para o agente explicar ao usuário ou ajustar o pedido.

## 5. Trilhos

| Trilho | MVP (sandbox) | Produção |
| --- | --- | --- |
| Cartão virtual | Cartão de teste de uso único, travado em lojista e valor, expira em 30 min | Emissor BaaS (ex.: Dock, Pismo, Lithic). Preferir tokens delegados (ACP Shared Payment Token, tokens agênticos Visa/Mastercard) quando o lojista aceitar |
| Pix | Liquidação simulada com `end_to_end_id` | Iniciador de pagamento (ITP) parceiro via Open Finance/JSR, com o pagamento saindo da conta do próprio dono. Evita guardar saldo e a exigência de capital de IP |
| x402 / stablecoin | Fora do MVP | Fase 3 para micropagamentos máquina-a-máquina |

O saldo é debitado na execução (emissão do cartão ou liquidação Pix). Na produção, o saldo não utilizado de um cartão volta para a carteira quando ele expira.

## 6. Interfaces

### 6.1 Ferramentas MCP (expostas ao agente)

| Ferramenta | Entrada | Saída |
| --- | --- | --- |
| `get_wallet` | — | saldo, limites, gasto no mês, pendentes |
| `request_payment` | `amount`, `rail`, `merchant_name`, `merchant_domain?`, `pix_code?`, `category`, `justification`, `idempotency_key` | `PaymentIntent` com `status`, `reasons`, e `execution` (cartão ou comprovante Pix) quando executado |
| `get_payment` | `payment_id` | `PaymentIntent` atual (o agente consulta após `pending_approval`) |
| `list_payments` | `limit?` | últimos pagamentos do agente |

Intencionalmente **ausentes**: aprovar, rejeitar, recarregar, alterar política, congelar.

### 6.2 CLI

```
paywings init                                   # cria sandbox local com agente demo
paywings agents create <nome> [limites...]      # dono
paywings agents freeze|unfreeze <nome>          # dono (kill switch)
paywings topup <agente> <valor>                 # dono
paywings pay --amount ... --rail card|pix ...   # agente (PAYWINGS_AGENT_KEY)
paywings pending | approve <id> | reject <id>   # dono — approve/reject pedem a chave de dono; approve exige terminal interativo
paywings owner setup                            # cria a chave de dono em sandbox antigo
paywings payments [--agent <nome>]
paywings audit verify                           # valida a cadeia de hashes
paywings mcp                                    # sobe o servidor MCP (stdio)
```

### 6.3 API REST (produção, fase 2)

`POST /v1/payment_intents` (header `Idempotency-Key`), `GET /v1/payment_intents/:id`, `GET /v1/wallet`, webhooks `payment_intent.executed|rejected|expired`. Autenticação: chave por agente (escopo agente) e sessão do dono (escopo dono) — **nunca a mesma credencial**.

## 7. Aprovação humana

- MVP: comandos de dono que mexem em dinheiro ou limites pedem a **chave de dono** (`pw_owner_…`, só o hash fica no banco), que o agente nunca recebe. `approve` também exige TTY e confirmação digitada do valor, como defesa extra: um TTY pode ser simulado (`script`, `expect`), a chave não. Congelar não pede chave.
- Produção: aprovação **fora de banda** no dispositivo do dono (WhatsApp, push ou app), com assinatura do mandato (passkey/WebAuthn). A credencial do agente não tem escopo de aprovação.

## 8. Ameaças e mitigações

| Ameaça | Mitigação |
| --- | --- |
| Injeção de prompt manda pagar terceiro | Lista de recebedores + recebedor extraído do instrumento + aprovação acima do limite |
| Agente aprova a si mesmo | Ferramenta inexistente no MCP; escopos separados; aprovação fora de banda |
| Loop de agente gera dezenas de compras | `max_tx_per_hour`, limite mensal contando pendentes, idempotência |
| Vazamento de cartão | Uso único, trava de lojista e valor, validade de 30 min |
| Repúdio ("não fui eu") | Log encadeado por hash com justificativa do agente e decisão |
| Corrida entre processos | Avaliação + reserva em uma única transação SQLite (`BEGIN IMMEDIATE`) |
| Agente declara categoria falsa | No MVP a categoria é declarada; em produção o cartão é travado por MCC no emissor e a categoria declarada vira só contexto |

## 9. Fora do escopo do MVP

Multi-moeda e câmbio, reembolsos e disputas, x402, webhooks, painel web, multiusuário por empresa, KYC real.

## 10. Roadmap

1. **Fase 1 — sandbox (este protótipo):** MCP + CLI, políticas, Pix e cartão simulados, auditoria. Meta: 10 desenvolvedores usando com seus agentes.
2. **Fase 2 — dinheiro real em pequeno volume:** cartão via emissor BaaS ou Stripe Issuing/Link, Pix via ITP parceiro, API REST, aprovação por WhatsApp, painel web, KYC do dono, conciliação com ERP (Omie, Conta Azul, Bling).
3. **Fase 3 — expansão:** tokens agênticos das bandeiras, ACP/AP2, x402, câmbio, contas empresariais com conciliação contábil.

## 11. Questões em aberto

- Responsabilidade contratual quando o agente compra errado dentro da política: dono, plataforma ou lojista?
- Licença própria (Instituição de Pagamento ou ITP) versus operar sobre BaaS — depende do volume e das regras do BACEN.
- Prioridade de trilho na fase 2: Pix (diferencial local) ou cartão (cobertura global)?
