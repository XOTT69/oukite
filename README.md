# OUKITEL Home — P2001E Plus

Самостійний PWA для OUKITEL P2001E Plus. Він показує реальні дані з Quectel/Acceleronix Cloud у **read-only** режимі та не віддає Wonderfree password, bearer token або `authKey` браузеру.

## Що працює

- вибір прив'язаної до акаунта станції;
- SOC, час, потужність входу/виходу, AC/DC input, температура, частота, напруга, firmware та зарядний ліміт;
- PWA/offline shell, без кешування будь-яких API-відповідей;
- server-side сесія Cloudflare KV з `HttpOnly`, `Secure`, `SameSite=Strict` cookie;
- cloud read-only: endpoint-и для write-команд навмисно відсутні.

`productKey` для P2001E Plus: `p11wN7`. Це підтверджено в [публічному reverse-engineering проєкті](https://github.com/bordeux/ha-oukitel-powerstation/blob/master/REVERSE_ENGINEERING.md). `deviceKey` вибирається з вашого акаунта після входу — вручну вводити його не потрібно.

## Чесне обмеження

Safari PWA не може відкривати UDP `6606` або TCP `6607`, тому напряму до станції у LAN підключитися не здатний. Перевірений локальний протокол потребує окремого bridge-процесу в тій самій мережі (наприклад Raspberry Pi, NAS або домашній сервер); це не вимагає Home Assistant, але не може працювати лише в браузері iPhone.

## Розгортання на Cloudflare

PWA та Worker мають бути розгорнуті **на одному Cloudflare-домені**: так браузер отримує захищену cookie-сесію без CORS і без cloud-токена у `localStorage`.

1. KV namespace `oukitel-home-sessions` уже прив'язаний у [wrangler.toml](wrangler.toml).
2. Запустіть `wrangler deploy` — Worker сам віддає файли з `public/`.
3. Відкрийте його URL, увійдіть у Wonderfree та оберіть станцію.

Для локальної перевірки коду: `npm test` і `npm run check`.

## Безпека

Пароль використовується лише в POST `/api/login` через HTTPS та не пишеться у браузерне сховище. Cloud token залишається в Cloudflare KV максимум 12 годин. Vendor `appSecret` у `worker.js` — не секрет користувача: це параметр мобільного застосунку, необхідний для відтворення протоколу входу.
