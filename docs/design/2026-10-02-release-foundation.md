# Base de releases (v0.1.0) — design

- Data: 2026-10-02
- Tarefa: [PayWings v0.1.0 — Base de releases (semver)](https://app.clickup.com/t/17tq1adzfxm)
- Status: aprovado em conversa; aguardando revisão desta spec

## Objetivo

Toda versão do PayWings deve sair com número semver, changelog e pacote instalável por `npm i -g paywings` ou `npx paywings`, sem passos manuais além do merge do PR de release.

## Problema descoberto

O Node se recusa a remover tipos de arquivos `.ts` dentro de `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`; verificado no Node 22.23). O pacote atual roda `src/*.ts` direto, então quebraria ao ser instalado pelo npm. A v0.1.0 precisa publicar JavaScript compilado.

## Fora do escopo

Modo servidor, Docker, binários standalone e painel web (v0.2.0 e v0.3.0).

## 1. Empacotamento

- `tsconfig.build.json` estende o `tsconfig.json` e emite `src/` para `dist/`:
  - `noEmit: false`, `outDir: dist`, `rootDir: src`;
  - `rewriteRelativeImportExtensions: true` (converte `./x.ts` em `./x.js`);
  - inclui só `src` (testes não são compilados).
- O `tsconfig.json` atual continua para o typecheck de `src` e `test`.
- O desenvolvimento continua rodando `src/*.ts` direto (`npm run paywings`, `npm test`).
- `bin/paywings.js`:
  - shebang `#!/usr/bin/env node`, sem `-S`, porque os atalhos do npm no Windows ignoram flags no shebang;
  - antes de importar a CLI, filtra só o `ExperimentalWarning` do SQLite; os demais avisos continuam aparecendo;
  - importa `../dist/cli.js` com import dinâmico, depois do filtro.
- `package.json`:
  - remove `private`;
  - `files`: `["bin", "dist", "LICENSE", "README.md", "README.pt-BR.md"]`;
  - `publishConfig`: `{ "access": "public" }` (a proveniência é automática no trusted publishing);
  - scripts `build` (`tsc -p tsconfig.build.json`) e `prepack` (`npm run build`);
  - `engines.node`: `>=22.18` (mínimo para remover tipos sem flag no desenvolvimento e para `node:sqlite` sem flag);
  - `version`: `0.0.0`, que o release-please muda para `0.1.0`.
- `dist/` entra no `.gitignore`.
- `paywings --version` e `-v` leem a versão do `package.json` do próprio pacote (resolvido a partir de `import.meta.url`), funcionando tanto de `src/` quanto de `dist/`.

## 2. CI — `.github/workflows/ci.yml`

Gatilhos: `pull_request` e `push` na `main`.

| Job | O que faz |
| --- | --- |
| `test` (matriz Node 22 e 24) | `npm ci`, `npm run typecheck`, `npm test` |
| `package` (Node 22) | `npm pack`; instala o tarball com `npm install -g --prefix <tmp>`; roda `paywings --version` (deve ser igual ao `package.json`), `--help`, `init` e um `pay` de cartão com `PAYWINGS_DB` temporário; falha se qualquer comando sair com código diferente de zero ou se aparecer o aviso experimental na saída de erro |
| `pr-title` (só em PR) | valida o título do PR como Conventional Commit (`amannn/action-semantic-pull-request`), porque o merge é squash e o título vira a mensagem do commit |

## 3. Releases — `.github/workflows/release.yml`

Gatilho: `push` na `main`.

1. **Job `release-please`** (`googleapis/release-please-action@v4`):
   - configuração em `release-please-config.json`: `release-type: node`, `bump-minor-pre-major: true`, `include-component-in-tag: false` (tags `vX.Y.Z`);
   - versão atual em `.release-please-manifest.json`: `{ ".": "0.0.0" }`;
   - gera `CHANGELOG.md` com as seções Features, Bug Fixes e Security (`sec:` mapeado para Security);
   - saídas: `release_created`, `tag_name`.
