# IDP — CI Pipeline Provider (Bitbucket Pipelines / GitHub Actions)

> Son güncelleme: 2026-09-11 · Kapsam: `backend/src/adapters/CiPipelineAdapter.js`, `backend/src/adapters/ci/`
> İlgili: `backend/src/core/diagnostics/checks/ciPipeline.js`, `backend/test/ci-pipeline-*.test.js`

## 1. Ne yapar

`CI Pipeline` (`project.provider = 'Pipeline'`) provider'ı hedef sunucuya **bağlanmaz**. IDP bunun
yerine bir CI pipeline'ını tetikler:

- **Bitbucket Pipelines:** `bitbucket-pipelines.yml` içindeki bir **custom pipeline**
- **GitHub Actions:** `workflow_dispatch` tetikleyicisi olan bir **workflow**

IDP pipeline'a projenin değişkenlerini geçer, çalışmanın durumunu ve loglarını IDP'nin mevcut canlı
log akışına (SSE/IPC) taşır, deploy iptal edilirse (abort) pipeline'ı da durdurur. Onay tıklaması,
RBAC, audit kaydı, canlı log ve abort IDP'de kalır; asıl deploy işini pipeline yapar. Hedef işletim
sistemi (Windows/IIS, Linux/nginx...) pipeline'ın sorumluluğundadır, IDP'nin değil.

## 2. Ne zaman kullanılır

| Durum | Önerilen provider |
|---|---|
| Deploy mantığı zaten Bitbucket/GitHub pipeline'ında duruyor | **CI Pipeline** |
| Hedef sunucuya IDP makinesinden doğrudan erişim yok (VPN/ağ kısıtı), ama CI runner'ı erişebiliyor | **CI Pipeline** |
| Aynı pipeline farklı müşteriler için farklı değişkenlerle çalışıyor | **CI Pipeline** (müşteri başına proje) |
| IDP'nin hedefe SSH/WinRM ile bağlanıp script çalıştırması isteniyor | Server (SSH/WinRM) |
| Jenkins job'u tetiklenecek | Jenkins |

Mevcut provider'ların (Jenkins, PMP, Server/SSH/WinRM, idp-agent) hiçbiri değişmedi; hepsi yan yana
kullanılabilir. Provider proje bazında seçilir.

### Müşteri başına proje deseni

Tek bir pipeline'ı birden çok müşteri için kullanıyorsanız, **her müşteri için ayrı bir IDP projesi**
açın. Hepsi aynı repo/pipeline'ı gösterir, sadece değişkenleri farklıdır:

| IDP projesi | `variables` |
|---|---|
| Temsa — Prod | `CUSTOMER=temsa`, `BRAND=temsa`, `VERSION=2.5.0` |
| Müşteri B — Prod | `CUSTOMER=b`, `BRAND=b`, `VERSION=2.4.1` |

Böylece her müşterinin deploy geçmişi, yetkisi, audit kaydı ve son durumu ayrı tutulur.

## 3. Ayar alanları

Ayarlar `project.config.ciConfig` altında tutulur. Token ve e-posta mevcut ortak alanlardan gelir.

| Alan | Zorunlu | Açıklama |
|---|---|---|
| `platform` | Evet | `bitbucket` veya `github` |
| `baseUrl` | Hayır | API adresi. Boşsa `https://api.bitbucket.org/2.0` / `https://api.github.com`. GitHub Enterprise: `https://HOST/api/v3`. Sadece `https://` kabul edilir: token her istekte gider, düz HTTP'den asla gönderilmez |
| `owner` | Evet | Bitbucket workspace slug'ı / GitHub owner veya organizasyon |
| `repo` | Evet | Repo slug'ı / adı |
| `refType` | Hayır | Sadece Bitbucket: `branch` (varsayılan) veya `tag` |
| `ref` | Evet | Branch veya tag adı, örn. `master`, `v2.5.0` (GitHub `ref` ikisini de kabul eder) |
| `pipeline` | Evet | Bitbucket: custom pipeline adı. GitHub: workflow dosya adı (`deploy.yml`) veya numerik id |
| `variables` | Hayır | `ANAHTAR: değer` çiftleri. Anahtar `^[A-Za-z_][A-Za-z0-9_]*$`, en fazla 100 karakter; `__proto__`, `constructor`, `prototype` kullanılamaz. Değer en fazla 2000 karakter, en fazla 25 değişken. Sadece proje ayarlarından gelir (bkz. §8) |
| `authType` | Hayır | Sadece Bitbucket: `bearer` (Access Token, varsayılan) veya `basic` (Atlassian e-posta + API token). GitHub her zaman bearer |
| `pollIntervalSeconds` | Hayır | Durum sorgulama aralığı. Varsayılan 10, en az 3, en fazla 60 |
| `timeoutMinutes` | Hayır | IDP'nin pipeline'ı izleme süresi. Varsayılan 60, en az 1, en fazla 720 |
| `correlationInput` | Hayır | Sadece GitHub: eski GHES sürümleri için run eşleştirme input'unun adı (bkz. §6) |
| `config.username` | Koşullu | Bitbucket `basic` auth'ta Atlassian hesabının **e-posta adresi** |
| `config.apiToken` | Evet | Token. Diğer provider'lardaki gibi şifreli saklanır, API yanıtlarında asla dönmez |

