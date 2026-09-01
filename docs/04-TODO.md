# IDP — Geliştirme TO-DO

> Çalışma dokümanı. Bir madde bitince `[ ]` → `[x]`.
> Sütunlar: **Etki** (ne kazanıyoruz) · **Boyut** (S ≈ 1 saat, M ≈ yarım gün, L ≈ 1+ gün)
> İlgili analizler: `02-GUVENLIK-ANALIZI.md`, `03-ELECTRON-MIMARI.md`

---

## FAZ 0 — ACİL (bugün, kod yazmadan önce)

- [x] **T-01** `backend/src/projects.json` ve `audit_logs.json`'ı `.gitignore`'a ekle,
      örnek şablon olarak `projects.example.json` bırak — **S** — SEC-01
- [x] **T-02** `projects.json` temizliği — **kapsamı değişti.** Canlı dosyayı şimdi boşaltmak
      geliştirme ortamını kırar ve diskteki düz metin sorununu zaten çözmez. Git sızıntısı
      riski T-01 ile kapandı (gitignore + sanitize edilmiş `projects.example.json`).
      Gerçek temizlik T-10 ile YAPILDI: 10 secret şifreli store'a taşındı,
      `projects.json` artık sadece `secret://` referansı tutuyor. — SEC-01
- [ ] **T-03** ⚠️ **Sızmış kimlikleri rotate ettir**: Fortinet/GlobalProtect VPN parolaları,
      SSH `deployer` parolası, Jenkins API token'ı, **ve `scriptContent` içine gömülü
      canlı GitHub PAT (`ghp_…`)**. *Bu bir kod işi değil, operasyon işi —
      geciktirilmemeli.* — **S** — SEC-01
- [x] **T-04** `GET /api/projects` cevabından secret alanlarını çıkar
      (`password`, `apiToken`, `pmpConfig.authToken`, `vpnConfig.password` →
      `hasPassword: true` şeklinde) — **S** — SEC-01
- [x] **T-05** `POST /api/vpn/grant-permissions` endpoint'ini **tamamen kaldır**;
      UI'daki "Grant System VPN Permissions" butonunu sil; sudo yapılandırmasını
      `docs/SETUP.md`'ye taşı — **S** — SEC-02, SEC-08

---

## FAZ 1 — GÜVENLİK SERTLEŞTİRME

- [x] **T-10** `SecretStore` soyutlaması (`get`/`set`/`delete`); config'de secret yerine
      referans tut; dev implementasyonu AES-GCM + `.env` anahtarı — **L** — SEC-01, Electron E1
- [x] **T-11** Kimlik doğrulama: kullanıcı tablosu + argon2 hash; session secret `.env`'den
      (yoksa başlatma reddedilsin); kalıcı session store; `secure`+`sameSite` — **M** — SEC-04
- [x] **T-12** PMP `new Function` kaldır → whitelist'li deklaratif adım yorumlayıcısı
      (`goto`/`fill`/`click`/`waitFor`) — **L** — SEC-03
- [x] **T-13** MFA webhook: API key **zorunlu** + sabit zamanlı karşılaştırma,
      `sessionId` zorunlu, varsayılan key kaldırıldı. *Karar: key tanımsızsa sunucu
      başlatmayı reddetmiyor — endpoint fail-closed olup 503 dönüyor. Gerekçe T-38 ile
      aynı: opsiyonel bir özellik tüm sunucuyu bloke etmemeli.* — SEC-05
- [x] **T-14** Secret maskeleme düzeltildi: pozisyon tabanlı maskeleme yerine **değer tabanlı
      temizleme** (`services/vpn/logScrubber.js`). Sarmalama `connect()`/`disconnect()`
      girişinde tek noktada yapılıyor, böylece sonradan eklenen log satırları da otomatik
      kapsanıyor. VPN binary'sinin geri yazdırdığı parola da temizleniyor. 11 test. — SEC-06
- [x] **T-15** Geçici dosyalar: `os.tmpdir()` altında rastgele dizin, `0600` izin,
      `finally`'de garantili silme (expect script, ovpn creds, wg conf) — **S** — SEC-06
- [x] **T-16** TLS: `rejectUnauthorized:false` varsayılanlarını kapat; "self-signed'a izin ver"
      bilinçli seçim olsun ve UI'da uyarı göstersin; `NODE_EXTRA_CA_CERTS` dokümante et — **M** — SEC-07
