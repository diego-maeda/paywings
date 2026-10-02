# Base de releases (v0.1.0) — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publicar o PayWings como pacote npm instalável, com versão semver, changelog e CI, gerados automaticamente a partir de Conventional Commits.

**Architecture:** O `tsc` compila `src/` para `dist/` (o Node não remove tipos dentro de `node_modules`). O `bin/` filtra o aviso experimental do SQLite e carrega `dist/cli.js`. O GitHub Actions roda os testes e um smoke test do tarball. O release-please mantém o PR de release e publica no npm via OIDC.

**Tech Stack:** Node 22.18+ (`node:test`, `node:sqlite`), TypeScript 7 (`tsc`), GitHub Actions, release-please v4, npm trusted publishing.

**Spec:** `docs/design/2026-10-02-release-foundation.md`

## Global Constraints

- `engines.node`: `>=22.18`.
- Tags no formato `vX.Y.Z`; a versão inicial no manifesto é `0.0.0`; o primeiro release é `0.1.0`.
- `bump-minor-pre-major: true`: uma quebra de compatibilidade sobe a minor enquanto estivermos em `0.x`.
- Nenhuma dependência de runtime nova. Nenhum secret de npm no repositório.
- Comentários de código em inglês, só onde o código não é óbvio.
- Commits em Conventional Commits, sem linhas de atribuição.
- Sem novas dependências de desenvolvimento; validação de YAML local usa `ruby -ryaml` (já presente no macOS).

---

### Task 1: Build para `dist/`, bin portável e `--version`

**Files:**
- Create: `tsconfig.build.json`
- Create: `src/version.ts`
- Create: `test/cli.test.ts`
- Modify: `src/cli.ts` (HELP e início de `main()`)
- Modify: `bin/paywings.js` (reescrito)
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `export const VERSION: string` em `src/version.ts`; script `npm run build` gera `dist/cli.js`; `paywings --version` e `-v` imprimem `VERSION`.

- [ ] **Step 1: Escrever o teste que falha**

`test/cli.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const run = (...args: string[]) =>
  execFileSync(process.execPath, ['--no-warnings', 'src/cli.ts', ...args], { encoding: 'utf8' }).trim();

test('--version prints the package version', () => {
  assert.equal(run('--version'), pkg.version);
  assert.equal(run('-v'), pkg.version);
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `node --no-warnings --test test/cli.test.ts`
Expected: FAIL. `--version` não é uma opção conhecida e o `parseArgs` estrito lança `ERR_PARSE_ARGS_UNKNOWN_OPTION`.

- [ ] **Step 3: Implementar `src/version.ts`**

```ts
import { readFileSync } from 'node:fs';

// Resolves to the package root from both src/ (development) and dist/ (published package).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const VERSION = pkg.version;
```

- [ ] **Step 4: Ligar a flag em `src/cli.ts`**

Adicionar o import junto aos demais:

```ts
import { VERSION } from './version.ts';
```

Em `parseArgs`, adicionar ao lado de `help`:

```ts
    version: { type: 'boolean', short: 'v' },
```

No começo de `main()`, antes do `if (!cmd || flags.help)`:

```ts
  if (flags.version) {
    console.log(VERSION);
    return;
  }
```

No texto `HELP`, trocar a primeira linha por:

```ts
const HELP = `paywings ${VERSION} — sandbox de pagamentos com políticas para agentes de IA
```

e adicionar ao fim da seção "Utilitários":

```
  --version, -v                         Mostra a versão
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `node --no-warnings --test test/cli.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Criar `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "rewriteRelativeImportExtensions": true
  },
  "include": ["src"]
}
```

- [ ] **Step 7: Reescrever `bin/paywings.js`**

```js
#!/usr/bin/env node
// node:sqlite is still experimental on Node 22. Hide only that warning; shebang flags
// such as --no-warnings are ignored by npm's Windows shims, so filter it here instead.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
  return emitWarning.call(process, warning, ...rest);
};

await import('../dist/cli.js');
```