- Proje oluşturulurken bu alanlar zorunlu tutulmaz; eksik alanlar deploy anında ve "Test Connection"da
  açık bir hata olarak listelenir (örn. `missing: owner, ref, apiToken`).
- Formda boş bırakılan alan (`''`) "ayarlanmamış" demektir; varsayılan değer uygulanır.
- Kaydetme sırasında `ciConfig` bir bütün olarak değiştirilir: formdan silinen bir değişken gerçekten
  silinir.

### Ortam (environment) override'ları

`config.environments.<Ortam>.ciConfig` ile ortam bazında alan ezilebilir (örn. Prod için farklı `ref`).
Birleştirme **tek seviye derinliktedir**: override'da olmayan veya boş bırakılan alan temel ayardan
gelir. Override'da `variables` verilirse temel `variables` haritasının **tamamının yerine geçer**.
Ortam override'ında ayrı bir `apiToken` da tanımlanabilir.

## 4. Token kurulumu

### Bitbucket

> **Not:** Bitbucket app password'leri **2026-07-28** itibarıyla çalışmıyor. Aşağıdaki iki yoldan birini
> kullanın.

1. **Access Token (önerilen, `authType: bearer`):** Repository, Project veya Workspace Access Token
   oluşturun. Gereken scope'lar: **`pipeline`** ve **`pipeline:write`**. `username` boş kalır.
2. **Atlassian API token (`authType: basic`):** Kişisel Atlassian API token'ı (scoped) oluşturun.
   Scope'lar: **`read:pipeline:bitbucket`**, **`write:pipeline:bitbucket`** ve `bitbucket-pipelines.yml`
   kontrolü için **`read:repository:bitbucket`**. `username` alanına Atlassian hesabının **e-posta
   adresini** yazın (Bitbucket kullanıcı adını değil).

### GitHub

- **Fine-grained PAT (önerilen):** ilgili repo için **Actions: Read and write** ve (ön kontrolde
  workflow dosyasını okumak için) **Contents: Read**.
- **Classic PAT:** `repo` scope'u.

## 5. Örnek: Bitbucket custom pipeline

IDP'nin gönderdiği her değişkeni custom pipeline'da `variables:` altında tanımlayın:

```yaml
pipelines:
  custom:
    deploy-customer:
      - variables:
          - name: CUSTOMER
          - name: VERSION
            default: "2.5.0"
      - step:
          name: Deploy
          # deployment: production   # Bitbucket deployment concurrency pipeline'ı bekletebilir (bkz. §7)
          script:
            - echo "Deploying $VERSION for $CUSTOMER"
            - ./deploy.sh "$CUSTOMER" "$VERSION"   # yer tutucu: gerçek deploy adımınız
```

IDP'deki ayarlar: `platform: bitbucket`, `owner: <workspace>`, `repo: <repo>`, `ref: master`,
`pipeline: deploy-customer`, `variables: { CUSTOMER: temsa, VERSION: 2.5.0 }`.

## 6. Örnek: GitHub Actions workflow

IDP değişkenleri `workflow_dispatch` **input'ları** olarak gönderilir; her değişken workflow'da input
olarak tanımlı olmalıdır, yoksa GitHub `422 Unexpected inputs provided` döner (IDP bunu açıkça belirtir).
GitHub'ın bir workflow için kabul ettiği input sayısı sınırlıdır; `correlationInput` da bu sayıya dahildir.