- [x] **T-17** SSH host key doğrulaması: proje bazında fingerprint, TOFU + uyuşmazlıkta durdur — **M** — SEC-10
- [x] **T-18** Telemetry'yi dizginle *(kısmen — proje bazlı opt-in için bkz. T-18b)*: vault sonucunu TTL cache'le, polling opsiyonel
      (varsayılan kapalı), `reason` alanını `"IDP Health Check"` yap, salt-okunur kimlik
      kullanımını dokümante et — **M** — SEC-11
- [x] **T-17b** SSH host key politikası için UI — backend hazır, frontend eksik.
      Ayarlarda `hostKeyPolicy` seçicisi (`tofu` varsayılan / `strict` / `insecure`,
      sonuncusu kırmızı uyarıyla), meşru yeniden kurulum için "bilinen anahtarı sıfırla"
      eylemi (`hostKeyRepository.forget`), ve kayıtlı parmak izlerinin salt-okunur listesi.
      *RBAC turu ayarlar ekranına dokunduğu için ertelendi.* — **S** — SEC-10
- [x] **T-18b** Telemetry'yi proje bazında opt-in yap — ayarlar ekranına
      "Sunucu telemetrisini izle" anahtarı ekle (varsayılan kapalı). Ayrıca telemetry için
      ayrı, salt-okunur ve düşük yetkili bir kimlik kullanımını dokümante et.
      *Not: Ayarlar modalı bölünürken (T-79) ertelendi, o iş bitince yapılacak.* — **S** — SEC-11
- [x] **T-34b** `DeploymentManager.pushLog` abonelere `(line, index)` göndersin.
      Şu an SSE handler'ı kendi gölge sayacını tutuyor; "bu satırın index'i nedir"
      bilgisinin tek kaynağı `DeploymentManager` olmalı. Aynı tick'te çalıştığı için
      bugün doğru ama kırılgan bir varsayım. — **S**
- [x] **T-19** Rate limit: `/api/auth/login`, `/api/mfa/webhook-otp`, `/api/deploy/trigger` — **S** — SEC-14
- [x] **T-20** Girdi doğrulaması (zod): proje oluşturma/güncelleme şeması, script boyut sınırı — **M** — SEC-15
- [x] **T-21** `forceClearAll`'ı sadece **bu uygulamanın açtığı** tünelleri kapatacak şekilde
      daralt (PID takibi) — **M** — SEC-17
- [x] **T-22** PMP hata screenshot'larını TTL ile temizle veya tamamen kapatılabilir yap — **S** — SEC-18
- [x] **T-23** `socket.io` CORS `origin:'*'` — **konusuz kaldı.** WebSocket katmanı T-41'de
      tamamen silindiği için ortada kısıtlanacak bir origin kalmadı. Doğrulandı:
      backend'de `socket.io` referansı yok. — SEC-13

---

## FAZ 2 — DOĞRULUK (çalışmayan / yanlış çalışan şeyler)

- [x] **T-30** 🔥 **SSH başarısızlığı "başarılı" görünüyor** — `SshServerAdapter.trigger()`
      exit code ≠ 0 durumunda `{status:'Failed'}` **döndürüyor, throw etmiyor**;
      `server.js` bunu görmüyor ve `succeeded` yazıyor. Adapter sözleşmesi:
      **başarısızlık her zaman throw** — **S**
- [x] **T-31** Deploy sonrası `project.status` ve `lastDeploy` güncellenmiyor →
      kartlar sonsuza dek "Idle"; `'Deploying'` durumu hiç oluşmadığı için
      **aynı projeye paralel deploy açılabiliyor**. Durum güncellemesi + proje bazlı kilit — **M**
- [x] **T-32** `VpnManager.spawnAndWait` — `context` null iken `context.timeoutId = ...`
      TypeError atıyor → **`openvpn`, `wireguard`, `ssh-jump` hiç çalışmıyor** — **S**
