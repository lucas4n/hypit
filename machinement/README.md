# Machinement no fork do Hypit

Este é o fork `lucas4n/hypit` de `hypit-ai/hypit`. Tudo o que é nosso fica **nesta pasta**. Fora
dela, as únicas mudanças são duas linhas: `pnpm-workspace.yaml` e `test/run.mjs` incluem
`machinement/packages/*`. Assim o merge do `upstream` continua limpo.

**Licença:** o fork herda a licença do Hypit (Apache com condições). Pode ser usado na agência e
para clientes. **Não** pode virar SaaS multi-inquilino nem ser revendido. A saída (vídeos) é nossa.

## Provedores

| Pacote | Atende | Paga com | Login |
|---|---|---|---|
| `@machinement/provider-magnific` | `gpt-image-2`, `nano-banana-2`, `nano-banana-pro`, `seedance-2`, `-fast`, `-mini` | créditos do plano Magnific | OAuth do dashboard (`credentials/magnific-mcp.json` do socialmedia) |
| `@machinement/provider-fal` | `seedance-2`, `seedance-2-fast` | saldo da fal | `FAL_KEY` no ambiente |

O Magnific é o padrão. A fal é a rota alternativa do Seedance: trocar é mudar uma linha em
`bindings` no perfil.

Mapeamentos que parecem errados, mas estão certos:
- **Nano Banana 2** é o slug `imagen-nano-banana-2-flash`, e **Nano Banana Pro** é `imagen-nano-banana-2`.
- O modelo `gpt-2` do Magnific é o GPT Image 2.

## ⚠ A testar antes de confiar: voz no Seedance

O Hypit faz o apresentador falar com a voz de uma amostra: ele passa o áudio como referência
para o Seedance. O catálogo do Magnific afirma que, no Seedance dele, a referência de áudio
"guia ritmo e personagem, **não clona voz nem faz lip-sync**". A fal serve o mesmo modelo da
ByteDance e não faz essa ressalva.

O primeiro take pago deve responder a isso: gerar a mesma cena pelas duas rotas e comparar a
voz. Se o Magnific não mantiver a voz, os takes com fala vão pela fal e o resto continua no
Magnific.

## Usar num projeto

Os projetos moram no workspace do socialmedia, não aqui.

```bash
# 1. no fork: build dos provedores
corepack pnpm --filter "@machinement/*" build

# 2. no projeto de vídeo: instalar e copiar o perfil
npm install /home/t-gamer/Machinement/engines/hypit/machinement/packages/provider-magnific \
            /home/t-gamer/Machinement/engines/hypit/machinement/packages/provider-fal
cp /home/t-gamer/Machinement/engines/hypit/machinement/hypit.runtime.example.json hypit.runtime.json
#    trocar folderReference pela pasta Magnific do workspace

# 3. conferir sem gastar
node /home/t-gamer/Machinement/engines/hypit/bin/hypit.mjs plan <run>.svrun --runtime hypit.runtime.json
```

Só o `build` gasta. `plan` e `check` nunca geram nada.

## Testes

```bash
node --import tsx --test machinement/packages/*/test/*.test.ts   # só os nossos
corepack pnpm test                                               # suíte inteira do fork
```

Os testes simulam a fal e o MCP: nenhum deles chama serviço real.
