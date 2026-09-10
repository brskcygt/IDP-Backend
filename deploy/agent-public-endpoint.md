# Agent ucunu (7003) internete açma

Müşteri sunucularındaki Java agent'lar IDP gateway'ine **dışarıya doğru** bir WebSocket açar.
İnternetteki agent'ların bağlanabilmesi için gateway'in agent ucunun dışarıdan erişilebilir
olması gerekir.

**Durum: karar verilmedi.** Aşağıdaki seçenekler (A, B, C) değerlendirme içindir ve karar
sonrası bu belge güncellenecek. Hangi seçenek seçilirse seçilsin IDP sunucusuna
(`192.168.0.242`) ek yazılım (`cloudflared` vb.) **kurulmaz**. "Her seçenekte geçerli kurallar"
bölümü seçimden bağımsızdır.

## Portlar

| Port | Ne | Dinlediği adres | Dışarı açılır mı |
| --- | --- | --- | --- |
| 7003 | Gateway agent dinleyicisi (yalnızca agent WebSocket ve `/health`) | `0.0.0.0` | **Evet, dışarı açılabilecek tek port** |
| 7004 | Gateway kontrol dinleyicisi (tüm HTTP uçları, komut gönderme, backend aboneliği) | `127.0.0.1` | **ASLA** |
| 3001 | IDP backend API | `0.0.0.0` | **ASLA** |

## Her seçenekte geçerli kurallar

1. **Dışarı yalnızca agent portu açılır.** Port yönlendirme, proxy, tünel, hepsi yalnızca 7003'e
   gider. 3001 ve 7004 hiçbir yoldan dışarı açılmaz. 7004 zaten yalnızca `127.0.0.1`'de dinler,
   firewall kuralı yoktur.
2. **Dış uç TLS'lidir.** Agent'lar `wss://` ile bağlanır. 7003 düz WebSocket konuşur ve internete
   doğrudan `ws://` olarak açılmaz. TLS dış uçta (proxy, ters proxy ya da VM) sonlanır.
3. **WebSocket geçmeli.** Aradaki katman `Upgrade: websocket` isteğini geçirmeli. Boşta bağlantı
   zaman aşımı, agent'ın bağlantıyı canlı tutma aralığından uzun olmalı; yoksa bağlantılar düzenli
   aralıklarla kopar.
4. **Agent adresi `IDP_AGENT_PUBLIC_URL`'dir.** Backend bu adresi her yeni agent paketine yazar.
   Kurulum betiği ile ayarlanır:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install-idp-server.ps1 `
       -AgentPublicUrl wss://agent.<alan>
   ```

   Parametre verilmezse `backend\.env`'deki mevcut değer korunur. Değer hiç yoksa iç ağ adresi
   (`ws://<ilk iç IP>:7003`) yazılır. `ws://` / `wss://` dışındaki bir adreste agent kimliği
   üretimi 503 döner.