- [x] **T-31b** ⚠️ **WinRM hataları hâlâ "başarılı" görünebilir** — T-30 sırasında ortaya çıktı.
      `nodejs-winrm`'in `runCommand()`'i WinRM `rsp:ExitCode` alanını **hiç okumuyor**;
      sadece transport hatasını `Error` olarak, komut çıktısını string olarak döndürüyor.
      Yani stdout'a bir şey yazmadan exit code 1 ile biten bir PowerShell script'i
      adapter'a hiçbir başarısızlık sinyali vermiyor → `✓ Succeeded` yazılıyor.
      T-30'un SSH tarafı çözüldü, **WinRM tarafı açık.**
      Çözüm seçenekleri: ① script'in sonuna exit-code işaretçisi enjekte et
      (`Write-Output "IDP_EXIT:$LASTEXITCODE"`) ve çıktıdan parse et · ② `nodejs-winrm`
      yerine exit code döndüren bir kütüphaneye geç · ③ WinRM SOAP çağrısını kendimiz yapalım.
      **Öneri: ①** — en az riskli ve mevcut mimariyi bozmuyor. — **M**
- [x] **T-33** `DeploymentManager.abort()` ediliyor ama arka plandaki iş devam edip
      status'ü `succeeded/failed` ile eziyor → gerçek iptal (AbortSignal) — **M**
- [x] **T-34** SSE çift reconnect + buffer replay → **loglar ekrana iki kez basılıyor**.
      `Last-Event-ID` ile kaldığı yerden devam — **M**
- [x] **T-35** Provider tutarsızlığı: filtre çipleri `['Jenkins','SSH','PMP']` ama üretilen
      değerler `Server`/`WinRM` → **"SSH" filtresi boş, Server/WinRM projeleri filtrelenemiyor**.
      Tek `Server` provider + `targetOS` alanına indir, mevcut kayıtları migrate et — **M**
- [x] **T-36** `ProjectCard` ve `ProjectSettingsModal` map'lerinde `Server`/`WinRM` yok →
      ikonsuz rozet, başlık sadece "Settings" — **S** (T-35 ile birlikte)
- [x] **T-37** PMP "Test Connection" butonu mutlak `http://localhost:3001` kullanıyor →
      prod build'de kırılır; relative + ortak `api.ts` üzerinden — **S**
- [x] **T-38** `config.js` `JENKINS_URL`'i **global zorunlu** tutuyor → Jenkins kullanmayan
      sunucuyu başlatamıyor. Zorunluluk proje bazına insin — **S**
- [x] **T-39** `frontend/package.json`'dan `node-ssh` + `node-winrm` kaldır;
      `test-ssh.js`, `test-winrm.js`, `out.css`, commit'lenmiş `dist/` temizlensin — **S**
- [x] **T-40** `backend/package.json`'a `start` / `dev` script'leri ekle — **S**
- [x] **T-41** WebSocket katmanını sil: `socket.io`, `socket.io-client`, `useLiveStream.ts`.
      (`server.js:467` zaten `executeDeploy(project, params)` ile **yanlış imzada** çağırıyor,
      yani WS yolu bozuk ve kullanılmıyor.) — **S**
- [x] **T-42** `SamlBrowserAuth.js` ölü kod — sil — **S**

---

## FAZ 3 — MİMARİ VE SÜREÇ

- [x] **T-50** 🔥 **Environment seçimi sahte** — TriggerModal Dev/Stage/Prod sunuyor ama
      proje tek config tutuyor; üç seçim de **aynı sunucuya** gidiyor. Bu hem yanıltıcı hem
      tehlikeli. `config.environments = { Dev, Stage, Prod }` yapısına geç — **L**
- [x] **T-50b** Ortam parolaları her ayar kaydında **siliniyordu** — T-50 sonrası bulundu.
      `redactProject` environment secret'larını `has*` bayrağına çevirmiyordu (ham `secret://`
      referansı dönüyordu) ve `mergeProjectConfig` sadece taban alanları koruyordu. Sonuç:
      kullanıcı ayarları kaydettiğinde `environments.Prod.password` siliniyor, yerine
      `hasPassword: true` yazılıyordu. T-04'te taban alanlar için çözülen hatanın
      environment'lara taşınmamış hali. Her iki fonksiyon `getSecretFieldPaths()` ile
      dinamik yol listesine çevrildi; `has*` bayrakları artık her derinlikte temizleniyor.
      4 yeni test. Ayrıca fonksiyonlar `src/api/projectSerialization.js`'e çıkarıldı —
      test dosyası artık `server.js`'ten metin çıkarmıyor, doğrudan import ediyor (T-58 zemini).