- [ ] **Step 8: Atualizar `package.json`**

Aplicar estas mudanças (as demais chaves ficam como estão):

```json
{
  "version": "0.0.0",
  "files": ["bin", "dist", "LICENSE", "README.md", "README.pt-BR.md"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepack": "npm run build",
    "test": "node --no-warnings --test \"test/*.test.ts\"",
    "typecheck": "tsc",
    "paywings": "node --no-warnings src/cli.ts"
  }
}
```

Remover a chave `"private": true`. `engines` continua `{ "node": ">=22.18" }`.

- [ ] **Step 9: Ignorar `dist/`**

Adicionar ao `.gitignore`:

```
dist/
```

- [ ] **Step 10: Compilar e rodar o binário compilado**

Run: `npm run build && node bin/paywings.js --version && PAYWINGS_DB="$(mktemp -d)/t.db" node bin/paywings.js init 2>&1 | grep -c ExperimentalWarning`
Expected: imprime `0.0.0` e depois `0`, ou seja, nenhum aviso experimental. Se aparecer `1`, o aviso não passa por `process.emitWarning`. Nesse caso, trocar o filtro por um listener: `process.removeAllListeners('warning')` mais um `process.on('warning', ...)` que reimprime todo aviso que não for do SQLite.

- [ ] **Step 11: Rodar a suíte inteira e o typecheck**

Run: `npm run typecheck && npm test`
Expected: tsc sem erros; `# pass 34`, `# fail 0`.

- [ ] **Step 12: Commit**

```bash
git add tsconfig.build.json src/version.ts src/cli.ts test/cli.test.ts bin/paywings.js package.json .gitignore
git commit -m "feat: ship compiled build and add --version"
```

---

### Task 2: Smoke test do pacote

**Files:**
- Create: `scripts/smoke-package.sh`
- Modify: `package.json` (script `smoke:package`)

**Interfaces:**
- Consumes: `npm run build` via `prepack` e `paywings --version` (Task 1).
- Produces: `npm run smoke:package`, que sai com código 0 se o tarball instalado funciona. Usado pelo CI na Task 3.

- [ ] **Step 1: Escrever o script**

`scripts/smoke-package.sh`:

```bash
#!/usr/bin/env bash
# Packs the project, installs the tarball the way a user would, and exercises the CLI.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$root"

tarball="$(npm pack --silent --pack-destination "$work" | tail -1)"
npm install --global --silent --prefix "$work/prefix" "$work/$tarball"
bin="$work/prefix/bin/paywings"
errors="$work/stderr"
export PAYWINGS_DB="$work/sandbox.db"

expected="$(node -p "require('./package.json').version")"
actual="$("$bin" --version 2>>"$errors")"
if [ "$actual" != "$expected" ]; then
  echo "version mismatch: got '$actual', expected '$expected'" >&2
  exit 1
fi

"$bin" --help >/dev/null 2>>"$errors"
init_output="$("$bin" init 2>>"$errors")"
PAYWINGS_AGENT_KEY="$(printf '%s\n' "$init_output" | grep -o 'pw_test_[A-Za-z0-9_-]*' | head -1)"
export PAYWINGS_AGENT_KEY

"$bin" pay --amount 9.90 --rail card --merchant Vercel --domain vercel.com \
  --category software --reason "package smoke test" 2>>"$errors" | grep -q '"status": "executed"'

if grep -q 'ExperimentalWarning' "$errors"; then
  cat "$errors" >&2
  echo "unexpected experimental warning on stderr" >&2
  exit 1
fi

echo "package smoke test passed (paywings $expected)"
```

- [ ] **Step 2: Tornar executável e adicionar o script npm**

Run: `chmod +x scripts/smoke-package.sh`

Em `package.json` → `scripts`:

```json
    "smoke:package": "scripts/smoke-package.sh"
```

- [ ] **Step 3: Rodar**

Run: `npm run smoke:package`
Expected: última linha `package smoke test passed (paywings 0.0.0)`.

