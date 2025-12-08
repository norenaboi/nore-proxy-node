# Nore Proxy

A unified OpenAI API proxy server built with FastAPI.

## Features

- Multi-endpoint API proxying
- API key management
- Rate limiting (RPD/RPM)
- Request logging
- Prometheus metrics
- Model mapping

## Installation

1. Clone the repository:
```bash
git clone https://github.com/norenaboi/nore-proxy.git
cd nore-proxy
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Configure environment/models and edit .env/models with your actual values:
```bash
copy .env.example .env
copy allowed_models.txt.example allowed_models.txt
```

4. Run the server:
```bash
python server.py
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `V{index}_URL` | Backend API endpoints | - |
| `V{index}_TOKEN` | Authentication tokens | - |
| `MASTER_KEY` | Admin authentication key | admin |
| `RPD_DEFAULT` | Requests per day limit | 500 |
| `RPM_DEFAULT` | Requests per minute limit | 10 |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/models` | GET | View models |
| `/v1/chat/completions` | POST | API Handler |
| `/api/stats/summary` | GET | Summary of statistics of all users |
| `/api/usage` | GET | View usage statistics |
| `/admin/keys` | GET | Get all API keys |
| `/admin/keys/add` | POST | Add new API key |
| `/admin/keys/update` | PUT | Update existing key |
| `/admin/keys/delete` | DELETE | Delete key |
| `/admin/reload` | POST | Reload/Update configuration |
