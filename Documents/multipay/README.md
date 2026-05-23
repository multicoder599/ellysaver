# MultiPay — STK Push API Platform

A production-ready M-Pesa STK Push API platform built with Node.js, Express, MongoDB, and Megapay. Single-file backend, self-contained frontend pages.

## Project Structure

```
multipay/
├── backend/
│   ├── server.js          # Everything in one file (models, middleware, routes, megapay)
│   ├── package.json
│   └── .env.example
│
├── frontend/
│   ├── index.html         # Landing page (references app.js)
│   ├── app.js             # Shared frontend utilities
│   ├── login.html         # Self-contained (CSS + JS inline)
│   ├── register.html      # Self-contained
│   ├── dashboard.html     # Self-contained
│   └── docs.html          # Self-contained
│
├── deploy.sh
├── nginx.conf
└── .gitignore
```

## Quick Start

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your Megapay API key and email
npm start
```

Open `http://localhost:5000`

## Environment Variables

```env
PORT=5000
NODE_ENV=development
MONGO_URI=mongodb://localhost:27017/multipay
JWT_SECRET=your_32_char_random_string
MEGAPAY_API_KEY=your_megapay_api_key
MEGAPAY_EMAIL=your_megapay_email
APP_URL=http://localhost:5000
```

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | Public | Create account |
| POST | `/api/auth/login` | Public | Get JWT token |
| GET | `/api/auth/me` | JWT | Get user profile |
| POST | `/api/keys/generate` | JWT | Generate API key |
| GET | `/api/keys` | JWT | List API keys |
| PUT | `/api/keys/:id/revoke` | JWT | Revoke key |
| POST | `/api/stkpush` | API Key | Initiate STK Push via Megapay |
| GET | `/api/transactions` | JWT | List transactions |
| GET | `/api/transactions/:id/status` | API Key | Check tx status |
| GET | `/api/wallet` | JWT | Get wallet balance |
| POST | `/api/webhook/megapay` | Public | Megapay callback |

## Deployment

```bash
bash deploy.sh
sudo cp nginx.conf /etc/nginx/sites-available/multipay
sudo certbot --nginx -d yourdomain.com
```

## License

MIT
