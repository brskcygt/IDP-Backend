# IDP Agent Gateway

IDP backend'i ile müşteri sunucularındaki Java agent'lar arasında bağlantı ve komut yönlendirmesi sağlar.
Ayrı bir veritabanı gerektirmez; aktif bağlantılar bellekte, agent kayıtları ve kimlik hash'leri
`data/agents.json` içinde tutulur.

## İki listener

| Listener | Env (varsayılan) | Kim kullanır | Ne sunar |
| --- | --- | --- | --- |
| Agent | `IDP_AGENT_GATEWAY_HOST` / `IDP_AGENT_GATEWAY_PORT` (`0.0.0.0:7003`) | Java agent'lar (Cloudflare tüneli yalnızca buraya) | `/` üzerinde agent WebSocket'i, `GET /health` → `{"ok":true,"service":"idp-agent-gateway"}`. Diğer her şey 404. |
| Kontrol | `IDP_AGENT_GATEWAY_CONTROL_HOST` / `IDP_AGENT_GATEWAY_CONTROL_PORT` (`127.0.0.1:7004`) | IDP backend | REST uçları, kimlik yönetimi, `/` üzerinde `type:'web'` abonelik WebSocket'i |

`IDP_AGENT_API_TOKEN` yalnızca kontrol token'ıdır ve zorunludur; boşsa gateway başlamaz (exit 1).
Bu token agent'lara verilmez, agent listener'da kabul edilmez.

## Kontrol uçları

`GET /health` dışındaki her uç `Authorization: Bearer <IDP_AGENT_API_TOKEN>` ister.

| Uç | Yanıt |
| --- | --- |
| `GET /health` | `{"ok":true,"service":"idp-agent-gateway","agents":<toplam>,"online":<çevrimiçi>}` |
| `GET /agent/all` | `{type,message,data:[{id,online,last_ping,connected_at,credential_issued_at,details}]}` |
| `POST /agent/credentials/:id` | 201 `{"agentId","secret"}`. ID varsa rotasyon: canlı oturum 4003 `Credential rotated` ile kapanır. Geçersiz ID 400. |
| `DELETE /agent/credentials/:id` | 204; kayıt silinir, canlı oturum 4003 `Credential revoked` ile kapanır. Bilinmeyen ID 404. |
| `POST /agent/run-deploy-command/:id` | Gövde `{"command":"..."}` (en fazla 64 KB) |
| `GET /agent/send-app-update-command/:id` | Agent'a `update` komutu |

Agent ID formatı: `^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$`. Secret yalnızca `POST` yanıtında bir kez
döner; gateway yalnızca `sha256(secret)` hex değerini saklar. Kimlik verilen agent `/agent/all`'da
hemen `online:false` olarak görünür.

## Agent bağlantısı

1. Agent `/` yoluna WebSocket upgrade isteğini şu header'larla açar:
   `X-IDP-Agent-Id: <id>` ve `Authorization: Bearer <agentSecret>`.
   Kimlik upgrade'den önce doğrulanır; bilinmeyen ID, kimliği olmayan kayıt veya yanlış secret → HTTP 401.
2. İlk mesaj `{"type":"agent","agentId":"<aynı id>","process":"handshake",...}` olmalıdır; değilse close 1008.
   `type:'web'` agent listener'da reddedilir. 15 sn içinde handshake gelmezse bağlantı 1008 ile kapanır.
3. Aynı ID ile doğrulanmış yeni bağlantı eskisini 4001 ile değiştirir (meşru yeniden bağlanma).
4. Gateway 30 sn'de bir WebSocket ping yollar; iki aralık boyunca pong gelmezse soket sonlandırılır.
5. IP başına dakikada 30 başarısız denemeden sonra geçersiz denemeler 429 alır. Geçerli kimlik hiçbir
   zaman engellenmez (tünel arkasında tüm istemciler aynı cloudflared adresinden gelir).
   `X-Forwarded-For` ve `CF-Connecting-IP` karar için kullanılmaz; ikincisi yalnızca loglanır.

Hash'i olmayan eski kayıtlar yüklenir ve listede görünür ama kimlik verilene kadar bağlanamaz.

## Yerelde çalıştırma

```bash
npm ci
IDP_AGENT_API_TOKEN="uzun-rastgele-token" npm start
```

- Agent WebSocket: `ws://localhost:7003`
- Kontrol REST / abonelik WS: `http://127.0.0.1:7004` / `ws://127.0.0.1:7004`
- Backend'de `IDP_AGENT_API_URL` kontrol listener'ı göstermelidir (`http://127.0.0.1:7004`).

İnternete açılırken yalnızca agent listener TLS'li tünel (`wss://`) arkasına alınmalıdır.

## Test

```bash
npm test
```
