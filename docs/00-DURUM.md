# IDP — Nerede Duruyoruz

> 2026-08-20 · Bu dosya diğer dokümanların özeti ve giriş noktası.

## Özet

Portal, **PoC olgunluğundan üretim seviyesine** taşındı ve yanına bir **Electron
masaüstü uygulaması** eklendi. 72 maddelik iyileştirme listesinin 69'u kapandı.

| | Başlangıç | Şimdi |
|---|---|---|
| CRITICAL güvenlik açığı | 5 | **0** |
| HIGH güvenlik açığı | 7 | **0** |
| Test | 0 | **388** |
| CI | yok | GitHub Actions + `verify.sh` (9 kontrol) |
| Kimlik saklama | düz metin JSON | AES-256-GCM · masaüstünde OS keychain |
| Kimlik doğrulama | `admin/admin` sabit | scrypt hash + rol tabanlı yetki |
| Depolama | JSON dosyası | SQLite (WAL) |
| Dağıtım | tek web sunucusu | web **+** paketlenmiş masaüstü |

## Dokümanlar

| Dosya | İçerik |
|---|---|
| `../KULLANMA-KILAVUZU.md` | Son kullanıcı, yönetici, runner, release, güvenlik ve sorun giderme kılavuzu |
| `01-ANALIZ.md` | Proje ne yapıyor, akış haritası, katmanlar |
| `02-GUVENLIK-ANALIZI.md` | Bulunan tüm güvenlik sorunları, sömürü yolları, çözümler |
| `03-ELECTRON-MIMARI.md` | Masaüstü mimarisi ve alınan kararlar |
| `04-TODO.md` | 72 maddelik liste, durumları ve gerekçeleri |
| `05-GELISTIRME.md` | Kurulum, çalıştırma, test |
| `06-DAGITIM.md` | Kod imzalama, notarization, güncelleme feed'i, MDM |

## Mimari

```
                  ┌──────────────────────┐
   Tarayıcı ──────► Express (server.js)  ─┤
                  │                       ├──► core/   iş mantığı
   Electron ──────► IPC (desktop/main/)  ─┤            (taşımadan bağımsız)
                  └──────────────────────┘
                                              ├── adapters/  Jenkins·SSH·WinRM·PMP
                                              ├── secrets/   şifreli kimlik deposu
                                              ├── store/     SQLite
                                              └── services/  telemetry·agent·vault
```

`core/` içine Express sızması CI'da engelleniyor
(`backend/scripts/check-core-boundaries.js`). Frontend'de de aynı disiplin var:
`fetch`/`EventSource` yalnızca `services/transport/` altında olabilir
(`frontend/scripts/check-transport-boundaries.mjs`).

## Çalıştırma

```bash
# Web
cd backend  && npm start      # :3001
cd frontend && npm run dev    # :5173

# Masaüstü (geliştirme)
cd frontend && npm run dev
cd desktop  && npm run dev

# Masaüstü (paket)
cd desktop && npm run build   # dist/mac-arm64/IDP.app

# Her şeyi doğrula
./verify.sh
```

## Açık kalan işler

**T-03 — sızmış kimliklerin rotasyonu (operasyon işi, kodla çözülmez).**
Fortinet/GlobalProtect VPN parolaları, SSH `deployer` parolası, Jenkins API token'ı
ve bir deploy script'ine gömülü **canlı GitHub PAT**.
⚠️ Uygulamanın şirket içine kapalı olması bunu çözmez: GitHub PAT `github.com`'a
karşı **her yerden** geçerlidir.

**T-96 — merkezi denetim servisi.** Dağıtım şekline bağlı, bkz. aşağıdaki not.

## Dağıtım şekli kararı (T-96'yı belirleyen soru)

**A) Paylaşımlı sunucu (tarayıcı)** — herkes aynı örneğe bağlanır.
Denetim kaydı zaten tek bir SQLite'ta merkezî. `deployments` ve `audit_logs`
tabloları "kim, ne zaman, hangi ortama, sonuç ne" sorusunun tamamını yanıtlıyor.
**T-96'ya gerek yok.**

**B) Kişi başı masaüstü** — herkes kendi makinesinde çalıştırır.
Her kullanıcının kendi yerel veritabanı olur; denetim kaydı makinelere dağılır ve
kullanıcı kendi kaydını silebilir. "Geçen salı prod'a kim deploy etti" sorusu
yanıtsız kalır. Bu senaryoda merkezî bir denetim hedefi anlamlı olur.

**C) İkisi birden** — masaüstü günlük kullanım, sunucu ortak görünürlük için.
Bu durumda B'nin sorunu sürer.

Mimari ikisini de destekliyor; karar operasyonel.