- [ ] **Step 4: Confirmar que o script detecta o problema real**

Run: `git show 902ebd2:bin/paywings.js > bin/paywings.js; npm run smoke:package; echo "exit=$?"; git checkout -- bin/paywings.js`

O commit `902ebd2` tem o `bin` antigo, que importa `../src/cli.ts`; `src/` não está em `files`, então o pacote instalado não o encontra.

Expected: falha com `ERR_MODULE_NOT_FOUND` e `exit=1`. O `git checkout` restaura o `bin` novo.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-package.sh package.json
git commit -m "test: add package smoke test"
```

---

### Task 3: Workflow de CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm run typecheck`, `npm test`, `npm run smoke:package`.

- [ ] **Step 1: Conferir as versões maiores atuais das actions**

Run:

```bash
for r in actions/checkout actions/setup-node amannn/action-semantic-pull-request googleapis/release-please-action; do
  echo "$r $(gh api repos/$r/releases/latest --jq .tag_name)"
done
```

Expected: uma tag por action. Usar a versão maior retornada (ex.: `v5.0.0` → `@v5`) nos workflows desta task e da Task 4. Os exemplos abaixo usam `@v5`, `@v5`, `@v5` e `@v4`; ajustar se a saída for diferente.

- [ ] **Step 2: Escrever `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    name: test (Node ${{ matrix.node }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test

  package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run smoke:package

  pr-title:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    steps:
      - uses: amannn/action-semantic-pull-request@v5
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          types: |
            feat
            fix
            sec
            perf
            refactor
            docs
            test
            ci
            chore
```

- [ ] **Step 3: Validar a sintaxe do YAML**

Run: `ruby -ryaml -e 'YAML.load_file(".github/workflows/ci.yml"); puts "yaml ok"'`
Expected: `yaml ok`. A validação real acontece quando o PR roda no GitHub (Task 6).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run tests, typecheck and package smoke test"
```

---

### Task 4: release-please e publicação no npm

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `release-please-config.json`
- Create: `.release-please-manifest.json`

**Interfaces:**
- Consumes: `package.json` `version: "0.0.0"` (Task 1).
- Produces: tags `vX.Y.Z`, `CHANGELOG.md` mantido pelo release-please, publicação no npm.

- [ ] **Step 1: `release-please-config.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "node",
  "include-component-in-tag": false,
  "bump-minor-pre-major": true,
  "packages": {
    ".": {
      "package-name": "paywings",
      "changelog-sections": [
        { "type": "feat", "section": "Features" },
        { "type": "fix", "section": "Bug Fixes" },
        { "type": "sec", "section": "Security" },
        { "type": "perf", "section": "Performance" },
        { "type": "refactor", "section": "Refactoring", "hidden": true },
        { "type": "docs", "section": "Documentation", "hidden": true },
        { "type": "test", "section": "Tests", "hidden": true },
        { "type": "ci", "section": "CI", "hidden": true },
        { "type": "chore", "section": "Chores", "hidden": true }
      ]
    }
  }
}
```

- [ ] **Step 2: `.release-please-manifest.json`**

```json
{
  ".": "0.0.0"
}
```

- [ ] **Step 3: `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    outputs:
      release_created: ${{ steps.release.outputs.release_created }}
      tag_name: ${{ steps.release.outputs.tag_name }}
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json

  publish-npm:
    needs: release-please
    if: needs.release-please.outputs.release_created == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      # Trusted publishing needs npm >= 11.5.1.
      - run: npm install --global npm@latest
      - run: npm ci
      - run: npm test
      - run: npm publish
```

- [ ] **Step 4: Validar os JSONs e o YAML**

Run: `node -e "for (const f of ['release-please-config.json','.release-please-manifest.json']) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('json ok')" && ruby -ryaml -e 'YAML.load_file(".github/workflows/release.yml"); puts "yaml ok"'`
Expected: `json ok` e `yaml ok`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml release-please-config.json .release-please-manifest.json
git commit -m "ci: automate releases with release-please and npm trusted publishing"
```