- [x] **T-51** Prod deploy onayı: proje adını yazarak doğrulama + (kurumsal) ikinci kişi onayı — **M**
- [x] **T-52** RBAC: `viewer` / `deployer` / `admin` + proje bazlı yetki — **L** — SEC-09
- [x] **T-53** SQLite'a geçiş (`better-sqlite3`): projects, deployments, audit tabloları;
      eşzamanlı yazım kaybı biter — **L** — SEC-12
- [x] **T-54** Kalıcı deployment geçmişi: `DeploymentsSheet` şu an sadece bellekteki
      1 saatlik oturumları gösteriyor. Kalıcı kayıt + log arşivi + geçmişe dönük görüntüleme — **M**
- [x] **T-54b** Çöken sunucudan kalan "running" deployment kayıtları — T-54 sırasında bulundu.
      Süreç deploy ortasında ölürse DB satırı sonsuza dek `running` kalıyordu; `getSession()`
      DB'ye düştüğü için abort ucu bu bayat kaydı canlı sanıp **"iptal edildi" diye başarı
      dönüyordu** (hiçbir şey yapmadan). İki düzeltme: açılışta `reconcileInterrupted()` ile
      yarım kalanlar `failed`'a çekiliyor, ve abort ucu salt-okunur (DB'den gelen) session'da
      409 dönüyor. Canlı veride 5 bayat kayıt uzlaştırıldı.
- [x] **T-55** Denetim kaydını zenginleştir: kullanıcı, IP, sonuç, süre; JSONL append-only;
      `AuditLogger`'ı pluggable yap (`FileSink` / `HttpSink`) — **M** — SEC-12, Electron §11
- [x] **T-56** `VpnSupervisor`: tekil kaynak yönetimi, kuyruk, referans sayacı,
      "şu an X projesi tünel tutuyor" göstergesi — **L**
- [x] **T-57** Adapter sözleşmesini netleştir: `trigger()` her zaman throw eder,
      `streamLogs()` opsiyonel; üç adapter'daki no-op'lar kaldırılsın — **M**
- [x] **T-57b** PMP ve WinRM adapter'ları iptal durumunda `{ status: 'Aborted' }`
      **döndürüyordu** — T-57'de ortaya çıktı. Bu, T-30/T-31b'de düzeltilen sessiz-başarı
      hatasının üçüncü örneğiydi: sözleşme "başarısızlığı throw et" diyor, bu iki yer
      return ediyordu. Artık `assertTriggerResult()` taban sınıfta bunu **yakalayıp açık
      hata veriyor**, yani biri sözleşmeyi dördüncü kez ihlal ederse sessizce başarılı
      görünmek yerine test/çalışma anında patlayacak. Abort akışı bozulmadı:
      `DeploymentManager.abort()` session durumunu `adapter.abort()`'tan ÖNCE
      `'aborted'` yapıyor, `server.js`'teki `wasAborted` kontrolü hâlâ doğru sınıflandırıyor. — **S**
- [x] **T-58** `packages/core` ayrıştırması — Express'ten bağımsız servis katmanı — **L** — Electron E0
- [x] **T-59** Frontend `Transport` soyutlaması (HTTP impl.) — **M** — Electron E2
- [x] **T-60** Test + lint + CI: backend smoke testleri, `oxlint`, `tsc --noEmit`,
      PR'da otomatik çalışsın — **M**

---

## FAZ 4 — EKRAN / UX

- [x] **T-52b** RBAC arayüz gizlemesi **ölü dosyaya** eklenmişti — ölü kod temizliğinde çıktı.
      Agent yetki kontrolünü `ProjectCard.tsx`'e ekledi ama o bileşen UI yenilemesinde
      `ProjectRow` ile değiştirilmişti ve sadece (kendisi de ölü olan) `ProjectGrid`
      tarafından import ediliyordu. Sonuç: `viewer` rolü ekranda **aktif Deploy düğmesi**
      görüyordu; backend 403 ile engelliyordu (asıl koruma doğruydu) ama arayüz yanıltıyordu.
      `ProjectRow`'a eklendi, `ProjectCard`/`ProjectGrid` silindi. — **S** — SEC-09
- [x] **T-70** Kartta son deploy sonucu: renk, süre, kim tetikledi, "logları gör" linki — **M** (T-31 sonrası)
- [x] **T-71** Aynı anda birden fazla deployment izleme (şu an tek state, ikinci deploy
      birincinin logunu siliyor) — **M**
