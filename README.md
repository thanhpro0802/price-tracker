# 📈 Smart Price Tracker

Theo dõi giá **Crypto, Vàng, Cổ phiếu VN, Xăng dầu** theo thời gian thực.
AI Agent tự động tìm nguồn dữ liệu cho bất kỳ tài sản nào.

---

## 🚀 Deploy lên Railway (MIỄN PHÍ — khuyến nghị)

### Bước 1: Tạo tài khoản Railway
→ https://railway.app (đăng nhập bằng GitHub)

### Bước 2: Đẩy code lên GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/smart-price-tracker.git
git push -u origin main
```

### Bước 3: Deploy trên Railway
1. Vào https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Chọn repo `smart-price-tracker`
3. Railway tự detect Node.js và deploy

### Bước 4: Thêm Environment Variables
Vào **Settings → Variables**, thêm:
```
GEMINI_API_KEY = AIza...your_key
JWT_SECRET     = any_random_string_here_abc123
```

### Bước 5: Lấy URL public
Railway cấp URL dạng: `https://smart-price-tracker-xxx.railway.app`

---

## 🌐 Deploy lên Render (MIỄN PHÍ — alternative)

1. Vào https://render.com → **New Web Service**
2. Connect GitHub repo
3. **Build Command:** để trống (không cần build)
4. **Start Command:** `node server.js`
5. Thêm env vars: `GEMINI_API_KEY`, `JWT_SECRET`

---

## 🖥️ Deploy lên VPS (DigitalOcean/Vultr ~$6/tháng)

```bash
# SSH vào VPS
ssh root@your-vps-ip

# Cài Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone code
git clone https://github.com/YOUR_USERNAME/smart-price-tracker.git
cd smart-price-tracker

# Tạo .env
echo "GEMINI_API_KEY=AIza..." > .env
echo "JWT_SECRET=random_secret_123" >> .env

# Chạy với PM2 (auto-restart)
npm install -g pm2
pm2 start server.js --name "price-tracker"
pm2 save
pm2 startup

# Cài Nginx reverse proxy
sudo apt install nginx
sudo nano /etc/nginx/sites-available/price-tracker
```

Nội dung Nginx:
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/price-tracker /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL miễn phí với Certbot
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

---

## 📢 Quảng bá

### SEO (tự động)
Meta tags đã được thêm sẵn cho Google:
- Title: "Smart Price Tracker — Theo dõi giá Crypto, Vàng, Cổ phiếu VN"
- Keywords: giá bitcoin, giá vàng hôm nay, giá xăng, cổ phiếu VN

### Submit lên Google Search Console
1. Vào https://search.google.com/search-console
2. Thêm property → URL prefix → nhập URL của bạn
3. Verify bằng HTML tag

### Cộng đồng VN để đăng
| Nơi | Link |
|-----|------|
| Reddit r/VietNam | reddit.com/r/VietNam |
| Facebook groups | "Đầu tư chứng khoán VN", "Bitcoin Vietnam" |
| Telegram | @bitcoinvn, @chungkhoanvietnam |
| Discord | Viblo, WeBuild Vietnam |
| Voz.vn | voz.vn/f/lap-trinh.12 |
| Viblo.asia | viblo.asia (đăng bài kỹ thuật) |

### Template post
```
🚀 Mình vừa build Smart Price Tracker — web app theo dõi giá tài sản thời gian thực

✅ Crypto: BTC, ETH, SOL (CoinGecko + Binance)
✅ Cổ phiếu VN: VIC, VNM, FPT, TCB, HPG... (SSI iBoard)
✅ Vàng, Bạc, Bạch kim (GoldAPI)
✅ Xăng dầu VN (cào từ nguồn chính thức)
✅ Tỷ giá: USD/VND, EUR/VND, JPY/VND...
✅ AI Agent: nhập tên bất kỳ, AI tự tìm API và thêm vào tracker
✅ Watchlist + Price Alerts cá nhân hoá theo từng tài khoản

Link: https://YOUR_URL_HERE
```

---

## ⚙️ Chạy local

```bash
# 1. Tạo file .env
cp .env.example .env
# Điền GEMINI_API_KEY vào .env

# 2. Chạy server
node server.js

# 3. Mở browser
open http://localhost:3000
```