---

### Task 5: Documentação de versionamento, contribuição e instalação

**Files:**
- Create: `docs/VERSIONING.md`
- Create: `CONTRIBUTING.md`
- Modify: `README.md` (seções "Requirements", "Quick start" e "Development")
- Modify: `README.pt-BR.md` (seções "Requisitos", "Começando" e "Testes")

- [ ] **Step 1: `docs/VERSIONING.md`**

```markdown
# Versioning

PayWings follows [Semantic Versioning](https://semver.org). Releases, tags (`vX.Y.Z`) and the
[changelog](../CHANGELOG.md) are generated from [Conventional Commits](https://www.conventionalcommits.org).

## Public API

Changes to any of these follow the rules below:

- CLI commands, flags and exit codes
- JSON printed by `paywings pay` and `paywings status`
- MCP tool names, input parameters and response fields
- Reason codes returned on denied payments (for example `MERCHANT_NOT_ALLOWED`)
- Environment variables (`PAYWINGS_DB`, `PAYWINGS_AGENT_KEY`)
- Agent key prefix (`pw_test_`)
- Database file compatibility: a newer version always opens a database created by an older one

Not part of the public API: modules under `src/`, human-readable messages, and the database table layout.

## Before 1.0 (current)

| Change | Version bump |
| --- | --- |
| Bug or security fix (`fix:`, `sec:`) | patch: `0.1.0` → `0.1.1` |
| New feature (`feat:`) | minor: `0.1.0` → `0.2.0` |
| Breaking change (`feat!:`, `BREAKING CHANGE:`) | minor, called out in the changelog |

A patch release never breaks the public API. Pin a minor range (`~0.1.0`) to avoid surprises.

## From 1.0 on

Breaking changes require a major version. Deprecated behavior keeps working for at least one minor release and
prints a warning before it is removed.
```

- [ ] **Step 2: `CONTRIBUTING.md`**

