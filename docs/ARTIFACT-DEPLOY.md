# IDP — Artifact Deploy (release → sunucu)

> Son güncelleme: 2026-09-11 · Kapsam: `backend/src/core/artifacts/`, `backend/src/routes/artifacts.js`,
> `idp-agent-gateway` (`/agent/artifact-command`), agent tarafı: `idp-agent/ARTIFACT-DEPLOY-AGENT.md`.
> Testler: `backend/test/artifact-*.test.js`, `backend/test/release-service.test.js`, `idp-agent-gateway/test/gateway.test.js`.

## 1. Genel bakış

Müşteri sunucusunda **tek bir agent** çalışır (sunucu başına tek proje) ve public IDP gateway'ine dışarıya doğru
(WSS) bağlanır. Akış iki aşamalıdır:

1. **Release (F1).** Geliştirici IDP'den bir projenin sürümünü keser (ör. jetsrm `2.5.0`). IDP build'i mevcut
   adapter'larla tetikler (**CI Pipeline** → Bitbucket Pipelines / GitHub Actions, ya da **Jenkins**). Build,
   sürümlü `.tar.gz` artifact'ları ve bir **manifest** üretip **Bitbucket Downloads** veya **GitHub Release
   assets**'e yükler. Build başarılı olunca IDP manifest'i okur, doğrular, `releases` + `release_artifacts`
   tablolarına yazar; release `ready` olur. Build yoksa (`build.provider: none`) artifact'lar elle yüklenir ve
   release **import** edilir.
