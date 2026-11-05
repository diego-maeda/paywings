# PayWings (sandbox)

[Read in English](README.md)

Este protótipo deixa agentes de IA pagarem, via MCP ou terminal, apenas dentro das regras definidas pelo dono. É um sandbox: nenhum dinheiro real é movimentado, os cartões usam o BIN de teste 411111 e o Pix é simulado.

A especificação está em [SPEC.md](SPEC.md).

## Requisitos

Node 22.18 ou mais novo. Os arquivos TypeScript rodam direto, sem etapa de build.

## Começando

```bash
npm install
npm link            # disponibiliza o comando `paywings`
paywings init        # cria ~/.paywings/sandbox.db com o agente "demo" e R$ 500,00
```

O comando `init` imprime a chave do agente e o comando pronto para registrar o MCP no Claude Code:

```bash
claude mcp add paywings --env PAYWINGS_AGENT_KEY=pw_test_... --env PAYWINGS_DB=~/.paywings/sandbox.db -- paywings mcp
```

Depois disso, basta pedir ao agente algo como "assine o plano Pro da Vercel". Ele chama `request_payment` e recebe uma destas respostas:

- um cartão de uso único, travado no lojista e no valor;
- `pending_approval`, quando a compra precisa da sua aprovação;
- a recusa, com os motivos.

Usa Claude Desktop ou Cursor? Veja [docs/mcp-clients.md](docs/mcp-clients.md) (em inglês).

## Como dono

```bash
paywings agents create pesquisa --balance 300 --per-tx 100 --monthly 500 --approve-above 30 --merchants vercel.com,openai.com
paywings pending
paywings approve pay_...        # exige terminal interativo e que você digite o valor
paywings agents freeze pesquisa # kill switch
paywings audit verify           # confere a cadeia de hashes do log
```

## Como agente, pelo terminal

```bash
export PAYWINGS_AGENT_KEY=pw_test_...
paywings pay --amount 19,90 --rail card --merchant Vercel --domain vercel.com --category software --reason "upgrade pedido pelo usuário"
paywings pay --amount 35,90 --rail pix --merchant "Loja" --pix "$(paywings pix-code --key loja@exemplo.com --name Loja --city 'Sao Paulo' --amount 35,90)" --category office --reason "..."
paywings status pay_...
```

## Segurança

O banco do sandbox é um arquivo local que o usuário do sistema do agente consegue editar. O [SECURITY.md](SECURITY.md) explica o que está e o que não está protegido e como reportar uma vulnerabilidade.

## Testes

```bash
npm test
npm run typecheck
```

## Estrutura

| Arquivo | Papel |
| --- | --- |
| `src/policy.ts` | Motor de políticas, uma função pura |
| `src/service.ts` | Carteiras, pagamentos, aprovação, idempotência e auditoria, tudo em SQLite |
| `src/brcode.ts` | Parser e gerador de BR Code Pix, com validação de CRC16 |
| `src/rails/sandbox.ts` | Trilhos simulados; adaptadores de produção implementam a mesma interface `Rails` |
| `src/mcp.ts` | Servidor MCP com as ferramentas do agente |
| `src/cli.ts` | CLI do dono e do agente |
