# IDP — Geliştirici Kılavuzu

> Son güncelleme: 2026-08-20 · Kapsam: yerel kurulum, test/lint/CI altyapısı (T-60)
> İlgili: `docs/04-TODO.md` → T-60, `verify.sh`, `.github/workflows/`

Bu doküman, projeyi yerel makinede ayağa kaldırmak ve değişiklikleri commit
etmeden önce doğrulamak için gereken adımları özetler. `backend/` ve
`frontend/` bağımsız iki klasördür — monorepo değildir, kök dizinde ortak bir
`package.json` yoktur.

## 1. Kurulum

### Gereksinimler

- **Node.js 24** (backend `node:sqlite` ve `node --test` kullanıyor; her ikisi
  de bu sürümü şart koşuyor. Farklı bir sürümle backend testleri veya `npm ci`
  beklenmedik şekilde başarısız olabilir.)
- npm (Node ile birlikte gelir)

### Bağımlılıkları kur

```bash
cd backend && npm ci
cd ../frontend && npm ci
```

`npm ci`, `package-lock.json`'a birebir sadık kalır — `npm install`'dan farklı
olarak lockfile'ı güncellemez. Yeni bir bağımlılık eklerken `npm install
<paket>` kullanın, sonra lockfile'ı commit'e dahil edin.

### `.env` dosyası (yalnızca backend)

`backend/.env.example` dosyasını kopyalayarak başlayın:

```bash
cp backend/.env.example backend/.env
```

Sunucunun başlaması için **hiçbir env değişkeni zorunlu değildir** —
`backend/src/config.js` içindeki `CONFIG_SCHEMA` tüm alanları opsiyonel
tanımlar, provider (Jenkins/SSH/PMP) ayarları her proje için UI'dan girilir.
Ancak gerçek kullanım için aşağıdakileri doldurmanız önerilir:

| Değişken | Amaç | Zorunlu mu? |
|---|---|---|
| `IDP_SECRET_KEY` | Proje sırlarını (credential) diskte AES-256 ile şifrelemek için kullanılan base64 32-byte anahtar. Boşsa sır saklama devre dışı kalır, sırlar düz metin kalır. | Hayır, ama prod için şiddetle önerilir |
| `SESSION_SECRET` | Oturum çerezini imzalamak için. Boşsa her başlangıçta rastgele üretilir ve **her restart'ta tüm oturumlar düşer**. | Hayır, ama dev-dışı ortamlarda önerilir |
| `MFA_WEBHOOK_API_KEY` | `POST /api/mfa/webhook-otp` uç noktasını korur (SMS ileten webhook). Boşsa bu uç nokta tüm istekleri reddeder (fail-closed). | Hayır, opsiyonel özellik |
| `IDP_ADMIN_PASSWORD` | Bootstrap admin parolasını sabitler. Yalnızca `backend/src/users.json` ilk kez oluşturulurken okunur. | Hayır — boş bırakılırsa parola otomatik üretilir (bkz. aşağıdaki uyarı) |

Bu değerleri nasıl üreteceğiniz `backend/.env.example` içinde satır satır
açıklanmıştır (`node -e "console.log(require('crypto').randomBytes(32)...)"`
gibi komutlarla). **Gerçek bir değeri hiçbir zaman bu dosyaya veya git'e
commit etmeyin.**

## 2. Nasıl çalıştırılır

İki ayrı terminal:

```bash
# Terminal 1 — backend (varsayılan port 3001, --watch ile otomatik yeniden başlar)
cd backend && npm run dev