2. **Deploy (F2).** IDP bir release'i bir **hedefe** (deploy target = müşteri sunucusu = agent) gönderir:
   backend → gateway → agent `artifact_deploy`. Agent her artifact'ı **IDP backend'inden** indirir (backend
   kaynağa proxy olur; repo token'ı agent'a hiç gitmez), sha256 doğrular, açar, sunucuya özel dosyaları korur,
   durdurur / değiştirir / (varsa preStart hook'larını çalıştırır) / başlatır, health-check yapar, hata olursa
   otomatik geri alır, aşama olayları ve **tek bir** terminal sonuç gönderir.

```
[IDP UI/API] --deploy--> [backend] --control API 127.0.0.1:7004--> [gateway] <--WSS-- [agent @ müşteri]
                            |  ^                                                        |
                            |  +------ GET /api/artifacts/:id/download (Bearer indirme token'ı) ---+
                            +--> Bitbucket Downloads / GitHub Release assets (repo token yalnız burada)
[CI Pipeline | Jenkins] --build--> *.tar.gz + <proje>-<sürüm>-manifest.json --upload--> Bitbucket/GitHub
```

Klasör düzeni (Windows): `C:/inetpub/wwwroot/jetsrm/` altında `backend/`, `frontend/` (IIS statik site),
`agent/`, `.releases/`. Linux: `/var/www/jetsrm/` aynı düzen. Taban yol (`deploy.base-path`) **agent'ın yerel
config'indedir**; backend keyfi yol veremez, payload'daki `subdir` bu kökün içinde çözülür.

Mevcut akışlar (Jenkins, PMP, Server/SSH/WinRM, idp-agent `run_deploy`, CI Pipeline) değişmedi.

## 2. Sözleşmeler

### 2.1 Manifest

Dosya adı: `<artifactName>-<version>-manifest.json` (ör. `jetsrm-2.5.0-manifest.json`), artifact'ların yanına
yüklenir.

```json
{ "schema": 1, "project": "jetsrm", "version": "2.5.0", "commit": "abc123", "createdAt": "2026-09-11T10:00:00Z",
  "artifacts": [
    { "component": "backend",  "os": "win-x64", "file": "jetsrm-backend-2.5.0-win-x64.tar.gz", "sha256": "<64 hex>", "size": 123 },
    { "component": "frontend", "os": "any",     "file": "jetsrm-frontend-2.5.0.tar.gz",        "sha256": "<64 hex>", "size": 456 } ] }
```

| Alan | Kural |
|---|---|
| `schema` | `1` |
| `project` | `artifactDeploy.artifactName` ile **aynı** olmalı |
| `version` | `^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$`, istenen sürümle aynı |
| `artifacts[].component` | `^[a-z][a-z0-9-]{0,31}$` |
| `artifacts[].os` | `any` \| `win-x64` \| `linux-x64`; bir bileşen+os çifti bir kez |
| `artifacts[].file` | yalın dosya adı `^[A-Za-z0-9._-]+\.tar\.gz$` (klasör yok) |
| `artifacts[].sha256` | 64 küçük harf hex |
| `artifacts[].size` | pozitif tamsayı (bayt) |

Import sırasında her dosyanın kaynakta **gerçekten bulunduğu** ve boyutunun manifest'le **aynı** olduğu kontrol
edilir (Bitbucket Downloads listesi / GitHub release assets).

**Arşiv kökü = bileşen klasörünün içeriği.** `tar -czf x.tar.gz -C dist .` gibi; üstte ekstra bir klasör,
mutlak yol, `..`, symlink/hardlink olmamalı (agent reddeder).

### 2.2 Agent WebSocket mesajları

Zarf değişmedi: `{date, type, agentId, process, payload}`.

**Sunucu → agent** (`type: "server"`), gateway control API ile gönderilir:

- `artifact_deploy`

```json
{ "deployId": "dep_…", "project": "jetsrm", "version": "2.5.0", "timeoutSec": 2190,
  "components": [
    { "name": "backend", "subdir": "backend", "version": "2.5.0",
      "download": { "url": "https://idp.example/api/artifacts/<artifactId>/download", "token": "<indirme token'ı>", "sha256": "<hex>", "size": 123 },
      "runtime": { "type": "nssm", "serviceName": "jetsrm-backend", "appPool": null },
      "preserve": [".env", "certificates/**", "uploads/**"],
      "health": { "url": "http://127.0.0.1:3000/health", "expectVersionPath": null, "timeoutSec": 90 },
      "runtimeConfig": null,
      "hooks": { "preStart": [ { "name": "migrate", "command": "node",
                                 "args": ["node_modules/sequelize-cli/lib/sequelize", "db:migrate"],
                                 "env": { "NODE_ENV": "prod" }, "timeoutSec": 600 } ] } },
    { "name": "frontend", "subdir": "frontend", "version": "2.5.0",
      "download": { "...": "..." },
      "runtime": { "type": "iis-static", "serviceName": null, "appPool": null },
      "preserve": ["web.config"],
      "health": null,
      "runtimeConfig": { "VITE_APP_MAIN_URL": "https://api.customer", "VITE_COMPANY_NAME": "temsa" },
      "hooks": null } ] }
```

  - `runtime.type` ∈ `nssm | windows-service | iis-static | systemd | none`. `serviceName` nssm/windows-service/
    systemd için dolu, diğerlerinde `null`; `appPool` yalnız `iis-static` için (swap sonrası recycle), yoksa `null`.
  - `runtimeConfig` (string→string ya da `null`): agent bileşen köküne, **preserve'den sonra**
    `config.js` = `window.__ENV__ = <JSON>;` yazar (IDP yönetir, korunan dosyayı ezer). Yalnız
    `writeRuntimeConfig: true` bileşenlere, hedefin `runtimeConfig` değeri gider.
  - `hooks.preStart` (ya da `null`): swap'tan **sonra**, servis başlamadan **önce**, bileşen kökünde sırayla
    çalışır (bkz. §3.2).
  - `timeoutSec`: agent tarafı genel süre; `900 + Σ health.timeoutSec + Σ hook.timeoutSec`, en az 1800, en çok 14400.
- `artifact_rollback` `{ "deployId": "dep_…", "components": ["backend"] | null }` (`null` = önceki sürümü olan tüm bileşenler)
- `artifact_cancel` `{ "deployId": "dep_…" }`
- `artifact_status` `{ "requestId": "req_…" }`

**Agent → sunucu** (`type: "agent"`), gateway `FORWARDED_PROCESSES` ile backend aboneliğine iletilir:

- `deploy_event` `{ deployId, component|null, stage, status, progress|null, message }`
  - `stage` ∈ `accepted | downloading | verifying | extracting | preserving | configuring | stopping | switching |
    pre_start | starting | health_check | rolling_back | cleanup`
  - `status` ∈ `started | progress | done | failed | skipped`
  - `pre_start` olayında `message` **yalnız hook adıdır**; env değerleri hiçbir log/olaya yazılmaz.
- `deploy_result` (deployId başına **tek**, terminal) `{ deployId, success, version, rolledBack, durationMs,
  components: [{ name, success, rolledBack, previousVersion, error|null }], error|null }`.
  Red için de kullanılır: meşgul → `success:false, error:"busy"`; geçersiz payload → `error:"invalid_payload: …"`;
  base-path yok → `error:"not_configured"`; iptal → `error:"cancelled"`.
- `artifact_status_result` `{ requestId, basePath, components: { "<name>": { version, deployedAt, previousVersions: [..] } } }`

**Korelasyon:** backend bir mesajı yalnızca `agentId` hedefin agent'ı **ve** `payload.deployId` bu deploy'un
id'si ise sayar. Eski `command_execution_result` ve başka her trafik yok sayılır.

### 2.3 Artifact indirme ucu

`GET /api/artifacts/:artifactId/download`, başlık `Authorization: Bearer <indirme token'ı>` (query string
**değil**). Oturum cookie'si gerekmez, yalnızca token.

- Token: 32 rastgele bayt (base64url). Yalnız sha256'sı saklanır: `artifact_download_tokens(token_hash PK,
  artifact_id, agent_id, deployment_id, expires_at, max_uses, uses, created_at)`.
- Ömür 30 dk, en çok 5 kullanım (agent tekrar denemeleri), tek bir artifact'a bağlı. İstek `X-IDP-Agent-Id`
  gönderirse token'ın agent'ıyla eşleşmeli. Deploy terminal duruma geçince (başarı, hata, iptal, zaman aşımı)
  o deploy'un tüm token'ları **silinir**.
- Geçersiz / süresi dolmuş / başka artifact'a ait → gövdesiz `401 {"error":"Unauthorized"}`.
- Yanıt: kaynaktan **akış** (tamponlanmaz), `Content-Type: application/gzip`, `Content-Length` (manifest boyutu),
  `X-Artifact-Sha256`, `Cache-Control: no-store`. Kaynak `Content-Length` manifest'ten farklıysa ya da kaynak
  hata verirse `502` (yanlış gövde asla gönderilmez).
- Kaynaktan çekme: Bitbucket `GET {base}/repositories/{ws}/{repo}/downloads/{file}`, GitHub
  `GET {base}/repos/{o}/{r}/releases/assets/{assetId}` + `Accept: application/octet-stream`. İkisi de 302 ile
  depolama adresine yönlendirir. Yönlendirmeler **elle** izlenir; repo token'ı yalnız API host'una gider, imzalı
  depolama URL'sine gitmez; yalnız `https://`; en çok 5 yönlendirme.
