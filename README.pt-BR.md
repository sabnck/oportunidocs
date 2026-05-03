<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.pt-BR.md">Português do Brasil</a>
</p>

# OportuniDocs

OportuniDocs é um editor local de documentos para PDFs, documentos digitalizados e arquivos do dia a dia. Ele foi pensado para pessoas que precisam editar, assinar, organizar e salvar documentos sem enviar arquivos privados para serviços online aleatórios.

O projeto inclui uma versão desktop, uma interface local que abre no navegador, uma API REST local e uma extensão para navegador.

Certificado por Henrique Fernandes | StudioElevatio.com

## Por Que Este Projeto Existe

Muitas ferramentas de documentos são caras, limitadas, dependem da nuvem ou são confusas para quem só precisa corrigir um documento e seguir a vida. O OportuniDocs mantém o trabalho na máquina do usuário e foca em fluxos práticos.

Ele ajuda com currículos, contratos, declarações, formulários, certificados, páginas digitalizadas, prints convertidos em PDF e outros arquivos comuns.

## Principais Recursos

**Edição visual de texto em PDF**

Selecione áreas de texto detectadas, edite o conteúdo, ajuste tamanho da fonte, estilo, cor e espaçamento, depois salve o documento corrigido.

**Documentos digitalizados e imagens**

O OCR detecta texto em páginas digitalizadas e documentos baseados em imagem usando Tesseract.js localmente. Isso permite corrigir texto sobre um scan mantendo a página original visível.

**Anotações e assinaturas**

Adicione textos, destaques, sublinhados, riscos, desenhos, formas, comentários, carimbos e assinaturas.

**Organização de páginas**

Reordene páginas, gire, duplique, exclua, una PDFs e divida documentos por intervalo de páginas.

**Melhoria de páginas digitalizadas**

O app inclui uma ferramenta local para melhorar contraste, tons de cinza e leitura de páginas digitalizadas.

**API local**

Com o app desktop aberto, uma API REST fica disponível em `http://localhost:47411/api` para automações e integrações.

**Extensão para navegador**

A extensão para Chrome e Edge detecta links de PDF e envia para o editor local.

## Privacidade

OportuniDocs foi criado com processamento local como base.

- Os documentos não são enviados pelo editor.
- O OCR roda localmente no navegador ou no app desktop.
- A API local fica limitada a `127.0.0.1`.
- Este projeto não coleta telemetria.
- O usuário continua responsável pelos arquivos que exporta, compartilha ou envia para outros serviços.

## Estrutura Do Projeto

```text
oportunidocs/
|- app-desktop/       App desktop com Electron, React e TypeScript
|- core-api/          API REST standalone para automação de documentos
|- extension-web/     Extensão para Chrome e Edge
|- docs/              Notas de arquitetura e API
|- scripts/           Auxiliares de build e release
`- shared/            Tipos e constantes compartilhados
```

## Requisitos

- Node.js 20 ou mais recente
- npm
- Windows para gerar o instalador desktop
- Chrome ou Edge para a extensão opcional

## Rodar Localmente

```bash
git clone https://github.com/sabnck/oportunidocs.git
cd oportunidocs/app-desktop
npm install
npm run dev
```

O app desktop abre em modo de desenvolvimento.

## Gerar A Versão Local

Dentro de `app-desktop/`:

```bash
npm run build
```

Para criar um instalador Windows e uma versão portátil:

```bash
npm run build:win
```

Os arquivos gerados ficam na pasta de saída do Electron. Instaladores e executáveis são ignorados pelo Git de propósito.

## Usar A Interface No Navegador

Abra o app desktop e depois acesse a interface local no navegador. A interface do navegador conversa com o app local e mantém o processamento dos documentos na sua máquina.

## API Local

Com o app desktop aberto, a API fica disponível em:

```text
http://localhost:47411/api
```

Endpoints comuns:

| Método | Endpoint | Função |
| --- | --- | --- |
| GET | `/api/status` | Verifica se o app está rodando |
| POST | `/api/pdf/merge` | Une vários PDFs |
| POST | `/api/pdf/split` | Divide um PDF por intervalo de páginas |
| POST | `/api/pdf/metadata` | Lê metadados do documento |
| POST | `/api/pdf/set-metadata` | Atualiza metadados do documento |
| POST | `/api/pdf/extract-pages` | Extrai páginas selecionadas |

Exemplo:

```bash
curl -X POST http://localhost:47411/api/pdf/merge \
  -F "files=@documento1.pdf" \
  -F "files=@documento2.pdf" \
  --output unido.pdf
```

## Instalar A Extensão Do Navegador

1. Abra `chrome://extensions` ou `edge://extensions`.
2. Ative o modo de desenvolvedor.
3. Escolha "Carregar sem compactação".
4. Selecione a pasta `extension-web/`.

Depois de instalada, clique com o botão direito em um link de PDF ou use o popup da extensão para abrir documentos no OportuniDocs.

## Notas Para Desenvolvimento

O app usa:

- Electron para o app desktop.
- React e TypeScript para a interface.
- PDF.js para renderização.
- pdf-lib para manipulação de PDF.
- Tesseract.js para OCR local.
- Zustand para gerenciamento de estado.
- Tailwind CSS para estilos.
- Express para a API local.

## Segurança

Não reporte vulnerabilidades em issues públicas. Use os avisos privados de segurança do GitHub quando possível. Veja [SECURITY.md](./SECURITY.md).

## Contribuição

Issues e pull requests são bem-vindos. Leia [CONTRIBUTING.md](./CONTRIBUTING.md) primeiro para manter a conversa prática e fácil de revisar.

## Licença

Este repositório tem código disponível para portfólio, revisão e aprendizado. Direitos de uso, distribuição e uso comercial estão definidos em [LICENSE](./LICENSE).

## Créditos

OportuniDocs é criado e mantido por Henrique Fernandes.

StudioElevatio.com