2. **Job `publish-npm`** (só se `release_created`):
   - `permissions: id-token: write, contents: read`;
   - Node 24, `npm install -g npm@latest` (trusted publishing exige npm 11.5.1 ou mais novo);
   - `npm ci`, `npm test`, `npm publish`; o `prepack` compila.

Regras de versão na fase `0.x`:

| Commit | Bump |
| --- | --- |
| `fix:`, `sec:` | patch (`0.1.0` → `0.1.1`) |
| `feat:` | minor (`0.1.0` → `0.2.0`) |
| `feat!:` ou `BREAKING CHANGE:` | minor enquanto `0.x`; major a partir de `1.0.0` |
| `chore:`, `docs:`, `test:`, `ci:` | nenhum release |

### Primeira publicação (manual, uma única vez)

O npm só permite configurar o trusted publishing num pacote que já existe.

1. Merge do PR de release `0.1.0`. O job `publish-npm` falha por falta de credencial, e isso é esperado.
2. O dono faz checkout da tag `v0.1.0` e roda `npm publish` localmente.
3. O dono configura o trusted publisher no npmjs.com:
   - repositório `diego-maeda/paywings`;
   - workflow `release.yml`;
   - sem environment.
4. Da `0.1.1` em diante, a publicação é automática.

Alternativa descartada: guardar um token npm como secret só para a primeira publicação. Deixaria uma credencial de longa duração no repositório.

## 4. Documentação

- `docs/VERSIONING.md`:
  - **API pública (coberta pelo semver):**
    - comandos, flags e códigos de saída da CLI;
    - o JSON impresso por `pay` e `status`;
    - nomes, parâmetros e formato de resposta das ferramentas MCP;
    - códigos de motivo (`MERCHANT_NOT_ALLOWED` etc.);
    - variáveis de ambiente (`PAYWINGS_DB`, `PAYWINGS_AGENT_KEY`);
    - prefixo das chaves;
    - compatibilidade do arquivo de banco: uma versão nova abre o banco da anterior.
  - **Não é API pública:** módulos internos em `src/`, o texto das mensagens para humanos e o formato da tabela de `payments`.
  - **Regras da fase `0.x`:** uma minor pode quebrar compatibilidade, e isso é anunciado no CHANGELOG; uma patch nunca quebra.
  - **A partir da `1.0.0`:** uma quebra exige major, e o que for depreciado continua funcionando por pelo menos uma minor.
- `CONTRIBUTING.md`: setup, `npm test`, padrão de commits com exemplos, títulos de PR, como um release acontece.
- README (en e pt-BR): instalação via `npm i -g paywings` e `npx paywings`, além de um link para `VERSIONING.md`.

## 5. Testes

- **Unitário:** `--version` imprime a versão do `package.json`. Testado chamando a CLI como subprocesso a partir de `src/`.
- **Pacote:** o job `package` do CI cobre o pacote instalado de verdade, incluindo o problema com `node_modules`.
- **Local, antes de abrir o PR:** rodar a mesma sequência do job `package` numa pasta temporária.

## 6. Entrega

- Branch `chore/release-foundation` e PR para a `main`, com título `chore: release foundation`.
- O PR não gera release sozinho. Mesmo assim, o primeiro PR de release vai propor `0.1.0`, porque o histórico já tem um commit `feat:`.

## Riscos

| Risco | Mitigação |
| --- | --- |
| O TypeScript 7 (nativo) não suportar alguma opção de emissão | Validar `npm run build` no começo da implementação; se falhar, fixar o TypeScript 5.9 só para o build |
| `node:sqlite` mudar de API (continua experimental no Node 22) | `engines` com mínimo explícito; a matriz de CI inclui Node 24 |
| Ações do GitHub mudarem de versão | Fixar as versões maiores (`@v4`) e revisar a cada release |
| O release-please não gerar patch para o tipo `sec:` (não é um tipo padrão) | Verificar na implementação com um PR de release de teste; se não gerar, documentar `fix(security):` como padrão para correções de segurança |