```markdown
# Contributing

## Setup

Node 22.18 or newer.

```bash
npm install
npm test               # unit tests
npm run typecheck
npm run smoke:package  # packs and installs the package, then runs the CLI
npm run paywings -- --help   # run the CLI from source
```

## Commits and pull requests

Pull requests are squash-merged, so the **PR title** becomes the commit on `main` and drives the next version.
Use [Conventional Commits](https://www.conventionalcommits.org):

| Type | Use for | Release |
| --- | --- | --- |
| `feat:` | new behavior | minor |
| `fix:` | bug fix | patch |
| `sec:` | security fix | patch |
| `perf:` | performance | patch |
| `docs:`, `test:`, `ci:`, `chore:`, `refactor:` | everything else | none |

Add `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer when you change the
[public API](docs/VERSIONING.md#public-api).

## Releases

A bot keeps a "release PR" open with the next version and changelog. Merging it tags the release and publishes
to npm. Pull requests opened by the bot do not trigger CI; the commits they contain already passed CI on `main`.
```

- [ ] **Step 3: README em inglês — "Requirements", "Quick start" e "Development"**

Substituir a seção "Requirements" e as linhas de instalação do "Quick start" por:

```markdown
## Install

Requires Node 22.18 or newer.

```bash
npm install --global paywings
paywings init       # creates ~/.paywings/sandbox.db with a "demo" agent and R$ 500.00
```

Or run without installing: `npx paywings init`. Versions follow [semver](docs/VERSIONING.md); see the
[changelog](CHANGELOG.md).
```

Renomear o heading "Quick start" para "Connect an agent" e manter o restante dele (comando `claude mcp add` em diante).

Substituir o bloco de código de "Development" por:

```bash
npm install
npm test
npm run typecheck
npm run smoke:package
```

e adicionar abaixo: `See [CONTRIBUTING.md](CONTRIBUTING.md) for commit and release conventions.`

- [ ] **Step 4: README em português — mesmas mudanças**

"Requisitos" e o início de "Começando" viram:

```markdown
## Instalação

Requer Node 22.18 ou mais novo.

```bash
npm install --global paywings
paywings init       # cria ~/.paywings/sandbox.db com o agente "demo" e R$ 500,00
```

Ou sem instalar: `npx paywings init`. As versões seguem [semver](docs/VERSIONING.md); veja o
[changelog](CHANGELOG.md).
```

Renomear "Começando" para "Conectando um agente". Em "Testes", usar o mesmo bloco de comandos do README em inglês e adicionar: `Veja o [CONTRIBUTING.md](CONTRIBUTING.md) para o padrão de commits e releases.`

- [ ] **Step 5: Conferir os links relativos**

Run: `for f in README.md README.pt-BR.md CONTRIBUTING.md docs/VERSIONING.md; do grep -o '](\([^)#]*\)' "$f" | sed 's/](//' | grep -v '^http' | while read -r p; do d=$(dirname "$f"); [ -e "$d/$p" ] || [ "$p" = "CHANGELOG.md" ] || [ "$p" = "../CHANGELOG.md" ] || echo "broken: $f -> $p"; done; done; echo done`
Expected: só `done`. O `CHANGELOG.md` passa a existir com o primeiro PR de release.

- [ ] **Step 6: Commit**

```bash
git add docs/VERSIONING.md CONTRIBUTING.md README.md README.pt-BR.md
git commit -m "docs: document installation, versioning and contribution workflow"
```

---

### Task 6: PR, CI verde e configuração do repositório

**Files:** nenhum.

- [ ] **Step 1: Verificação local final**

Run: `npm run typecheck && npm test && npm run smoke:package`
Expected: tudo verde, com `# pass 34` e `package smoke test passed (paywings 0.0.0)`.

- [ ] **Step 2: Push da branch e abertura do PR**

```bash
git push -u origin chore/release-foundation
gh pr create --title "chore: release foundation" --body-file - <<'EOF'
## What
- Publish compiled JavaScript (`dist/`): Node refuses to strip types inside `node_modules`, so the current package would break on `npm i -g`.
- `paywings --version`.
- CI: typecheck and tests on Node 22 and 24, a package smoke test that installs the packed tarball, and a Conventional Commits check on PR titles.
- Releases: release-please opens a release PR with the semver bump and changelog; merging it tags `vX.Y.Z` and publishes to npm via trusted publishing (OIDC, no stored token).
- Docs: `docs/VERSIONING.md` (public API and bump rules), `CONTRIBUTING.md`, install instructions.

## Why
Easy installation and predictable versions for users ([ClickUp: v0.1.0](https://app.clickup.com/t/17tq1adzfxm)). Design: `docs/design/2026-10-02-release-foundation.md`.

## How to verify
- `npm run smoke:package` passes locally and in CI.
- After merge, a release PR proposing `0.1.0` appears.
- First publish is manual (npm requires the package to exist before trusted publishing can be configured); see the design doc, section 3.
EOF
```

O corpo do PR não leva linhas de atribuição.

- [ ] **Step 3: Acompanhar o CI**

Run: `gh pr checks --watch`
Expected: `test (Node 22)`, `test (Node 24)`, `package` e `pr-title` verdes. Se algum falhar, ler o log com `gh run view --log-failed`, corrigir na branch, fazer commit e push.

- [ ] **Step 4: Permitir que o Actions abra PRs (pedir confirmação ao dono antes)**

O release-please precisa abrir PRs. Por padrão, o GitHub bloqueia isso em repositórios novos. É uma mudança de configuração do repositório: pedir confirmação explícita e então rodar:

```bash
gh api -X PUT repos/diego-maeda/paywings/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
```

Expected: HTTP 204, sem saída.

- [ ] **Step 5: Atualizar o ClickUp**

Na tarefa [PayWings v0.1.0](https://app.clickup.com/t/17tq1adzfxm): adicionar um comentário com o link do PR e mudar o status para revisão. Usar o nome de status da lista, que se descobre com `clickup_get_list`. Não criar registros de tempo.