# Terminal 2 — frontend (Vite dev server)
cd frontend && npm run dev
```

### ⚠️ İlk açılış uyarısı

`backend/.env` içinde `IDP_ADMIN_PASSWORD` **ayarlı değilse**, ilk
başlangıçta `backend/src/users.json` oluşturulurken rastgele bir admin
parolası üretilir ve **yalnızca bir kez, konsola** basılır. Bu parolayı
kaydedin — bir daha gösterilmez; kaybederseniz `backend/src/users.json`
dosyasını silip sunucuyu yeniden başlatarak yeni bir parola üretmeniz
gerekir (bu, mevcut oturumları da geçersiz kılar).

### Veritabanı

Runtime verisi (projeler, audit logları, oturumlar) SQLite üzerinde tutulur:
`backend/src/idp.db`. Şema migrasyonu **otomatiktir** — sunucu her
başlangıçta `backend/src/store/migrate.js` üzerinden gerekli tabloları
oluşturur/günceller, elle bir migrasyon komutu çalıştırmanız gerekmez. Eski
JSON tabanlı veriler (`projects.json`, `audit_logs.json`) varsa bunlar da
otomatik olarak SQLite'a taşınır (idempotent — ikinci çalıştırmada tekrar
taşınmaz).

## 3. Nasıl test edilir

Kök dizinde tek komut, hem backend hem frontend'i CI ile aynı sırada
doğrular:

```bash
./verify.sh
```

Bu şu anda şunları çalıştırır (bkz. `.github/workflows/ci.yml`):

1. `backend`: `npm ci` → `npm run lint` (sözdizimi kontrolü, aşağıya bakın) → `npm test` (122 test, `node --test`)
2. `frontend`: `npm ci` → `npm run typecheck` (`tsc --noEmit`) → `npm run lint` (`oxlint`) → `npm run build` (`tsc -b && vite build`)

Güvenlik kontrollerini de (bağımlılık taraması + sızmış-secret taraması,
bkz. `.github/workflows/security.yml`) dahil etmek için:

```bash
./verify.sh --with-security
```

Bu bayrak varsayılan olarak kapalıdır çünkü `npm audit` sonucu güncel
advisory veritabanına göre değişebilir ve secret taraması, git'e hiç
girmeyen yerel/gitignore'lu dosyaları da (örn. `backend/src/projects.json`)
tarar — CI bu dosyaları hiç görmez ama yerel makinenizde gerçek bir sızıntı
varsa bunu bilerek öğrenmek istersiniz.

### Backend'de neden ESLint yok

`backend/` içinde bilinçli olarak yeni bir lint bağımlılığı eklenmedi.
`npm run lint`, `backend/scripts/check-syntax.js` çalıştırır: `src/**/*.js`
ve `test/**/*.js` altındaki her dosyaya `node --check` uygular (sözdizimi
doğrulaması, çalıştırma yapmaz) ve hatalı dosyayı satır satır raporlar.

### Frontend'de test altyapısı yok

`frontend/`'de vitest/jest kurulu değildir ve bilinçli olarak eklenmedi.
CI ve `verify.sh` bu yüzden frontend için yalnızca `typecheck` + `lint` +
`build` çalıştırır, test suite'i çalıştırmaz.

## 4. CI

`.github/` altında iki workflow vardır:

- **`ci.yml`** — her `push` ve `pull_request`'te: backend testleri +
  frontend typecheck/lint/build, paralel iki job olarak.
- **`security.yml`** — her `push`/`pull_request` ve haftalık zamanlanmış
  çalıştırmada: her iki klasörde `npm audit --audit-level=high` + repo
  genelinde sızmış-secret taraması (`backend/scripts/scan-secrets.js`).

Her iki workflow da Node 24 kullanır ve `actions/setup-node`'un `cache: npm`
özelliğiyle her klasörün kendi `package-lock.json`'una göre bağımlılık
önbelleği tutar.

## Masaüstü uygulaması ayarları

Paketlenmiş uygulama `backend/.env` dosyasını **okumaz** — o dosya pakete
kopyalanmaz (secret içerir ve derleme anında gömülü kalırdı). Finder'dan açılan
bir uygulama kabuk ortam değişkenlerini de miras almaz.

Masaüstü ayarları burada:

```
~/Library/Application Support/idp-desktop/idp.env
```

Dosya ilk açılışta yorumlu bir şablonla oluşturulur. Düzenledikten sonra
uygulamayı **yeniden başlat**. Ortamda zaten tanımlı bir değişken dosyadakini
ezer (terminalden hata ayıklarken işe yarar).

Aynı dizinde uygulamanın verisi de durur — güncelleme ve yeniden kurulumdan
etkilenmez:

| Dosya | İçerik |
|---|---|
| `idp.env` | ayarlar |
| `idp.db` | projeler, deploy geçmişi, denetim kaydı |
| `users.json` | hesaplar (scrypt hash) |
| `secrets.safestorage.json` | kimlikler (OS keychain ile şifreli) |

### Otomatik OTP yakalama

`idp.env` içinde `MFA_WEBHOOK_API_KEY` tanımlıysa uygulama LAN'a küçük bir
dinleyici açar ve açılışta telefona verilecek adresi yazar. Tanımlı değilse
**hiç port açılmaz**.

Telefondaki SMS yönlendirici şu gövdeyi göndermeli:

```json
{ "apiKey": "<idp.env'deki değer>", "text": "<sms metni>" }
```

`sessionId` göndermek gerekmez: tek bir deployment kod bekliyorsa eşleştirme
tekildir. Birden fazla deployment beklerken etiketsiz kod **reddedilir** —
kodun yanlış tünele gitmesi kabul edilebilir bir risk değil.
