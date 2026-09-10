# IDP sunucu kurulumu (Windows, iç ağ, düz HTTP)

`install-idp-server.ps1`, IDP backend'ini ve `idp-agent-gateway`'i tek bir Windows makineye
zamanlanmış görev olarak kurar. Betik idempotent: aynı komutu kurulum, güncelleme ve onarım için
tekrar tekrar çalıştırabilirsiniz.

| Bileşen | Görev | Varsayılan port | Log |
| --- | --- | --- | --- |
| Backend API | `IDP-Backend` | 3001 | `C:\ProgramData\IDP\Server\logs\backend.log` |
| Agent gateway, agent dinleyicisi (yalnızca agent WebSocket ve `/health`) | `IDP-Agent-Gateway` | 7003 (`0.0.0.0`) | `C:\ProgramData\IDP\Server\logs\gateway.log` |
| Agent gateway, kontrol dinleyicisi (tüm HTTP uçları, backend'in log aboneliği) | aynı görev | 7004 (yalnızca `127.0.0.1`) | aynı log |

İki görev de ayrı bir yerel hesapla (`idp-svc`, RunLevel Limited) çalışır. Bu makinede SYSTEM
olarak çalışan Java agent görevine (`IDP-Agent-...`) betik dokunmaz.

Backend gateway'e yalnızca kontrol dinleyicisinden konuşur (`IDP_AGENT_API_URL=http://127.0.0.1:7004`).
7004 için firewall kuralı açılmaz ve bu port hiçbir yoldan dışarı açılmaz. Agent portunu
internete açma kuralları ve seçenekleri: [`../agent-public-endpoint.md`](../agent-public-endpoint.md).

## Ön koşullar

- 64-bit Windows PowerShell 5.1 ve **yönetici** oturumu.
- Node.js **≥ 22.13** (tercihen 24 LTS), makine geneline kurulu olmalı (`C:\Program Files\nodejs`).
  nvm ya da kullanıcı profilindeki bir Node kurulumu servis hesabından erişilemez; betik bu durumda durur.
- Git. Repo, kullanıcı profili dışında bir dizine klonlanmış olmalı (öneri:
  `C:\IDP\Internal-Developer-Platform--IDP-`). Repo yolunda `"`, `%` veya `#` olmamalı.
- npm registry erişimi (`npm ci` için).
- 3001, 7003 ve 7004 portları boş olmalı.
- Görevler saklanan parolayla çalışır. "Network access: Do not allow storage of passwords and
  credentials" politikası açıksa görev kaydı başarısız olur. Domain GPO "Log on as a batch job"
  hakkını yönetiyorsa `idp-svc` hesabını oraya da ekletin, yoksa GPO yenilendiğinde görev
  0x80070569 hatasıyla açılmaz.

## Kurulum

```powershell
cd C:\IDP\Internal-Developer-Platform--IDP-
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install-idp-server.ps1
```

**Bu sunucu için önerilen komut (192.168.0.242):** `Ethernet` arayüzü Public profilde ve VPN
istemcileri `192.168.0.7` üzerinden (NAT) geliyor. Portları Public profilde yalnızca yerel alt ağa
açın; makinenin ağ profili değişmez:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install-idp-server.ps1 -FirewallPublicRemoteAddress LocalSubnet
```

Daha dar tutmak isterseniz `-FirewallPublicRemoteAddress 192.168.0.7` verin. Birden fazla adres
için `"192.168.0.7,192.168.0.8"` yazın.

İlk kurulumda betik `admin` hesabı için parolayı ön kontrollerde, yani `npm ci`'dan önce sorar
(en az 8 karakter). `powershell.exe -File` ile SecureString parametre geçmez. Parolayı parametreyle
vermek isterseniz betiği yönetici PowerShell oturumunun içinden çağırın:

```powershell
& .\deploy\windows\install-idp-server.ps1 -AdminPassword (Read-Host -AsSecureString)
```

| Parametre | Varsayılan | Açıklama |
| --- | --- | --- |
| `-RepoPath` | betiğin iki üst dizini | Repo kökü |
| `-DataDir` | `C:\ProgramData\IDP\Server` | DB, kullanıcılar, oturumlar, şifreli sırlar, agent kaydı, loglar |
| `-Port` / `-BindHost` | `3001` / `0.0.0.0` | Backend |
| `-GatewayPort` / `-GatewayBindHost` | `7003` / `0.0.0.0` | Gateway agent dinleyicisi (başka sunuculardaki agent'lar bağlanır). Kontrol dinleyicisi sabit: `127.0.0.1:7004` |
| `-AgentPublicUrl` | mevcut değer, yoksa `ws://<ilk iç IP>:<GatewayPort>` | Agent paketlerine yazılan adres (`IDP_AGENT_PUBLIC_URL`), `ws://` ya da `wss://`. İnternetten erişimde `wss://agent.<alan>` |
| `-CfAccessClientId` / `-CfAccessClientSecret` | mevcut değerler | Cloudflare Access service token çifti (`IDP_AGENT_CF_ACCESS_CLIENT_ID` / `_SECRET`). İkisi birlikte; secret verilmezse gizli girişle sorulur |
| `-AdminPassword` | sorulur | Sadece `users.json` henüz yokken kullanılır |
| `-SkipFirewall` | kapalı | Firewall kurallarına dokunmaz |
| `-Uninstall` | kapalı | Kaldırır (aşağıya bakın) |
| `-IgnoreLegacyData` | kapalı | Eski varsayılan yollardaki veriyi bilerek yok sayar (aşağıya bakın) |
| `-FirewallPublicRemoteAddress` | yok | Portları Public profilde de açar, ama sadece bu kaynaklara (`LocalSubnet`, IP ya da alt ağ). Verilmezse Public kuralı kaldırılır. `Any`, `*` ya da boş değer reddedilir. |

**Eski veri koruması.** Betik şu dosyalardan birini bulur ve veri dizininde karşılığı yoksa durur:
`backend\src\idp.db`, `backend\src\users.json`, `backend\src\secrets.enc.json`,
`idp-agent-gateway\data\agents.json`. Bu dosyalar env yol değişkenleri tanımlı değilken kullanılan
varsayılan yollardır. İki seçenek var: dosyaları `C:\ProgramData\IDP\Server\` altına taşıyın
(`idp.db` ile `-wal` ve `-shm` birlikte), ya da bilerek sıfırdan başlamak için `-IgnoreLegacyData`
verin (eski dosyalar silinmez). Temiz bir klonda bu dosyalar olmaz; hepsi `.gitignore`'da.

Betik sırasıyla şunları yapar:

1. Yönetici yetkisini, Node sürümünü, portları ve eski veriyi kontrol eder; gerekiyorsa admin
   parolasını sorar.
2. Çalışan görevleri durdurur.
3. `idp-svc` hesabını yoksa oluşturur. Mevcut hesabın parolasına bu aşamada dokunmaz: parola ancak
   görev kaydından hemen önce rastgele yenilenir ve hiçbir yere kaydedilmez. `npm ci` ya da `.env`
   adımı başarısız olursa eski görevler geçerli parolalarıyla kalır.
4. İzinleri ayarlar: veri dizinine, `backend\.env`'e ve `gateway.env`'e sadece SYSTEM, Administrators
   ve `idp-svc` erişebilir.
5. `npm ci --omit=dev` çalıştırır.
6. `.env` dosyalarını yazar. Gateway'e `IDP_AGENT_GATEWAY_CONTROL_HOST=127.0.0.1` ve
   `IDP_AGENT_GATEWAY_CONTROL_PORT=7004`, backend'e `IDP_AGENT_API_URL=http://127.0.0.1:7004`,
   `IDP_AGENT_PUBLIC_URL` ve (verildiyse) Cloudflare Access çiftini yazar.
7. Firewall kuralını Domain ve Private profillerine açar (3001 ve 7003). Public profile sadece
   `-FirewallPublicRemoteAddress` verilirse ve yalnızca o kaynaklara açar. 7004 için kural
   açılmaz.
8. Görevleri kaydedip başlatır; `/api/health`, gateway `/health` (7003) ve kontrol
   dinleyicisini (127.0.0.1:7004) kontrol eder.
9. Admin hesabı oluşunca `IDP_ADMIN_PASSWORD` satırını `.env`'den siler.

Konsolda hiçbir sır gösterilmez. Korunan dosya ve dizinlerin sahibi Administrators olarak ayarlanır.

Betik şu durumlarda uyarır ama hiçbir şeyi değiştirmez:

- Repo dizininde Everyone, Authenticated Users ya da Users için yazma izni var. Uyarı, izni
  daraltacak `icacls` komutlarını da gösterir.
- `node.exe` için etkin bir gelen Block kuralı var. Block kuralları Allow'dan önceliklidir.
- "Log on as a batch job" hakkı bir GPO ile yönetiliyor. Bu kontrol sadece domain üyesi
  makinelerde yapılır.
- `.env` içinde yer tutucu değerler var: `change_me`, `your_..._here` ya da `.env.example`'daki
  örnek değerin aynısı.

`npm ci` sırasında görülen node-gyp, "Failed to build optional crypto binding" ya da
`cpu-features` mesajları zararsızdır. Gerçek hata olduğunda npm sıfırdan farklı bir kodla çıkar
ve betik durur.

## Kurulumdan sonra

- **Arayüz yalnızca Electron'da.** Backend frontend dosyalarını sunmaz; `http://<ip>:3001`
  adresini tarayıcıda açmak arayüz getirmez (sadece `/api/...` uçları yanıt verir). Betik sonunda
  makinenin tüm iç IP'lerini listeler. Kullanıcı adı `admin`.
- **Electron:** ayar dosyasına şu satırı ekleyip uygulamayı yeniden başlatın:
  `IDP_SERVER_URL=http://192.168.0.242:3001`.
  Ayar dosyasını menüden açın: **Araçlar > Ayar dosyasını aç** (dev ortamında macOS'ta
  `~/Library/Application Support/idp-desktop/idp.env`). Satır başına `export ` yazmayın.
  Uzak modda oturum bellekte tutulur; uygulama kapanınca tekrar giriş gerekir.
- **Agent ZIP'leri yeniden üretilmeli; eski ZIP'ler artık bağlanamaz.** Her agent kendi
  kimliğini taşır. Paket IDP arayüzünden üretilir (yetki: `admin`). Backend
  `POST /api/agents/<id>/credentials` ile gateway'den o agent'a özel bir sır alır ve sırrı,
  `IDP_AGENT_PUBLIC_URL` adresini ve varsa Cloudflare Access çiftini pakete koyar. Sır bir kez
  döner. Aynı ID için yeniden üretmek sırrı değiştirir ve önceki paketi geçersiz kılar.
  - `IDP_AGENT_PUBLIC_URL` varsayılanı iç ağ adresidir (`ws://192.168.0.242:7003`). İnternetten
    bağlanacak agent'lar için dış uç hazırlandıktan sonra betiği
    `-AgentPublicUrl wss://agent.<alan>` ile çalıştırın:
    [`../agent-public-endpoint.md`](../agent-public-endpoint.md).
  - `IDP_AGENT_API_TOKEN` artık yalnızca backend ile gateway arasındaki kontrol token'ıdır;
    agent'a verilmez. Eski değer dağıtılmış JAR'larda düz metin durduğu için değiştirin
    (bkz. `agent-public-endpoint.md`, "Eski paylaşımlı token'ı değiştirme").
  - Kullanılmayan agent'ın kimliğini `DELETE /api/agents/<id>/credentials` ile iptal edin.

  Yeni ZIP'teki `install-idp-agent-<id>.ps1` aynı görev adını `-Force` ile yeniler.
- **Ağ profili:** kurallar Public profile herkese bilerek açılmaz. Arayüz Public görünüyorsa ve
  kısıtlı bir Public kuralı yoksa betik iki seçenek sunar:
  - (a) Önerilen: betiği `-FirewallPublicRemoteAddress LocalSubnet` ile tekrar çalıştırın. Makinenin
    ağ profili değişmez.
  - (b) `Set-NetConnectionProfile -InterfaceAlias <ad> -NetworkCategory Private`. Bu makine genelinde
    etki eder: o arayüzde tüm Private profil kuralları devreye girer.

## Git'siz kurulum (kopyalanan paket)

Sunucuda git klonu yerine sadece gereken dizinleri içeren bir paket de kullanılabilir. Pakette
yalnızca commit'lenmiş dosyalar olur (`.env`, `users.json`, `idp.db`, `node_modules` olmaz):

```bash
git archive --format=zip -o idp-server.zip HEAD backend idp-agent-gateway deploy
```

ZIP'i profil dışında bir dizine açın (ör. `C:\IDP\idp-server`) ve betiği oradan çalıştırın
(`.\deploy\windows\install-idp-server.ps1`). Betik `.git` yokken git kontrolünü atlar.

**Güncellerken `backend\.env`'i koruyun.** Dosya kod dizininin içindedir ve `IDP_SECRET_KEY`'i
taşır. `backend` dizinini silip yeniden kopyalamak anahtarı kaybettirir ve kayıtlı tüm sırlar
çözülemez olur. Güncelleme adımları: görevleri durdurun, yeni paketi eskisinin **üzerine** açın
(`.env` pakette olmadığı için ezilmez), sonra betiği tekrar çalıştırın. Önce `backend\.env`'i ve
veri dizinini yedekleyin.

## Güncelleme

```powershell
cd C:\IDP\Internal-Developer-Platform--IDP-
git pull
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install-idp-server.ps1
```

Betik `git pull` yapmaz. Tekrar çalıştırıldığında görevleri durdurur, `npm ci` yapar, `.env`
anahtarlarını tazeler, görevleri yeniden kaydedip başlatır. `SESSION_SECRET`, `IDP_SECRET_KEY` ve
`IDP_AGENT_API_TOKEN` **asla yeniden üretilmez**. Mevcut anahtar bozuksa ya da iki dosyadaki token
farklıysa betik durur ve düzeltmeyi size bırakır. `IDP_AGENT_PUBLIC_URL` ve Cloudflare Access
çifti de korunur; yalnızca `-AgentPublicUrl` / `-CfAccessClientId` verildiğinde değişir.
`backend\.env`'de çiftin yalnızca biri doluysa betik durur (backend bu durumda açılmaz). Çifti
kaldırmak için iki satırı da elle silin. Git "dubious ownership" hatası verirse betik
`safe.directory` komutunu gösterir.

## Kaldırma

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install-idp-server.ps1 -Uninstall
```

Silinenler: iki görev, firewall kuralları, `idp-svc` hesabı ve profili, batch oturum hakkı, repo
üzerindeki okuma izni.

Kaldırma **veri dizinine ve `backend\.env` dosyasına dokunmaz.** Bunları yedekledikten sonra elle
silin.

## Yedekleme

- `backend\.env`: içindeki `IDP_SECRET_KEY` mutlaka kasaya konmalı. Anahtar kaybolursa kayıtlı
  tüm sırlar (`secrets.enc.json`) çözülemez hale gelir.
- `C:\ProgramData\IDP\Server\gateway.env`.
- `C:\ProgramData\IDP\Server\`: `idp.db` ile birlikte `-wal` ve `-shm` dosyaları, `users.json`,
  `secrets.enc.json`, `agents.json`.

Tutarlı bir DB kopyası için önce görevleri durdurun
(`Disable-ScheduledTask` + `Stop-ScheduledTask`). Kopyaladıktan sonra betiği tekrar çalıştırın ya
da görevleri etkinleştirip başlatın.

## İşletim notları

- Log izlemek: `Get-Content C:\ProgramData\IDP\Server\logs\backend.log -Tail 50 -Wait`. Loglar
  sadece betik çalışırken, 20 MB'ı aşmışsa `.1` dosyasına döndürülür.
- Görevlerin iki tetikleyicisi var: açılışta ve 5 dakikada bir çalışan bir bekçi. Süreç çökerse en
  geç 5 dakika içinde yeniden başlar. Servisi durdurulmuş halde tutmak için `Stop-ScheduledTask`
  yetmez, `Disable-ScheduledTask` kullanın.
- Görev sonuç kodları:
  - `0x8007052E`: oturum açma hatası. Betiği tekrar çalıştırın, parola yenilenir.
  - `0x80070569`: batch oturum hakkı yok (bkz. GPO notu).

## Bilinen sınırlar

- **Düz HTTP.** Parola ve oturum çerezi ağda şifresiz gider. Yalnızca güvenilir iç ağda ya da VPN
  arkasında kullanın. `IDP_COOKIE_SECURE=false` bu yüzden zorunlu: eksik olursa giriş sessizce
  başarısız olur. Ağdaki bir saldırgan yanıtları da değiştirebilir (ör. `/api/auth/me`'yi
  sahteleyip masaüstündeki agent ZIP üreticisinin yetki kontrolünü aşabilir).
- **HTTPS'e geçilirse:** iç CA sertifikası Electron'a `idp.env` üzerinden verilemez
  (`NODE_EXTRA_CA_CERTS` süreç başladıktan sonra okunmaz). Uygulamayı bu ortam değişkeniyle
  başlatın ya da CA'yı koddan yükleyen bir değişiklik yapın.
- **VPN işlevleri Windows'ta çalışmıyor.**
- **VPN NAT.** Tüm VPN istemcileri sunucuya aynı kaynak IP'den gelir (bu sunucuda `192.168.0.7`).
  Bunun iki sonucu var:
  - Giriş hız sınırı (IP başına 15 dakikada 10 deneme, `backend/src/server.js:111`) tüm VPN
    kullanıcıları arasında paylaşılır. Birkaç hatalı deneme herkesi 15 dakika kilitleyebilir.
  - Audit kayıtlarında kullanıcılar IP'ye göre ayırt edilemez.
- **PMP/SAML kapsam dışı.** Playwright tarayıcısı indirilmez. Ayrıca PMP hata ekran görüntüleri
  `backend\public\errors` altına yazılır ve servis hesabının orada yazma izni yok.
- **`NODE_TLS_REJECT_UNAUTHORIZED`.** Güvensiz TLS'e izin verilen bir WinRM hedefinde, deploy
  sürerken süreç genelinde `0`'a çekilir (`backend/src/adapters/WindowsAdapter.js:229-232`). O
  sırada aynı süreçteki tüm HTTPS çağrıları sertifika doğrulamasız çalışır; paylaşımlı sunucuda
  risklidir.
- **HOME tanımsız.** Servis hesabında `HOME` yok ve backend `~` işaretini `/root` yapıyor
  (`SshServerAdapter.js:95`, `core/diagnostics/checks/ssh.js:30`, `TelemetryService.js:160`). SSH
  anahtar yollarını mutlak Windows yolu olarak verin ve dosyaya `idp-svc` için okuma izni açın
  (`icacls <anahtar> /grant idp-svc:R`).
- **Repo dizininin ACL'si.** `C:\` altında yeni açılan dizinler varsayılan olarak Authenticated
  Users'a "değiştirme" izni kalıtır. Makinede başka kullanıcılar varsa repo dizininin iznini
  daraltın.
- **Tek süreç, dosya tabanlı oturum deposu.** Yatay ölçekleme için tasarlanmadı.
