# CPI Practice Target (final)

Ek hi server, saare practice scenarios ke liye. OAuth2 (client credentials), JSON aur XML dono, realistic Order structure.

## 1. Deploy (Render)

1. GitHub repo ke root me ye files rakho: `server.js`, `package.json` (aur chaho to `samples/` folder).
2. Render: New + > Web Service > repo select. Build: `npm install`. Start: `npm start`. Free plan.
3. Open `https://<your-url>/` : "CPI practice target is running" dikhna chahiye.
4. Purane `cpi-demo-target-pqja` service ko mat chhedna. Ye alag service hai.

## 2. Render Environment Variables (sab optional, par apne rakho)

| Variable | Default | Matlab |
|---|---|---|
| `CLIENT_ID` | `cpi-client` | OAuth2 client id |
| `CLIENT_SECRET` | `cpi-secret` | OAuth2 client secret |
| `TOKEN_TTL` | `3600` | Token kitne second valid (2 rakho to expiry test hoga) |
| `AUTH_MODE` | `oauth` | `oauth`, `basic`, `apikey`, `any`, `none` |
| `BASIC_USER` / `BASIC_PASS` | `cpiuser` / `cpipass` | Basic auth |
| `API_KEY` | `abc123` | header `x-api-key` |
| `ADMIN_KEY` | (khaali) | Set karo to `/admin` aur `/logs` ke liye key chahiye (`?key=` ya header `x-admin-key`) |
| `SLOW_MS` | `70000` | SLOW orders ka delay |
| `FLAKY` | `0` | 0 se 1, random 503 ka chance |

Public repo hai to default secret sab dekh sakte hain. Render me apna `CLIENT_SECRET` zaroor set karo.

## 3. CPI me OAuth2 setup

Monitor > Manage Security > Security Material > Create > **OAuth2 Client Credentials**, phir Deploy.

| Field | Value |
|---|---|
| Name | `CPIDEMO` (ya koi alias) |
| Token Service URL | `https://<your-url>/oauth/token` |
| Client ID / Secret | `cpi-client` / `cpi-secret` (ya jo Render me set kiya) |
| Client Authentication | Send as Request Header |
| Content Type | `application/x-www-form-urlencoded` |
| Scope | khaali |

HTTP receiver: Address `https://<your-url>/api/orders`, Method POST, Authentication **OAuth2 Client Credentials**, Credential Name = alias. Content Modifier me header `Content-Type` = `application/xml` ya `application/json`.

## 4. Message structure

Required: `OrderId`, `Customer/Name`, kam se kam ek `Items/Item` (`Material`, `Quantity` > 0, `UnitPrice` >= 0).
Optional: `OrderDate` (YYYY-MM-DD), `Currency` (INR, USD, EUR, GBP), `Customer/Id`, `Customer/Email`, `Customer/Country` (3-letter: IND, USA, DEU).

XML aur JSON ka structure same hai (JSON = XML ka converter output jaisa). Dekho `samples/order_valid.xml` aur `samples/order_valid.json`.
Reply usi format me aata hai jisme aapne bheja. Alag chahiye to header `Accept: application/json` ya `application/xml`.

## 5. Endpoints

| Endpoint | Kaam |
|---|---|
| `POST /oauth/token` | Token (grant_type=client_credentials) |
| `POST /api/orders` | Order create: 201 |
| `GET /api/orders` | List: `top`, `skip` (ya `$top`, `$skip`), `status`, `customerId`, `createdAfter`. `Next` link paging ke liye |
| `GET/PUT/DELETE /api/orders/{id}` | Ek order. PUT body me `Status` (CREATED, CONFIRMED, SHIPPED, CANCELLED) |
| `POST /api/items/check` | Ek item ka stock/price. `Material` jo `OOS` se shuru ho to 422 |
| `ANY /api/branch/ok` `/fail` `/slow` | Multicast branches |
| `POST /sales-report` | Purane iFlow ke liye, koi bhi body le leta hai |
| `/admin` | Switches (neeche) |
| `/logs` | Last 50 requests (secrets masked) |