- [x] **T-72** Terminal ekranı: arama, stdout/stderr filtresi, kopyala/indir, ANSI renk,
      timestamp toggle; her satırdaki `➜` gürültüsünü kaldır; `key={i}` yerine stabil key — **M**
- [x] **T-71b** 🔥 **Yanlış deployment'ı iptal etme riski** — T-71 sonrası ortaya çıktı.
      `ProjectRow`/`ProjectTable` `onAbort: () => void` alıyor; hangi projeye ait olduğu
      bilgisi yok, "aktif sekmedeki" deployment'ı iptal ediyor. Tek deployment varken
      zararsızdı, eşzamanlı deployment mümkün olunca **A projesinin satırındaki iptal
      düğmesi B'nin deployment'ını durdurabilir.** İmza `onAbort: (projectId: string) => void`
      olmalı ve Dashboard o projeye ait çalışan run'ı bulup iptal etmeli.
      *RBAC turu `components/project/**` içinde olduğu için o bitince yapılacak.* — **S**
- [x] **T-60b** Testler **üretim veritabanına yazıyordu** — RBAC turunda bildirilen "flaky test"
      sorununu kazınca çıktı. `DeploymentManager` ve repository singleton'ları import anında
      `src/idp.db`'yi açıyordu; bir test koşusu canlı geçmişe 6 satır ekliyordu ve paralel
      test dosyaları aynı dosyada `ALTER TABLE` üzerinde yarışıp `SQLITE_BUSY` veriyordu.
      `IDP_DB_PATH` override'ı + süreç başına izole geçici DB (`test/helpers/isolateDb.js`).
      ⚠️ İlk denemem yetersizdi: preload ana süreçte de çalışıp değişkeni ayarlıyor, çocuklar
      **miras alıyordu** — hepsi yine aynı DB'yi paylaşıyordu. Pid damgasıyla çözüldü.
      8 ardışık koşu temiz. Üretim DB'sindeki 246 test artığı kaydı temizlendi. — **S**
- [x] **T-73** Her provider için "Test Connection" (şu an sadece PMP'de var) — **M**
- [x] **T-74** Silme onayı: native `confirm()` yerine AlertDialog + proje adı doğrulama — **S**
- [x] **T-75** MFA overlay'ini global modal'a taşı — şu an log panelinin içinde,
      panel kapanınca prompt kayboluyor ve deploy 60 sn sonra timeout'a düşüyor — **M**
- [x] **T-76** Boş durumlar — *UI yenilemesi `ProjectTableEmpty` ile iki durumu zaten
      ayırmıştı (filtre sonucu boş vs hiç proje yok); eksik olan tek şey hiç proje yokken
      oluşturma çağrısıydı, o eklendi. Ölü kalan `ProjectGrid.tsx` (eski versiyonum) ve
      kullanılmayan `ui/form.tsx`, `ui/table.tsx` silindi — ölü dosya sayısı 0.* Orijinal kapsam: *(YAPILDI ama ölü kod oldu — `ProjectGrid.tsx` paralel yürüyen
      UI yenilemesiyle `ProjectTable`e devredildi ve artık hiçbir yerden import edilmiyor.
      Boş-durum ayrımı yeni tablo bileşenlerine taşınmalı.)* Orijinal kapsam: proje yokken / filtre sonuç vermezken anlamlı ekran — **S**
- [—] **T-77** Dil tutarlılığı — **kullanıcı kararı: mevcut hali kalıyor** (2026-08-20).
      UI'da İngilizce/Türkçe karışık; bilinçli olarak dokunulmuyor. Orijinal kapsam: UI İngilizce ama "Authentication (Kimlik Doğrulama)" gibi
      karışık etiketler var — tek dile karar ver veya i18n — **S**
- [x] **T-78** Erişilebilirlik: filtre çiplerinde `aria-pressed` (T-35), ayarlar sekmelerinde
      `role="tablist"` + roving tabindex + ok/Home/End klavye gezinmesi, TOTP kutularında
      `getElementById` yerine ref. *Not: TOTP'deki global id araması artık gerçek bir hataydı —
      MFA istemi T-75'te global modala taşındığı için iki istem aynı anda mount edilebiliyor
      ve odak yanlış deployment'ın kutusuna gidebilirdi.* Orijinal kapsam: filtre çiplerine `aria-pressed`, tab yapısına `role="tablist"`,
      TOTP kutularında `getElementById` yerine ref — **S**
- [x] **T-79** `ProjectSettingsModal.tsx` **721 satır** — `JenkinsSettings`, `ServerSettings`,
      `PmpSettings`, `VpnSettings`, `DangerZone` olarak böl (proje kuralı: 200 satır) — **M**

---

## FAZ 5 — ELECTRON

> Detay: `03-ELECTRON-MIMARI.md`. **E0–E3 zaten yukarıdaki maddeler** (T-10, T-53, T-58, T-59) —
> Electron için ekstra iş değil, aynı işi Electron'u düşünerek yapmak.

- [x] **T-90** Electron iskeleti: main + preload + `contextIsolation`/`sandbox`,
      gömülü modda çalıştır — **L**
- [x] **T-91** IPC transport implementasyonu; Express'i kaldır — **L**
- [x] **T-92** `safeStorage` tabanlı `SecretStore` implementasyonu — **M**
- [x] **T-91b** IPC kanallarında rate limit yok — HTTP tarafında var
      (`middleware/rateLimit.js`), IPC'de yok. Masaüstünde saldırgan model farklı
      (renderer zaten bizim kodumuz) ama derinlemesine savunma açısından
      deploy/login kanallarına da konmalı. Çözüm: saf pencereleme/sayaç mantığı
      `backend/src/core/rateLimiter.js`'e çıkarıldı (Express'ten bağımsız,
      `check-core-boundaries.js` ile doğrulandı); `middleware/rateLimit.js` artık
      onun ince bir Express sarmalayıcısı — HTTP davranışı birebir korundu
      (`rate-limit.test.js` hâlâ yeşil). `desktop/main/ipc/helpers.js`'in
      `ipcHandler(action, handler, { rateLimit })`'i aynı çekirdeği kullanıyor;
      `idp:auth:login` (15 dk/10) ve `idp:deploy:trigger` (dk/10) limitli, aşıldığında
      `ConflictError` (frontend `parseIpcError()` bunu düzgün taşıyor) — **S**
