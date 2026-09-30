# Machinement no fork do Hypit

Este é o fork `lucas4n/hypit` de `hypit-ai/hypit`. Tudo o que é nosso fica **nesta pasta**. Fora
dela, as únicas mudanças são duas linhas: `pnpm-workspace.yaml` e `test/run.mjs` incluem
`machinement/packages/*`. Assim o merge do `upstream` continua limpo.

**Licença:** o fork herda a licença do Hypit (Apache com condições). Pode ser usado na agência e
para clientes. **Não** pode virar SaaS multi-inquilino nem ser revendido. A saída (vídeos) é nossa.

## Provedores

| Pacote | Atende | Paga com | Login |
|---|---|---|---|
| `@machinement/provider-magnific` | **só imagem**: `gpt-image-2`, `nano-banana-2`, `nano-banana-pro` | créditos do plano Magnific | OAuth do dashboard (`credentials/magnific-mcp.json` do socialmedia) |
| `@machinement/provider-fal` | **vídeo**: `seedance-2`, `seedance-2-fast` | saldo da fal | `FAL_KEY` no ambiente |

**Por que vídeo não passa pelo Magnific** (decisão provisória de 2026-09-30): um take de 5 s em
720p custa 1.400 créditos no Seedance 2.0 (1.175 no Fast), ~3% dos 45 mil créditos por mês que os
canais usam para imagem. Por take, o Magnific é **mais barato** (≈ R$ 5,60 contra ≈ R$ 8,30 na
fal, no Premium+ a R$ 180). A fal ganha por não disputar a bolsa dos canais. Falta testar se a voz
da amostra se mantém em cada rota: a doc do Magnific diz que a referência de áudio "não clona
voz", mas isso nunca foi medido. Se o Magnific mantiver a voz, `git revert 2b6f2b13` devolve o
Seedance para ele.
O provedor do Magnific **não oferece** Seedance. Não basta tirar do perfil: um Model com uma
única oferta seria escolhido sem aviso, e o `seedance-2-mini` (que a fal não tem) gastaria
crédito calado. Por isso `model="mini"` não roda: o `plan` recusa.

Mapeamentos que parecem errados, mas estão certos:
- **Nano Banana 2** é o slug `imagen-nano-banana-2-flash`, e **Nano Banana Pro** é `imagen-nano-banana-2`.
- O modelo `gpt-2` do Magnific é o GPT Image 2.

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
