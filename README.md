# GodEnergi Charge Control

Kombineret OCPP 1.6/2.0.1 + OCPI 2.2.1 server med live dashboard.

## Deploy til Railway

### 1. Opret GitHub repo
Læg disse filer i et GitHub repo:
- `server.js`
- `package.json`
- `dashboard.html`

### 2. Deploy på Railway
1. Gå til https://railway.app og log ind med GitHub
2. Klik "New Project" → "Deploy from GitHub repo"
3. Vælg dit repo
4. Railway detecterer automatisk Node.js og starter serveren

### 3. Sæt environment variables i Railway
Under "Variables" i Railway, tilføj:
```
OCPI_TOKEN_A=dit-hemmelige-token-her
OCPI_TOKEN_B=spirii-token-her
```

### 4. Din faste URL
Railway giver dig en URL som:
```
https://godenergy-charge-control.up.railway.app
```

### 5. Opdater ladere og ChargEye
- **OCPP ladere**: `wss://din-url.up.railway.app/<CHARGER_ID>`
- **ChargEye OCPI versions endpoint**: `https://din-url.up.railway.app/ocpi/versions`
- **Dashboard**: `https://din-url.up.railway.app/`

## Endpoints

| URL | Beskrivelse |
|-----|-------------|
| `/` | Live dashboard |
| `/status` | JSON status for alle ladere og sessioner |
| `/start/:id/:connector` | Remote start ladesession |
| `/stop/:id` | Remote stop ladesession |
| `/ocpi/versions` | OCPI versions endpoint |
| `/ocpi/2.2.1/credentials` | OCPI credentials exchange |

## Pris
Railway koster ca. $5/måned for denne størrelse server.