- IP başına 60 istek/dk. Her indirme ve her ret audit'e düşer (`ARTIFACT_DOWNLOADED`, `ARTIFACT_DOWNLOAD_REJECTED`,
  `ARTIFACT_DOWNLOAD_FAILED`: artifact id, agent id, deployment id; **token asla**).

## 3. Proje ayarı: `config.artifactDeploy`

`POST /api/projects/:id/settings` ile kaydedilir (`project:write`, admin). Proje seviyesindedir (ortam
override'ı yok).

```json
{
  "artifactDeploy": {
    "source": { "platform": "bitbucket", "owner": "mdp", "repo": "jetsrm", "baseUrl": "", "authType": "bearer",
                "username": "", "token": "<yalnızca yazarken; yanıtta hasToken:true>" },
    "build": { "provider": "pipeline" },
    "versionVariable": "VERSION",
    "artifactName": "jetsrm",
    "components": [
      { "name": "backend", "subdir": "backend", "os": "win-x64",
        "runtime": { "type": "nssm", "serviceName": "jetsrm-backend" },
        "preserve": [".env", "certificates/**", "uploads/**"],
        "health": { "url": "http://127.0.0.1:3000/health", "timeoutSec": 90 },
        "writeRuntimeConfig": false,
        "hooks": { "preStart": [ { "name": "migrate", "command": "node",
                                   "args": ["node_modules/sequelize-cli/lib/sequelize", "db:migrate"],
                                   "env": { "NODE_ENV": "prod" }, "timeoutSec": 600 } ] } },
      { "name": "frontend", "subdir": "frontend",
        "runtime": { "type": "iis-static", "appPool": "" },
        "preserve": ["web.config"], "health": null, "writeRuntimeConfig": true }
    ]
  }
}
```

| Alan | Açıklama |
|---|---|
| `source.platform` | `bitbucket` \| `github`: artifact'ların durduğu yer |
| `source.owner` / `repo` | Bitbucket workspace/repo slug'ı · GitHub owner/repo |
| `source.baseUrl` | Boşsa `https://api.bitbucket.org/2.0` / `https://api.github.com`. GHES: `https://HOST/api/v3`. Yalnız `https://` |
| `source.authType` | Bitbucket: `bearer` (Access Token) \| `basic` (Atlassian e-posta `username` + API token) |
| `source.token` | **Secret** (`artifactDeploy.source.token`): şifreli saklanır, yanıtlarda `source.hasToken` olarak döner, boş/eksik gönderilirse saklı değer korunur. Boşsa projenin `apiToken`'ı (+`username`) kullanılır |
| `build.provider` | `pipeline` (projenin `ciConfig` + `apiToken`), `jenkins` (projenin `url` / `jobName` / `username` / `apiToken`), `none` (yalnız import) |
| `versionVariable` | Build'e sürümün geçtiği değişken/parametre adı (varsayılan `VERSION`) |
| `artifactName` | Manifest `project` ve dosya adı öneki. Varsayılan: `source.repo` (küçük harf) |
| `components[]` | En çok 10; `name` benzersiz, `subdir` tek klasör adı (`.`/`..` değil, büyük/küçük harf duyarsız benzersiz) |
| `components[].os` | Opsiyonel sabitleme: `win-x64`/`linux-x64`/`any`. Boşsa hedef OS'u, yoksa `any` seçilir |
| `components[].runtime` | `type` + `serviceName` (nssm/windows-service/systemd için zorunlu, `^[A-Za-z0-9._@-]{1,128}$`) / `appPool` (iis-static) |
| `components[].preserve` | En çok 50 göreli desen (`..`, baştaki `/` ya da sürücü harfi yok). Canlı klasörden yeni sürüme kopyalanır, canlı kazanır |
| `components[].health` | `null` ya da `{url (http/https), expectVersionPath?, timeoutSec 5–600 (vars. 90)}` |
| `components[].writeRuntimeConfig` | `true` → hedefin `runtimeConfig`'i `config.js` olarak yazılır |
| `components[].hooks` | `null` ya da `{ preStart: [...] }` (bkz. 3.2) |

Kaydetme sırasında `artifactDeploy` **bir bütün olarak değiştirilir** (silinen bileşen/desen/hook gerçekten
silinir), yalnız `source.token` korunur.

### 3.2 preStart hook'ları

Swap'tan sonra, servis başlamadan önce, bileşen kökünde (`<base>/<subdir>`) **sırayla** çalışan komutlar
(ör. veritabanı migration'ı). Hook başarısız olursa bileşen (ve aynı deploy'da değişmiş diğer bileşenler) geri
alınır.

| Alan | Kural |
|---|---|
| `preStart` | en çok 5 hook |
| `name` | `^[a-z][a-z0-9-]{0,31}$`, bileşen içinde benzersiz |
| `command` | **yalın çalıştırılabilir adı** `^[A-Za-z0-9._-]{1,64}$`; yol ayırıcı yok, agent PATH'ten çözer |
| `args` | en çok 20 string, her biri ≤ 512 karakter, NUL yok. Kabuk yok: argüman listesi olarak geçer |
| `env` | en çok 20 anahtar, `^[A-Z_][A-Z0-9_]*$`, değer ≤ 1024 karakter |
| `timeoutSec` | 1–3600, varsayılan 600 |

- Hook'lar **yalnız proje ayarından** gelir (`project:write`, admin). Deploy anındaki parametrelerden **asla**
  kabul edilmez; deploy isteğinde `hooks` alanı 400 döner.
- `pre_start` olaylarında yalnız hook adı görünür; env değerleri log, olay ve audit'e yazılmaz. Yine de hook
  env'ine sır koymayın: sunucudaki `.env` (preserve) daha doğru yerdir.

JetSRM örneği (Sequelize, 440 migration, uygulama açılışta migrate etmez):

```json
{ "name": "migrate", "command": "node",
  "args": ["node_modules/sequelize-cli/lib/sequelize", "db:migrate"],
  "env": { "NODE_ENV": "prod" } }
```

> **Uyarı: migration + otomatik rollback.** Migration başarılı olduktan sonra health-check düşerse agent **eski
> kodu yeni şemanın üstüne** geri koyar. Bu yalnızca migration'lar **geriye uyumluysa** (expand/contract:
> önce kolon ekle, kodu geçir, sonraki sürümde eski kolonu sil) güvenlidir. Değilse bu bir **operatör kararıdır**:
> ya migration'ları geriye uyumlu yazın, ya da riskli sürümleri migration adımından sonra otomatik geri
> almayacak şekilde ayrı yayınlayın (ör. önce yalnız migration içeren bir sürüm, sonra kod). IDP şemayı geri
> almaz (`db:migrate:undo` çalıştırılmaz).

