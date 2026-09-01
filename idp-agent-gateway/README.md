# IDP Agent Gateway

IDP masaüstü uygulaması ile Java agentlar arasında bağlantı ve komut yönlendirmesi sağlar. Ayrı bir veritabanı gerektirmez; aktif bağlantılar bellekte tutulur.

## Yerelde çalıştırma

```bash
npm install
IDP_AGENT_API_TOKEN="uzun-rastgele-token" npm start
```

Varsayılan adresler:

- REST: `http://localhost:7003`
- WebSocket: `ws://localhost:7003`
- Sağlık: `http://localhost:7003/health`

IDP masaüstü ve oluşturulan agent JAR aynı `IDP_AGENT_API_TOKEN` değerini kullanmalıdır. Şirket sunucusunda TLS ters proxy arkasına alınarak `https://` / `wss://` ile yayınlanmalıdır.