- [x] **T-93** OS yetki diyaloğu ile VPN elevation (`sudo-prompt` / privileged helper) — **L**
- [x] **T-94** SAML akışını `BrowserWindow` ile yeniden yaz → **Playwright bağımlılığı kalkar**,
      Microsoft selector kırılganlığı biter — **M**
- [x] **T-95** `electron-builder` + kod imzalama + notarization + `electron-updater`
      ⚠️ *Sertifika tedariki uzun sürer — karar netleşince paralel başlat* — **L**
      Çözüm: `desktop/electron-builder.js` (config `package.json`'dan JS modülüne
      taşındı — env-var koşullu imzalama JSON'da ifade edilemiyordu) mac/win imzalamayı
      `CSC_LINK`/`CSC_KEY_PASSWORD`/`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` varlığına göre
      koşullu kuruyor; sertifika yoksa `identity: null` ile eskisi gibi imzasız `dir`
      build üretiliyor (gerçek `npm run build` ile doğrulandı, üretilen `.app` açıldı).
      `build/notarize.js` (`afterSign` hook, `@electron/notarize`) + `build/entitlements.mac.plist`
      (hardened runtime: JIT, native `ssh2` kütüphane doğrulama muafiyeti, network client)
      eklendi — kimlik bilgisi eksikse sessizce no-op. `main/updater.js`
      (`electron-updater` iskeleti) `IDP_UPDATE_FEED_URL` yoksa sessizce devre dışı;
      `main/index.js`'e bilerek bağlanmadı (görev kısıtı, paralel iş var). CI'a
      `desktop` job'ı (yalnızca `check:syntax`, paketleme değil) ve `verify.sh`'ye aynı
      adım eklendi (9/9 yeşil). Detay: `docs/06-DAGITIM.md`.
- [x] **T-14b** SAML/VPN oturum çerezi loglara sızıyordu — T-94 sırasında bulundu, SEC-06b.
      T-14'ün değer-tabanlı temizleyicisi secret'ları `vpnConfig`'ten topluyordu; çerez
      çalışma anında üretildiği için kapsam dışındaydı ve `[VPN] Executing: ... --cookie <AÇIK>`
      olarak hem SSE'ye hem `deployments.log_text` arşivine yazılıyordu. Çerez, doğduğu anda
      temizleyici kapsamına alınıyor (`spawnCtx.extraSecrets`). Gerçek process ile doğrulandı. — SEC-06b
- [x] **T-90b** 🔥 Paketlenmiş uygulama verisini **`.app` paketinin içine** yazıyordu —
      "uygulamayı nasıl açacağım" sorusu üzerine bakınca çıktı. `idp.db`, `users.json`,
      `sessions.json` `IDP.app/Contents/Resources/backend/src/` altına gidiyordu: her
      güncelleme/yeniden kurulum **bütün projeleri, kimlik referanslarını ve denetim
      kaydını silerdi**, ve macOS karantinaya alınmış uygulamayı taşıdığında yazma
      tamamen başarısız olurdu. Üç yol da `IDP_DB_PATH`/`IDP_USERS_PATH`/`IDP_SESSIONS_PATH`
      ile yapılandırılabilir yapıldı; masaüstü main process'i bunları backend modülleri
      require edilmeden ÖNCE `app.getPath('userData')`'ya yönlendiriyor. — **S**
- [x] **T-11b** İlk kurulum parolası **görülemiyordu** — sadece stdout'a basılıyordu, oysa
      Finder'dan açılan bir uygulamada konsol yok. Hesap vardı, parolası okunamıyordu.
      `takeBootstrapPassword()` (bir kez okunur) + ana pencereye bağlı bir diyalog;
      "kopyala" düğmesiyle. Konsol çıktısı da korundu (sunucu modu için). — **S**
- [ ] **T-96** Merkezi audit/policy servisi (hibrit model) — **L**

---

## Önerilen çalışma sırası

```
T-01 → T-05        (bugün, kimlik temizliği + sudo endpoint'i kaldırma)
T-30, T-31, T-32   (yanlış "başarılı" gösterimi ve çalışmayan VPN tipleri)
T-11, T-13, T-12   (kimlik doğrulama, webhook, RCE)
T-14, T-15, T-16   (secret sızıntısı, TLS)
T-35 → T-42        (tutarsızlıklar ve ölü kod temizliği — hızlı kazanımlar)
T-50, T-53, T-58   (environment, SQLite, core ayrıştırma → Electron zemini)
FAZ 4 (UX) ve FAZ 5 (Electron) paralel
```

---

## Ek: İlk analiz → TODO izlenebilirlik tablosu

İlk incelemede (2026-08-18) çıkan 43 maddenin tamamı bu listeye taşındı.
Hiçbir bulgu düşmedi; kodlar değişti, içerik korundu.

### Kritik (K1–K7) → Güvenlik bulguları

| İlk kod | Konu | Yeni kod |
|---|---|---|
| K1 | Düz metin kimlikler + gitignore yok | SEC-01 · T-01, T-02, T-03, T-04 |
| K2 | `grant-permissions` shell injection | SEC-02 · T-05 |
| K3 | PMP `new Function` → RCE | SEC-03 · T-12 |
| K4 | `admin/admin` + sabit session secret | SEC-04 · T-11 |
| K5 | VPN parolası loglara sızıyor | SEC-06 · T-14, T-15 |
| K6 | MFA webhook doğrulaması atlanabiliyor | SEC-05 · T-13 |
| K7 | TLS doğrulaması kapalı | SEC-07 · T-16 |

### Bug'lar (B1–B11)

| İlk kod | Konu | Yeni kod |
|---|---|---|
| B1 | WS `executeDeploy` yanlış imza | T-41 (katman siliniyor) |
| B2 | SSH başarısızlığı "succeeded" | **T-30** |
| B3 | `context` null → openvpn/wireguard/ssh-jump ölü | **T-32** |
| B4 | `project.status` güncellenmiyor | **T-31** |
| B5 | Filtre çipleri provider'larla uyuşmuyor | T-35 |
| B6 | `Server`/`WinRM` map'lerde yok | T-36 |
| B7 | Abort ezileniyor | T-33 |
| B8 | SSE çift reconnect + replay | T-34 |
| B9 | Mutlak `localhost:3001` URL | T-37 |
| B10 | `JENKINS_URL` global zorunlu | T-38 |
| B11 | Frontend'de `node-ssh`/`node-winrm` | T-39 |

### Mimari (M1–M9)

| İlk kod | Konu | Yeni kod |
|---|---|---|
| M1 | Environment seçimi sahte | **T-50** |
| M2 | Prod onayı yok | T-51 |
| M3 | RBAC yok | SEC-09 · T-52 |
| M4 | Deployment geçmişi yok | T-54 (kısmen karşılandı — aşağıya bak) |
| M5 | VPN küresel kaynak, proje bazlı yönetiliyor | SEC-17 · T-21, T-56 |
| M6 | JSON dosyası veritabanı olarak | T-53 |
| M7 | Secret yönetimi yarım | SEC-01 · T-10 |
| M8 | Adapter sözleşmesi tutarsız | T-57 |
| M9 | Test/lint/CI yok | T-40, T-60 |

### Sadeleştirme (S1–S6)

| İlk kod | Konu | Yeni kod |
|---|---|---|
| S1 | WebSocket katmanı gereksiz | T-41 |
| S2 | `SamlBrowserAuth` ölü kod | T-42 |
| S3 | PMP web adapter gerekli mi? | T-12 · `03-ELECTRON-MIMARI.md` §8 |
| S4 | Provider ayrımı fazla karmaşık | T-35 |
| S5 | Sudo butonu UI'da olmamalı | T-05 |
| S6 | 721 satırlık modal | T-79 |

### UX (E1–E10)

| İlk kod | Konu | Yeni kod |
|---|---|---|
| E1 | Kartta sonuç görünmüyor | T-70 |
| E2 | Tek deployment izlenebiliyor | T-71 |
| E3 | Terminal ekranı zayıf | T-72 |
| E4 | Test Connection sadece PMP'de | T-73 |
| E5 | Şifreler tarayıcıda okunabiliyor | SEC-01 · T-04 |
| E6 | Native `confirm()` | T-74 |
| E7 | Dil karışık | T-77 |
| E8 | Boş durum yok | T-76 |
| E9 | MFA overlay log panelinin içinde | T-75 |
| E10 | Erişilebilirlik | T-78 |

---

### İkinci turda **yeni** eklenenler

Kod tabanına 18–20 Ağustos arasında eklenen **Telemetry** ve **DeploymentsSheet**
özellikleri ile derinleşen inceleme sonucu:

| Yeni kod | Konu | Neden yeni |
|---|---|---|
| **SEC-08** | NOPASSWD sudoers → yerel yetki yükseltme | K2'nin içinde birleşikti, ayrı risk olarak ayrıldı |
| **SEC-10** | SSH host key doğrulaması kapalı | İlk turda atlanmıştı |
| **SEC-11** | Telemetry vault'u dakikada bir dövüyor | **Yeni özellik** |
| **SEC-12** | Denetim kaydı güvenilmez (kim/IP/sonuç yok) | M3'te ima ediliyordu, ayrı bulgu oldu |
| **SEC-14** | Rate limit yok | İlk turda atlanmıştı |
| **SEC-15** | Girdi doğrulaması yok | İlk turda atlanmıştı |
| **SEC-16** | SSE log buffer'ı sızan secret'ı 1 saat tutuyor | K5'in ikinci dereceden etkisi |
| **SEC-18** | PMP hata screenshot'ları temizlenmiyor | İlk turda atlanmıştı |
| **SEC-19** | Playwright `--no-sandbox` | İlk turda atlanmıştı |
| **SEC-21/22/23** | Oturum süresi, hata sızıntısı, `.env.example` eksikleri | Düşük öncelikli ekler |
| **T-18** | Telemetry'yi dizginle | **Yeni özellik** |
| **T-40** | `start`/`dev` script'i yok | M9'un somut hali |
| **T-58/T-59** | `packages/core` + `Transport` soyutlaması | **Electron hazırlığı** |

### Kısmen karşılanmış bulgular

- **M4/E1 (deployment geçmişi)** — `DeploymentsSheet` eklenmiş, ama `listSessions()`
  yalnızca **bellekteki** oturumları döndürüyor ve `cleanup()` 1 saat sonra siliyor.
  Kalıcı geçmiş hâlâ yok → **T-54 açık kalıyor.**
- **B6 (provider map'leri)** — `ProjectCard` yeniden yazılmış ama `Server`/`WinRM`
  hâlâ `providerIcons`/`providerColors` içinde yok → **T-36 açık.**
- **K1–K7, B1, B2, B3, B4** — kodda **hiçbiri düzeltilmedi**, aynen duruyor.