## 4. Build job sözleşmesi

Build job'ı (CI Pipeline, GitHub Actions ya da Jenkins):

1. Sürümü `versionVariable` (vars. `VERSION`) değişkeninden/parametresinden okur. IDP bu değeri **sunucu
   tarafında** enjekte eder (CI Pipeline: `extraVariables`; Jenkins: build parametresi). Deploy eden kullanıcı
   değişken gönderemez.
2. Her bileşen için `<artifactName>-<component>-<version>[-<os>].tar.gz` üretir (dosya adı serbest ama
   manifest'teki `file` ile aynı olmalı). Arşiv kökü = bileşen klasörü.
3. `<artifactName>-<version>-manifest.json` üretir (sha256 + boyut).
4. Hepsini Bitbucket Downloads'a ya da `v<version>` (veya `<version>`) etiketli GitHub Release'e yükler.
5. Başarısızsa non-zero çıkar: IDP release'i `failed` yapar ve manifest okumaz.

Manifest üreten küçük bir script (repo içinde `scripts/make-manifest.js`):

```js
// node scripts/make-manifest.js <artifactName> <version> <commit> <component>:<os>:<file> ...
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const [project, version, commit, ...entries] = process.argv.slice(2);
const artifacts = entries.map((entry) => {
  const [component, os, file] = entry.split(':');
  const data = fs.readFileSync(file);
  return { component, os, file: path.basename(file), size: data.length,
           sha256: crypto.createHash('sha256').update(data).digest('hex') };
});
fs.writeFileSync(`${project}-${version}-manifest.json`,
  JSON.stringify({ schema: 1, project, version, commit, createdAt: new Date().toISOString(), artifacts }, null, 2));
```

### 4.1 Bitbucket Pipelines (custom pipeline)

IDP ayarı: `build.provider: pipeline`, projenin `ciConfig.pipeline: release`, `artifactDeploy.source.platform:
bitbucket`. Downloads'a yükleme için repository'de `BB_UPLOAD_TOKEN` (secured) değişkeni: `repository:write`
scope'lu Repository Access Token.

```yaml
pipelines:
  custom:
    release:
      - variables:
          - name: VERSION          # IDP doldurur (versionVariable)
      - parallel:
          - step:
              name: Backend (win-x64)
              runs-on: [self.hosted, windows]   # native modüller (bcrypt) Windows x64'te derlenmeli
              script:
                - npm ci --omit=dev
                - npm run build --if-present
                - tar -czf "jetsrm-backend-$env:VERSION-win-x64.tar.gz" --exclude=.git --exclude=.env -C . .
              artifacts: ["jetsrm-backend-*.tar.gz"]
          - step:
              name: Frontend
              image: node:22
              script:
                - npm ci
                - npm run build             # runtime config: config.js / window.__ENV__
                - tar -czf "jetsrm-frontend-$VERSION.tar.gz" -C dist .
              artifacts: ["jetsrm-frontend-*.tar.gz"]
      - step:
          name: Manifest + upload
          image: node:22
          script:
            - node scripts/make-manifest.js jetsrm "$VERSION" "$BITBUCKET_COMMIT"
                "backend:win-x64:jetsrm-backend-$VERSION-win-x64.tar.gz"
                "frontend:any:jetsrm-frontend-$VERSION.tar.gz"
            - for f in jetsrm-*-"$VERSION"*.tar.gz "jetsrm-$VERSION-manifest.json"; do
                curl -sSf -X POST -H "Authorization: Bearer $BB_UPLOAD_TOKEN"
                  "https://api.bitbucket.org/2.0/repositories/$BITBUCKET_WORKSPACE/$BITBUCKET_REPO_SLUG/downloads"
                  -F "files=@$f";
              done
```

Notlar: Bitbucket Downloads aynı adlı dosyayı üzerine yazar; aynı sürümü yeniden build etmek önceki artifact'ı
değiştirir (IDP re-import ile yeni sha'yı alır). Windows runner'da script PowerShell'dir (`$env:VERSION`).
Manuel adım ya da onay koymayın: onay noktası IDP'dir (bkz. `docs/CI-PIPELINE.md` §7).

### 4.2 GitHub Actions (workflow_dispatch)

IDP ayarı: `build.provider: pipeline`, `ciConfig.platform: github`, `ciConfig.pipeline: release.yml`,
`artifactDeploy.source.platform: github`. Input adı `versionVariable` ile aynı olmalı.

```yaml
name: Release
run-name: Release ${{ inputs.VERSION }}
on:
  workflow_dispatch:
    inputs:
      VERSION: { required: true, type: string }
permissions:
  contents: write
jobs:
  backend:
    runs-on: windows-latest            # bcrypt vb. native modüller için win-x64
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci --omit=dev
      - run: tar -czf "jetsrm-backend-${{ inputs.VERSION }}-win-x64.tar.gz" --exclude=.git -C . .
      - uses: actions/upload-artifact@v4
        with: { name: backend, path: "jetsrm-backend-*.tar.gz" }
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build && tar -czf "jetsrm-frontend-${{ inputs.VERSION }}.tar.gz" -C dist .
      - uses: actions/upload-artifact@v4
        with: { name: frontend, path: "jetsrm-frontend-*.tar.gz" }
  publish:
    needs: [backend, frontend]
    runs-on: ubuntu-latest
    env:
      VERSION: ${{ inputs.VERSION }}
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { merge-multiple: true }
      - run: >
          node scripts/make-manifest.js jetsrm "$VERSION" "$GITHUB_SHA"
          "backend:win-x64:jetsrm-backend-$VERSION-win-x64.tar.gz"
          "frontend:any:jetsrm-frontend-$VERSION.tar.gz"
      - run: >
          gh release create "v$VERSION" --target "$GITHUB_SHA" --title "v$VERSION"
          jetsrm-*-"$VERSION"*.tar.gz "jetsrm-$VERSION-manifest.json"
```

IDP release'i önce `v<version>`, sonra `<version>` etiketiyle arar. IDP'nin kaynak token'ı (fine-grained PAT):
**Contents: Read** yeterli (release + asset okuma); build'i tetikleyen `ciConfig` token'ı ayrıca **Actions: Read
and write** ister.

### 4.3 Jenkins

- `build.provider: jenkins`; projenin `url`, `jobName`, `username`, `apiToken` alanları kullanılır. IDP job'ı
  `buildWithParameters` ile `<versionVariable>=<version>` parametresiyle tetikler; job bu adla bir **String
  Parameter** tanımlamalı. Ref geçersiz kılma (`ref`) Jenkins'te desteklenmez.
- Windows backend için job bir **Windows x64 agent**'ta koşmalı (native modüller).
- Job artifact'ları Jenkins'te bırakmaz: yukarıdaki gibi `make-manifest.js` ile manifest üretip Bitbucket
  Downloads'a (`curl ... -F files=@...`) ya da GitHub Release'e (`gh release create`) yükler. IDP artifact'ları
  **yalnız** Bitbucket Downloads / GitHub Release assets'ten okur.

## 5. Deploy hedefleri

Bir hedef = bir müşteri sunucusu = bir agent. Bir agent yalnızca bir hedefe bağlanabilir (`agent_id` UNIQUE),
agent'ın gateway'de kayıtlı olması gerekir (önce `POST /api/agents/:id/credentials`).

```json
POST /api/projects/:id/targets
{ "name": "temsa-prod", "agentId": "TEMSA-WIN-01", "os": "windows", "environment": "Prod",
  "components": [ { "name": "backend", "runtime": { "type": "nssm", "serviceName": "temsa-backend" },
                    "health": { "url": "http://127.0.0.1:4000/health" } }, { "name": "frontend" } ],
  "runtimeConfig": { "VITE_APP_MAIN_URL": "https://api.temsa.example", "VITE_COMPANY_NAME": "temsa" } }
```

| Alan | Açıklama |
|---|---|
| `name` | 1–120 karakter |
| `agentId` | gateway'deki agent ID'si |
| `os` | `windows` \| `linux`: artifact seçimini belirler (`win-x64`/`linux-x64`, yoksa `any`) |
| `environment` | `Dev` \| `Stage` \| `Prod` \| `null`. **Prod** ise (ya da hedef adı `prod` içeriyorsa, ya da ortam boş ve proje Prod ise) deploy ve rollback `confirmation` = hedef adı ister (T-51 ile aynı 400 gövdesi) |
| `components` | Opsiyonel: bu sunucuda deploy edilecek bileşenler + sunucuya özel `runtime`/`health` override'ı. Boşsa projenin tüm bileşenleri |
| `runtimeConfig` | `config.js`'e yazılacak anahtarlar (`^[A-Z][A-Z0-9_]*$`, değer ≤ 2000, en çok 100). Tarayıcıya servis edilir: **sır koymayın** |
| `basePath`, `currentVersions`, `currentReleaseId` | Bilgi amaçlı; `POST /api/targets/:id/refresh-status` agent'tan (`artifact_status`) doldurur, başarılı deploy günceller |

## 6. Deploy akışı

1. `POST /api/targets/:id/deploy {releaseId, components?, confirmation?}`: release `ready` olmalı, hedefin
   projesine ait olmalı. Her bileşen için artifact seçilir; eksikse 400.
2. **Hedef başına kilit**: aynı hedefte ikinci deploy/rollback 409. Agent çevrimdışıysa 409.
3. DeploymentManager oturumu açılır (`kind: artifact_deploy`); loglar mevcut SSE'den akar
   (`/api/deploy/logs/:deploymentId`), satırlar `[Deploy] …` önekli. Yanıt: `202 {deploymentId, deployId, sseUrl, eventsUrl}`.
4. Bileşen başına indirme token'ı üretilir, payload gateway'e `POST /agent/artifact-command/:agentId` ile gider.
5. `deploy_event` → log satırı + `deployment_events` satırı (%10 adımlı ilerleme) + SSE `__EVENT__`
   (`artifact_deploy_event`). `GET /api/deployments/:id/events` saklı olayları döner.
6. `deploy_result` → `succeeded` / `failed`; başarıda hedefin `currentVersions` ve `currentReleaseId`'si güncellenir.
   Token'lar silinir, kilit bırakılır.
7. **Zaman aşımı**: `timeoutSec + 60 sn` içinde sonuç gelmezse deploy `failed` olur ve agent'a `artifact_cancel`
   gönderilir (sunucu durumu belirsiz: `refresh-status` çalıştırın).
8. **İptal**: mevcut `POST /api/deploy/:deploymentId/abort` (`deploy:abort`) → agent'a `artifact_cancel`. Oturum
   `aborted` olur ama kilit agent'ın terminal sonucuna kadar tutulur (agent geri alıyor olabilir). İptal geç
   kalıp deploy yine de tamamlanırsa sonuç `succeeded` olarak kaydedilir.
9. **Rollback**: `POST /api/targets/:id/rollback {components?, confirmation?}` → `artifact_rollback`
   (`kind: artifact_rollback`); başarıdan sonra hedef durumu agent'tan yenilenir.
10. Backend ile gateway arasındaki abonelik koparsa artan beklemeyle yeniden bağlanılır; aradaki olaylar
    kaybolabilir, terminal sonuç yine beklenir.

## 7. API uçları

| Uç | Yetki | Not |
|---|---|---|
| `GET /api/projects/:id/releases` | `project:read` | |
| `POST /api/projects/:id/releases` `{version, ref?}` | `release:create` (deployer) | 202 + build `deploymentId` (SSE). `ref` yalnız pipeline build |
| `POST /api/projects/:id/releases/import` `{version}` | `release:create` | manifest'i okur; yeniden import artifact id'lerini korur |
| `GET /api/releases/:id` | `project:read` | release + artifact'lar |
| `DELETE /api/releases/:id` | `release:delete` (admin) | yalnız DB satırları |
| `GET /api/projects/:id/targets` | `project:read` | |
| `POST /api/projects/:id/targets` · `PUT/DELETE /api/targets/:id` | `project:write` (admin) | |
| `POST /api/targets/:id/refresh-status` | `deploy:trigger` | `artifact_status` |
| `POST /api/targets/:id/deploy` | `deploy:trigger` | `IDP_PUBLIC_URL` yoksa 503 |
| `POST /api/targets/:id/rollback` | `deploy:trigger` | |
| `GET /api/deployments/:id/events` | `project:read` | |
| `POST /api/deploy/:id/abort` | `deploy:abort` | iptal (mevcut uç) |
| `GET /api/artifacts/:artifactId/download` | indirme token'ı | oturum yok |

Release/import/deploy/rollback/refresh IP başına 20 istek/dk ile sınırlıdır. Audit: `RELEASE_CREATED`,
`RELEASE_BUILD_SUCCEEDED|FAILED`, `RELEASE_IMPORTED|IMPORT_FAILED`, `RELEASE_DELETED`,
`DEPLOY_TARGET_CREATED|UPDATED|DELETED`, `ARTIFACT_DEPLOY_TRIGGERED|SUCCEEDED|FAILED|CANCEL_REQUESTED|CANCELLED`,
`ARTIFACT_ROLLBACK_*`, `ARTIFACT_DOWNLOADED|DOWNLOAD_REJECTED|DOWNLOAD_FAILED`.

**Masaüstü yerel (IPC) mod:** artifact deploy desteklenmez. Agent'ların indirme yapabileceği public bir backend
gerekir; masaüstü uygulamasını **uzak modda** (remote backend, HTTPS) kullanın. IPC tarafında bu uçların karşılığı
yoktur.

## 8. `IDP_PUBLIC_URL` ve dışarı açma

`backend/.env`:

```
IDP_PUBLIC_URL=https://idp.<alan>
```

- Agent'ların backend'e ulaştığı public taban adres; indirme URL'si `<IDP_PUBLIC_URL>/api/artifacts/<id>/download`.
  Yol öneki olabilir (`https://<alan>/idp`). Kullanıcı adı/parola, `?` ya da `#` içeremez.
- `NODE_ENV=production` iken **https zorunlu** (agent indirme token'ını bu adrese gönderir). Boş ya da geçersizse
  sunucu yine açılır, açılışta uyarı basılır ve `POST /api/targets/:id/deploy` 503 döner.
- Dışarıya **yalnızca** `GET /api/artifacts/<id>/download` yolunu açmak yeterlidir. Ters proxy / tünelde yol
  kuralı örneği (regex): `^/api/artifacts/[A-Za-z0-9_]+/download$`, geri kalan her şey 404. TLS önde sonlanır.
  Tüm API'yi (uzak masaüstü modu için) açıyorsanız `IDP_COOKIE_SECURE=true` ve TLS şarttır
  (`deploy/agent-public-endpoint.md`).
- Proxy `Authorization` başlığını backend'e iletmeli ve yanıtı tamponlamamalı (büyük dosyalar; ör. nginx
  `proxy_buffering off`, IIS ARR response buffer threshold 0).

## 9. Güvenlik

- **Repo token'ı** (`artifactDeploy.source.token` ya da `apiToken`) yalnız backend'de, şifreli saklanır; yalnız
  yapılandırılmış `https://` API host'una gönderilir; yönlendirmelerde depolama host'una gönderilmez; log ve hata
  mesajlarından ayıklanır.
- **Payload'daki tek sır** bileşen başına indirme token'ıdır; token'lar loglanmaz, audit'e yazılmaz, yalnız
  hash'leri saklanır, 30 dk / 5 kullanım / artifact bağı / deploy bitince silme ile sınırlıdır.
- Gateway `artifact-command` ucu: yalnız loopback kontrol dinleyicisi, kontrol token'ı zorunlu, `process` izin
  listesi, JSON nesne payload, en çok 256 KB, payload loglanmaz (yalnız agent id, process, deployId).
- Agent tarafı yol güvenliği: `subdir` ve preserve desenleri `deploy.base-path` içinde çözülür; arşivde mutlak
  yol, `..`, symlink/hardlink reddedilir (bkz. `idp-agent/ARTIFACT-DEPLOY-AGENT.md`).
- Hook'lar yalnız admin ayarından, kabuksuz argüman listesiyle; deploy anında hook/variable enjekte edilemez.
  Build'e giden tek sunucu tarafı değer sürümdür.
- Agent mesajları ayıklanır (uzunluk sınırı, kontrol karakteri yok, bilinmeyen stage/status `unknown`).

## 10. JetSRM notları

- **Backend (Node.js, NSSM servisi):** `node_modules` hedefte kurulmaz, build'de **Windows x64** üzerinde
  (`bcrypt` native modülü) Windows runner ya da Windows'ta Jenkins ile üretilir. Lockfile (`package-lock.json`)
  repoda izlenmeli, build `npm ci` kullanmalı.
- NSSM servisinin `AppDirectory`'si = backend kökü (`C:/inetpub/wwwroot/jetsrm/backend`); servis adı
  `runtime.serviceName` ile aynı.
- `NODE_ENV` = `prod` olmalı (hem servis ortamında hem migrate hook'unda).
- Preserve: `.env`, `certificates/**`, göreli ise `uploads/**`. Öneri: `UPLOAD_BASE_PATH`'i deploy klasörünün
  **dışında** mutlak bir yola alın (sürüm klasörleri arasında taşınmaz, yedeği ayrı alınır).
- Migration'lar açılışta çalışmaz: `migrate` preStart hook'u (§3.2) ve rollback uyarısı geçerlidir.
- `/health` sürüm döndürmüyor (`{type:true,message}`), bu yüzden `expectVersionPath` **boş** bırakılır; health
  yalnız 200 kontrol eder.
- **Frontend (IIS statik):** site fiziksel yolu `…/jetsrm/frontend` olmalı, **asla** proje kökü değil (yoksa
  `.releases/`, `agent/`, `backend/.env` web'den erişilebilir olur). `web.config` preserve edilir, `config.js`'i IDP
  yazar (`writeRuntimeConfig: true`).
- IIS **ARR reverse proxy** backend'e yönlendirir; socket.io için IIS'te **WebSocket Protocol** özelliği açık ve
  ARR'de WebSocket etkin olmalı.

## 11. Operatör kontrol listesi

| Nerede | Ayar |
|---|---|
| `backend/.env` | `IDP_PUBLIC_URL=https://idp.<alan>` (production'da https) |
| `backend/.env` | `IDP_AGENT_API_URL=http://127.0.0.1:7004`, `IDP_AGENT_API_TOKEN=<gateway ile aynı>` (mevcut) |
| `backend/.env` | `IDP_SECRET_KEY` (kaynak token'ı şifreli saklansın diye; mevcut) |
| Ters proxy / tünel | Yalnız `/api/artifacts/*/download` dışarı (ya da tüm API TLS + `IDP_COOKIE_SECURE=true`), `Authorization` iletilir, tamponlama kapalı |
| Gateway | Güncel `idp-agent-gateway` (yeni `artifact-command` ucu ve iletilen process'ler) |
| Proje ayarı | `artifactDeploy` (kaynak, build, bileşenler, hook'lar) |
| Kaynak token'ı | Bitbucket: Downloads okuma (`repository` read); GitHub: Contents: Read |
| Build job | §4 sözleşmesi, sürüm değişkeni `versionVariable` ile aynı adla |
| Agent | `deploy.base-path` (zorunlu), `deploy.keep-releases` (bkz. agent belgesi); agent kimliği üretilmiş ve hedef oluşturulmuş |