5. **Cloudflare Access (opsiyonel, yalnızca önde Cloudflare proxy/Access varsa).** Agent,
   WebSocket açılışında `CF-Access-Client-Id` ve `CF-Access-Client-Secret` başlıklarını gönderir.
   Değerler backend'den gelir:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install-idp-server.ps1 `
       -AgentPublicUrl wss://agent.<alan> -CfAccessClientId <CLIENT_ID>
   ```

   Secret gizli girişle sorulur ve `backend\.env`'e `IDP_AGENT_CF_ACCESS_CLIENT_ID` /
   `IDP_AGENT_CF_ACCESS_CLIENT_SECRET` olarak yazılır. İkisi birlikte verilir; yalnızca biri
   doluysa backend açılmaz. Cloudflare tarafında kurulacaklar:
   - Self-hosted bir Access uygulaması (`agent.<alan>`), policy action **Service Auth**,
     Include → bu service token.
   - Service token'ın secret'ı yalnızca oluşturulduğu ekranda, **bir kez** gösterilir.
   - Service token süreli oluşturulur (varsayılan 1 yıl). Yenileme: yeni token üretilir ve
     policy'ye eklenir, betik yeni `-CfAccessClientId` ile çalıştırılır, tüm agent ZIP'leri yeniden
     üretilip kurulur, en son eski token policy'den çıkarılır.
   - Çift tüm agent paketlerinde aynıdır. Bir paketi ele geçiren Access kapısını geçer ama başka
     bir agent'ın kimliğiyle bağlanamaz, çünkü gateway sırrı agent başınadır.
6. **Sıralama.** Dış erişim, sunucuya **yeni** gateway ve backend paketi kurulup aşağıdaki yerel
   doğrulama geçtikten **sonra** açılır. Eski gateway'de kontrol API'si ve paylaşımlı token
   agent'larla aynı porttaydı (7003); o sürüm internete bir an bile açılmamalı. Cloudflare Access
   kullanılacaksa Access uygulaması ve policy'si dış erişimden **önce** hazır olmalı.

## Yerel doğrulama (sunucuda, dışarı açmadan önce)

PowerShell 5.1'de `curl` bir `Invoke-WebRequest` takma adıdır; `curl.exe` yazın.

```powershell
Get-NetTCPConnection -State Listen -LocalPort 7004          # LocalAddress yalnızca 127.0.0.1
curl.exe -s http://127.0.0.1:7003/health                    # {"ok":true,"service":"idp-agent-gateway"}, sayı YOK
curl.exe -s -o NUL -w "%{http_code}\n" http://127.0.0.1:7003/agent/all   # 404
```

`/health` agent sayısı döndürüyorsa ya da `/agent/all` 7003'te 404 dışında bir şey dönüyorsa
sunucuda hâlâ eski gateway çalışıyor. Dışarı açmayın.

## Dışarıdan doğrulama

Başka bir ağdan (Cloudflare Access yoksa `-H` başlıklarını çıkarın):

```bash
# {"ok":true,"service":"idp-agent-gateway"} dönmeli. Agent sayısı gibi başka bir alan OLMAMALI.
curl -s -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" https://agent.<alan>/health

# Kontrol uçları agent portunda yok: 404. 200 dönüyorsa dış erişimi HEMEN kapatın.
curl -s -o /dev/null -w "%{http_code}\n" -H "CF-Access-Client-Id: $ID" \
  -H "CF-Access-Client-Secret: $SECRET" https://agent.<alan>/agent/all

# Backend dışarıda değil: 404 (ya da bağlantı hatası).
curl -s -o /dev/null -w "%{http_code}\n" -H "CF-Access-Client-Id: $ID" \
  -H "CF-Access-Client-Secret: $SECRET" https://agent.<alan>/api/health

# Yalnızca Cloudflare Access varsa: başlıksız istek reddedilmeli (403 ya da Access sayfası, 302).
curl -s -o /dev/null -w "%{http_code}\n" https://agent.<alan>/health
```

Dışarıdan 3001 ve 7004'e bağlantı denemesi başarısız olmalı. Son adım: yeni kimlikle üretilen
bir agent'ı kurun ve IDP arayüzünde **online** göründüğünü kontrol edin.

## Seçenekler (karar verilmedi)

### A) Ofis güvenlik duvarında port yönlendirme, önünde Cloudflare proxy/Access

`agent.<alan>` Cloudflare'de proxy'li (turuncu bulut) bir kayıt olur ve ofisin dış IP'sini
gösterir. Ofis güvenlik duvarı gelen trafiği yalnızca `192.168.0.242:7003`'e yönlendirir.

- Origin'de yönlendirilen port **yalnızca Cloudflare IP aralıklarına** açılır
  (<https://www.cloudflare.com/ips/>). Açılmazsa origin IP'sini bilen herkes Cloudflare'i ve
  Access'i atlayıp doğrudan bağlanabilir.
- Açık sorular: Cloudflare ile origin arası şifreleme ("Flexible" modda bu bacak düz gider,
  "Full (strict)" origin'de TLS ister), Cloudflare'in proxy'lediği port kısıtı (dış portun
  7003'e eşlenmesi), güvenlik duvarında kimin değişiklik yapacağı.
- Artı: ek makine yok. Eksi: ofis IP'si ve güvenlik duvarı kuralı dışarıya açılır.

### B) Gateway ayrı bir public VM'de

`idp-agent-gateway` internete açık ayrı bir VM'de çalışır, TLS orada sonlanır. IDP sunucusu
yalnızca backend'i çalıştırır.

- Backend, gateway'in kontrol dinleyicisine erişmek zorunda. Kontrol API'si internete
  **açılmaz**; bu bağlantı şifreli, özel bir kanaldan (VPN, özel ağ vb.) geçmeli, çünkü kontrol
  token'ı bu kanalda taşınır.
- Bugünkü kurulum betiği bu topolojiyi kurmaz: gateway ve backend'i aynı makineye kurar.
- Açık sorular: VM ile ofis arası bağlantı, VM'de agent kimlik kaydının yedeklenmesi, VM'in
  sahipliği ve bakımı.

### C) Tünel ya da ters proxy ayrı bir ofis makinesinde

Ofiste IDP sunucusu **dışında** bir makine tünel (ör. Cloudflare Tunnel) ya da ters proxy
çalıştırır. Tek hedefi `http://192.168.0.242:7003`'tür.