```yaml
name: Deploy
run-name: Deploy ${{ inputs.customer }} ${{ inputs.version }} ${{ inputs.idp_correlation_id }}

on:
  workflow_dispatch:
    inputs:
      customer:
        required: true
        type: string
      version:
        required: true
        type: string
      idp_correlation_id:
        description: IDP tarafından doldurulur, elle girmeyin
        required: false
        type: string

jobs:
  deploy:
    runs-on: ubuntu-latest   # veya self-hosted / windows-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy
        env:
          CUSTOMER: ${{ inputs.customer }}   # input'ları doğrudan run: içine gömmek yerine env ile geçin
          VERSION: ${{ inputs.version }}
        run: ./deploy.sh "$CUSTOMER" "$VERSION"   # yer tutucu
```

IDP'deki ayarlar: `platform: github`, `owner: <org>`, `repo: <repo>`, `ref: main`,
`pipeline: deploy.yml`, `variables: { customer: temsa, version: 2.5.0 }`.

**Run eşleştirme:** GitHub, `return_run_details` desteğiyle (2026-02-19'dan beri) dispatch yanıtında
run id'yi döner; IDP bunu doğrudan kullanır. Bu parametreyi tanımayan eski **GitHub Enterprise Server**
sürümlerinde yanıt `204` olur ve IDP run'ı liste üzerinden bulmak zorunda kalır:

- `correlationInput` ayarlıysa (örnekteki `idp_correlation_id`), IDP bu input'a benzersiz bir id yazar ve
  `run-name` içinde bu id'yi taşıyan run'ı seçer. Workflow `run-name` satırında input'u kullanmalıdır.
- Ayarlı değilse IDP run'ı tahminle bulur. Aday sayılan run'lar: dispatch isteğinden hemen önce kaydedilen
  andan sonra (saat farkı için 2 sn pay) oluşmuş ve bu IDP sürecindeki başka bir deploy'un zaten sahiplendiği
  run'lar dışındakiler. **Tek aday** varsa o seçilir ve logda eşleşmenin **tahmini** olduğu yazılır.
  **Birden fazla aday** varsa (aynı workflow ve ref aynı anda birden çok kez tetiklendiyse) IDP tahmin
  etmez: deploy `run could not be identified unambiguously` hatasıyla başarısız olur ve GitHub Actions
  sayfasının linkini verir. Bu durumda IDP hiçbir run'ı izlemez ve iptal etmez. Workflow büyük olasılıkla
  çalışıyordur, GitHub'da kontrol edin. Aynı workflow'u paylaşan müşteri başına projelerde
  `correlationInput` kullanın.

## 7. Çalışma semantiği

- **Onay noktası IDP'dir.** IDP'nin tetiklediği pipeline'da **manuel adım, "required reviewers" veya
  environment onayı olmamalı**. Olursa pipeline bekler; IDP logda bir kez
  `⏸ Pipeline paused ...` (Bitbucket) / `⏸ Waiting for environment approval in GitHub.` yazar ve
  timeout dolana kadar izlemeye devam eder. Bitbucket'ta aynı deployment ortamına eşzamanlı başka bir
  deploy (deployment concurrency) de pipeline'ı bekletebilir.
- **Timeout pipeline'ı iptal etmez.** `timeoutMinutes` dolarsa IDP izlemeyi bırakır, deploy'u başarısız
  sayar ve pipeline linkini verir; pipeline çalışmaya devam eder.
- **Abort pipeline'ı iptal eder.** IDP'de deploy durdurulunca Bitbucket'ta `stopPipeline`, GitHub'da
  run `cancel` çağrılır (`■ Cancel requested for pipeline #N`). Pipeline zaten bitmişse bu hata sayılmaz.
- **IDP dışından iptal:** Pipeline Bitbucket/GitHub arayüzünden durdurulursa deploy
  `was cancelled outside IDP` hatasıyla başarısız olur.
- **Loglar:** Bitbucket'ta adım logları **canlı** akar. GitHub'ın canlı log API'si yoktur: her job
  **bittikten sonra** logu bir kez indirilir; job çalışırken sadece adım ilerleme satırları görünür
  (`▶ build › npm ci`, `✓ build › npm ci (12s)`). Her durumda loglar `[CI]` önekiyle gelir. Run biterken
  henüz arşivlenmemiş bir log (HTTP 404) ilk 404'ten sonra ~30 sn boyunca, birkaç saniye arayla yeniden
  denenir.
- **Tetikleme isteği idempotent değildir.** Tetikleme isteği zaman aşımına uğrarsa veya yanıtı okunamazsa
  IDP deploy'u `Failed to trigger ...` hatasıyla başarısız sayar, ama pipeline yine de başlamış olabilir.
  Yeniden deploy etmeden önce Bitbucket/GitHub'da çalışan bir run olup olmadığını kontrol edin, yoksa aynı
  deploy iki kez çalışabilir.
- **Eski GHES, `correlationInput` yok:** run belirsiz kalırsa (bkz. §6) deploy tahmin yürütmek yerine
  hatayla biter. Workflow büyük olasılıkla çalışıyordur, GitHub'da kontrol edin.
- **Geçici hatalar** (ağ, 5xx, 429): artan beklemeyle tekrar denenir; üst üste 5 hatada deploy başarısız
  olur (pipeline iptal edilmez). 401/403/404 hemen hata verir.
- **Rate limit:** Bitbucket'ta token başına saatlik istek kotası 1000'e kadar düşebilir. IDP bir adım
  çalışırken durum sorgusunu seyrekleştirir ve `X-RateLimit-NearLimit` görürse sorgu aralığını ikiye
  katlar. Aynı token'la çok sayıda eşzamanlı deploy yapıyorsanız `pollIntervalSeconds` değerini
  artırın. GitHub'da PAT kotası (5000/saat) normal kullanım için yeterlidir.

## 8. Sırlar

- IDP değişkenleri **gizli değildir**: pipeline arayüzünde ve loglarında görünür. Parola, anahtar gibi
  sırları IDP değişkenine koymayın; Bitbucket **secured repository/deployment variables** veya GitHub
  **secrets/environment secrets** içinde tutun.
- Token IDP'de şifreli saklanır. Log satırlarından, akış satırlarından ve hata mesajlarından token (ve
  Basic auth için üretilen base64 kimlik bilgisi) temizlenir.
