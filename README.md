# Nore Proxy

A unified OpenAI API proxy server built with Express and using SQLLite as its database.

## Features

- Multi-endpoint API proxying
- Easy variable and API key management with admin panel
- Rate limiting (RPD/RPM)
- Request logging (SQLLite)
- Prometheus metrics
- Model mapping

## Installation

1. Clone the repository:
```bash
git clone https://github.com/norenaboi/nore-proxy-node.git
cd nore-proxy-node
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment and edit .env with your desired values:
```bash
copy .env.example .env
```

4. Run the server:
```bash
npm start
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 8741 |
| `MASTER_KEY` | Admin authentication key | admin |
| `RPD_DEFAULT` | Requests per day limit | 500 |
| `RPM_DEFAULT` | Requests per minute limit | 10 |

## Frontend

| Endpoint | Description |
|----------|-------------|
| `/models` | View models |
| `/admin/login` | Admin panel login page |
| `/admin/dashboard` | Main dashboard |
| `/admin/keys` | API key manager panel |
| `/admin/models` | Model manager panel |
| `/admin/endpoints` | Endpoint manager panel |

## Backend

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/models` | GET | View models |
| `/v1/chat/completions` | POST | API Handler |
| `/api/stats/summary` | GET | Summary of statistics of all users |
| `/api/usage` | GET | View usage statistics |
| `/api/keys` | GET | Get all API keys |
| `/api/keys` | POST | Add new API key |
| `/api/keys` | PUT | Update existing key |
| `/api/keys` | DELETE | Delete key |
| `/api/models` | GET | Get all models |
| `/api/models` | POST | Add new model |
| `/api/models` | PUT | Update existing model |
| `/api/models` | DELETE | Delete model |
| `/api/endpoints` | GET | Get all endpoints |
| `/api/endpoints` | POST | Add new endpoint |
| `/api/endpoints` | PUT | Update existing endpoint |
| `/api/endpoints` | DELETE | Delete endpoint |
| `/api/reload` | POST | Reload/Update configuration |