25 sample orders (`S0001` se `S0025`) pehle se hain, har 6 ghante ke gap pe.

## 6. Errors jo server deta hai

| Situation | Status |
|---|---|
| Token/credential galat ya missing, token expired | 401 |
| Body khaali, malformed XML/JSON, required field missing (saari errors `Details` me ek saath) | 400 |
| Currency, Country (IN instead of IND), date, Status galat | 422 |
| Same `OrderId` dobara | 409 |
| `OrderId` `FAIL...` se shuru | 500 |
| `OrderId` `BUSY...` se shuru | 503 + Retry-After |
| `OrderId` `SLOW...` se shuru | `SLOW_MS` ke baad 201 |
| `/admin?down=on`, ya FLAKY | 503 |
| Order nahi mila | 404 |

## 7. Admin switches (redeploy ke bina)

- `/admin?down=on` aur `/admin?down=off` : target down/up
- `/admin?flaky=0.5` : 50% random 503
- `/admin?slowMs=10000` : SLOW delay 10 second
- `/admin?authMode=basic` (oauth, basic, apikey, any, none)
- `/admin?reset=1` : orders wapas sample data pe

Ye switches Render restart/sleep ke baad default pe aa jate hain.

## 8. Excel ke 19 concepts ke liye kya use karna hai

| # | Concept | Server pe kya |
|---|---|---|
| 1 | Content-Based Router | Route `Currency` ya `Customer/Country` pe; samples ke alag orders |
| 2 | Splitter + Gather | `order_multi_items.xml` split karo, har Item `/api/items/check` pe, responses gather |
| 3 | Multicast | `/api/branch/ok`, `/api/branch/fail`, `/api/orders`: parallel vs sequential |
| 4 | CSV > XML > JSON | `orders.csv` > CSV to XML > mapping > XML to JSON > POST JSON |
| 5 | Value Mapping / XSLT | CSV me Country `IN`, server `IND` maangta hai. `order_country_IN.xml` 422 deta hai jab tak map na karo |
| 6 | Groovy validation | CPI me khud validate karo, server ka `Details` message compare karo (`order_missing_customer.xml`) |
| 7 | Custom MPL headers | `OrderId` ko custom header banao, Monitor me search karo |
| 8 | Data Store | Fail hue orders (500/503) store karo, baad me reprocess |
| 9 | Timer + Variables | `GET /api/orders?createdAfter=<last run>`, variable me time save |
| 10 | OData | `$top`/`$skip` aur `Next` link se pagination loop. Asli OData adapter ke liye real OData service chahiye |
| 11 | SFTP | Is server me nahi hai, alag SFTP server chahiye |
| 12 | ProcessDirect | Common error iFlow, kisi bhi 4xx/5xx se trigger |
| 13 | SOAP <-> REST | SOAP sender, `POST /api/orders` receiver, response SOAP me wapas |
| 14 | JMS queue | `/admin?down=on` > messages queue me ruke > `down=off`. Dead-letter ke liye `FAIL1` |
| 15 | Idempotent Process Call | Same `OrderId` do baar: 409, Idempotent Process Call me `OrderId` key |
| 16 | Retry logic | `/admin?down=on`, `FLAKY`, `BUSY1`, phir alert |
| 17 | Security | OAuth2 (default), Basic, API key: `authMode` badlo. Certificate aur PGP CPI side ki cheez hai |
| 18 | APIM | Is server ko backend banao. `authMode=none` ya OAuth rakho, Verify API Key, Quota, Spike Arrest APIM me |
| 19 | AEM | CPI se publish, subscriber iFlow `POST /api/orders` kare, `FAIL1` se redelivery/DMQ dekho |

## 9. Yaad rakhna

- Orders memory me hain. Render free plan sleep ya restart pe orders sample data pe wapas aa jate hain.
- Free plan pehli call me 30 se 60 second le sakta hai. CPI timeout isse zyada rakho ya pehle browser se URL khol do.
- Har test ke liye naya `OrderId`, warna 409 aayega.