- IDP loglarına sadece değişken **anahtarları** yazılır, değerleri yazılmaz.
- Değişkenler **sadece proje ayarlarından** gelir (`ciConfig.variables`, ortam override'ı birleştirilmiş
  hâliyle). Deploy tetiklenirken gönderilen parametrelerin hiçbiri, `variables` dahil, pipeline'a
  gönderilmez ve loglanmaz. Değişkenler yalnızca proje düzenlenerek (admin) değiştirilebilir, tetikleme
  anında asla değiştirilemez. Böylece deploy yetkisi olan bir kullanıcı müşteri A'nın pipeline'ına
  `CUSTOMER=B` gönderemez.

## 9. Test Connection

Proje ayarlarındaki "Test Connection" hiçbir pipeline'ı tetiklemeden şunları kontrol eder:

| Bitbucket | GitHub |
|---|---|
| Repo erişimi (token geçerli mi, repo görünüyor mu) | Repo erişimi |
| Pipeline okuma yetkisi | Workflow var mı ve `active` mi |
| `bitbucket-pipelines.yml` içinde custom pipeline adı (okunamazsa "doğrulanamadı") | Workflow dosyasında `workflow_dispatch` var mı (okunamazsa "doğrulanamadı") |

Deploy'un `connect()` aşaması da aynı kontrolleri yapar; kesin hata (auth, erişim, bulunamadı) varsa
pipeline tetiklenmeden durur.

## 10. Sorun giderme

| Belirti | Olası neden |
|---|---|
| `Authentication failed (HTTP 401)` | Token geçersiz/süresi dolmuş; Bitbucket `basic` modunda e-posta yanlış |
| `HTTP 400 ... not found` (Bitbucket tetikleme) | `pipeline` adı `custom:` altında yok veya `ref` yanlış |
| `Unexpected inputs provided` (GitHub) | Bir IDP değişkeni workflow'da input olarak tanımlı değil |
| `Workflow ... was not found (HTTP 404)` | `pipeline` alanı dosya adı olmalı (`deploy.yml`), yol değil |
| Deploy `⏸` mesajında takılı kalıyor | Pipeline'da manuel adım/onay veya deployment concurrency var (bkz. §7) |
| `still running after N min` | Pipeline `timeoutMinutes`'tan uzun sürdü; pipeline iptal edilmedi, linkten takip edin |