- IDP sunucusuna yazılım kurulmaz. Tünel kullanılırsa ofiste gelen port açmak gerekmez.
- O makine ile `192.168.0.242:7003` arası iç ağda düz WebSocket'tir; 7003 firewall kuralı
  (Domain/Private) bu makineyi kapsamalı.
- Tünel token'ı bir sırdır, kasada tutulur.
- Açık sorular: makinenin sahipliği, bakımı ve yedekliliği.

## Mevcut agent'lar: yeni kimlikle yeniden üretme

**Eski agent ZIP'leri artık bağlanamaz.** Eski paketler paylaşımlı `IDP_AGENT_API_TOKEN`'ı taşır.
Gateway artık agent'ları yalnızca agent başına sırla kabul eder. Güncellemeden sonra her agent,
yeniden üretilip kurulana kadar çevrimdışı kalır. Güncellemeyi buna göre planlayın.

- Her agent için IDP arayüzünden paketi yeniden üretin (yetki: `admin`, `project:write`).
  Backend `POST /api/agents/<id>/credentials` ile gateway'den yeni bir sır alır. Yanıt sırrı,
  `gatewayUrl` (`IDP_AGENT_PUBLIC_URL`) değerini ve varsa Access çiftini paket içine koyar.
- Sır **bir kez** döner, sonradan görüntülenemez. Aynı ID için yeniden üretmek sırrı değiştirir
  (rotasyon): o ID'nin açık oturumu kapanır ve önceki paket çalışmaz.
- Paketi müşteri sunucusunda kurun. Kurulum betiği aynı görev adını `-Force` ile yeniler.
- Artık kullanılmayan bir agent'ın kimliğini iptal edin: `DELETE /api/agents/<id>/credentials`.
- Her üretim ve iptal audit log'a kullanıcı ve agent ID ile düşer. Sır audit log'a yazılmaz.

## Eski paylaşımlı token'ı değiştirme (rotate)

Eski `IDP_AGENT_API_TOKEN` dağıtılmış her JAR'da düz metin olarak duruyor; sızmış kabul edin.
Bu değer artık yalnızca backend ile gateway arasındaki kontrol token'ıdır (`127.0.0.1:7004`),
ama eski ZIP'lerdekiyle aynı kaldığı sürece değiştirilmelidir:

1. `backend\.env` ve `C:\ProgramData\IDP\Server\gateway.env` dosyalarını yönetici olarak açın.
   **İkisinden de** `IDP_AGENT_API_TOKEN` satırını silin.
2. Kurulum betiğini tekrar çalıştırın. Betik yeni bir token üretir ve iki dosyaya aynı değeri
   yazar. "agents.json var ama token yoktu" uyarısı bu durumda beklenir.

Satırı yalnızca bir dosyadan silmeyin: betik diğer dosyadaki eski değeri korur. İki dosyada
farklı değer bırakırsanız betik durur.
