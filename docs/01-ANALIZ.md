# IDP — Proje Analizi ve Süreç Haritası

> Son güncelleme: 2026-08-20 · Kapsam: `backend/src/**`, `frontend/src/**`

## 1. Proje ne yapıyor?

**Internal Developer Platform (IDP)** — tek bir arayüzden farklı hedeflere deployment tetikleyen
merkezi orkestratör. Operatör portala girer, "Deploy" der; portal hedefe bağlanır,
script'i çalıştırır, logu canlı akıtır. Hedefe erişim ya doğrudan ya da hedef sunucuda
çalışıp gateway'e kendisi bağlanan IDP agent'ı üzerindendir.

> VPN tünel kurulumu ve ona bağlı MFA akışı üründen kaldırıldı (agent mimarisine
> geçildi). `services/vpn/*` modülleri olası bir geri dönüş için repoda duruyor ama
> hiçbir akış tarafından çağrılmıyor.

## 2. Ana akış

```
Login (admin/admin — sabit)
  ↓
Dashboard — proje kartları (Jenkins / PMP / Server / WinRM)
  │  ├─ Telemetry rozeti (Server/WinRM için CPU+RAM, 60 sn polling)
  │  └─ Settings → hedef bilgileri, kimlik, script
  ↓
Deploy → TriggerModal (environment seçimi)
  ↓
POST /api/deploy/trigger
  ├─ 0. PMP Vault'tan şifre çek        (config.authType === 'pmp')
  ├─ 1. adapter.connect() → trigger() → streamLogs()
  └─ 2. finally: şifreyi bellekten sil
  ↓
LiveTerminalStream — SSE (/api/deploy/logs/:id) ile canlı log
  ↓
AuditLogger → audit_logs.json
```

## 3. Katmanlar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Transport | `server.js`, `routes/deploy.js` | REST + SSE (+ ölü WebSocket yolu) |
| Orkestrasyon | `services/DeploymentManager.js` | Session, log buffer, subscriber |
| Adapter | `adapters/*.js` | Jenkins / SSH / WinRM / PMP-web |
| Vault | `services/vault/PmpService.js` | ManageEngine PMP'den dinamik şifre |
| İzleme | `services/TelemetryService.js` | SSH/WinRM ile CPU+RAM |
| Kayıt | `services/AuditLogger.js` | JSON dosyasına denetim kaydı |
| Depolama | `projects.json`, `audit_logs.json` | Dosya tabanlı "veritabanı" |

## 4. Adapter davranışları

| Adapter | Bağlanma | Tetikleme | Log akışı |
|---|---|---|---|
| **Jenkins** | `/api/json` health check | `buildWithParameters` → kuyruktan build no çözme | `logText/progressiveText` — **gerçek streaming** |
| **SSH** | node-ssh (key > password) | `scriptContent` veya varsayılan git/npm/pm2 zinciri | `trigger()` içinde inline (`streamLogs` no-op) |
| **WinRM** | WS-Man Identify SOAP | PowerShell `-EncodedCommand` (UTF-16LE base64) | Yok — komut bitince toplu (`streamLogs` no-op) |
| **PMP** | Playwright headless Chromium | `new Function(scriptContent)` veya selector tahmini | Yok (`streamLogs` no-op) |

## 5. Olgunluk değerlendirmesi

**Güçlü yanlar**
- Adapter soyutlaması doğru kurgulanmış — yeni sağlayıcı eklemek kolay
- SSE + log buffer + late-join replay tasarımı sağlam
- PMP Vault entegrasyonu (dinamik şifre) doğru fikir

**Zayıf yanlar**
- Kimlik bilgileri düz metin diskte, API üzerinden tarayıcıya dönüyor
- Tek kullanıcı, sabit parola → denetim kaydı anlamsız
- Dosya tabanlı depolama, eşzamanlılık koruması yok
- Environment seçimi kozmetik (tek config, üç ortam)
- Başarısız SSH deploy'u "başarılı" gösteren sessiz hata
- Test / lint / CI yok, `npm start` bile yok

**Sonuç:** Fikir ve mimari iskelet üretim seviyesinde; **güvenlik, kalıcılık ve doğruluk
katmanları PoC seviyesinde.** Aşağıdaki TODO bu farkı kapatmak için.
