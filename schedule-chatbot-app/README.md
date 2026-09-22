# ตารางเรียนบอท (Schedule Chatbot)

เว็บแอปแชทบอทตารางเรียน: อัปโหลดรูปตารางเรียน → ระบบอ่านด้วย AI (OCR) → ถามคำถามเกี่ยวกับตารางได้

โครงสร้างโปรเจค:
```
schedule-chatbot-app/
├── backend/          FastAPI + SQLite (API และ OCR)
│   ├── main.py
│   ├── requirements.txt
│   └── .env.example
└── frontend/         หน้าเว็บ (HTML/CSS/JS ธรรมดา ไม่ต้อง build)
    ├── index.html
    ├── style.css
    ├── config.js
    └── app.js
```

---

## 1. รันบนเครื่องตัวเอง (สำหรับทดสอบก่อนพรีเซนต์)

### ขั้นตอน
1. ติดตั้ง Python 3.10+ ให้เรียบร้อย
2. ขอ Anthropic API key ที่ https://console.anthropic.com/settings/keys (สมัครฟรี ต้องเติมเครดิตเล็กน้อยเพื่อใช้งานจริง)
3. เปิด terminal แล้วรันคำสั่งต่อไปนี้:

```bash
cd schedule-chatbot-app/backend
python -m venv venv
source venv/bin/activate        # Windows ใช้: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# แล้วเปิดไฟล์ .env ใส่ ANTHROPIC_API_KEY=sk-ant-... ของคุณ

uvicorn main:app --reload --port 8000
```

4. เปิดเบราว์เซอร์ไปที่ **http://localhost:8000** จะเห็นหน้าเว็บแชทบอท (backend เสิร์ฟ frontend ให้อัตโนมัติ)

---

## 2. Deploy ขึ้นออนไลน์จริง (มี URL ให้อาจารย์เปิดดูได้)

แนะนำ **Render.com** เพราะมี free tier และรองรับ FastAPI ตรงๆ ไม่ต้องตั้งค่าซับซ้อน

### ขั้นตอน
1. สร้างบัญชี GitHub (ถ้ายังไม่มี) แล้วอัปโหลดโฟลเดอร์ `schedule-chatbot-app` ทั้งหมดขึ้น repository ใหม่
2. ไปที่ https://render.com สมัคร/ล็อกอิน (สมัครด้วย GitHub ได้เลย)
3. กด **New +** → **Web Service** → เลือก repository ที่เพิ่งอัปโหลด
4. ตั้งค่าดังนี้:
   - **Root Directory**: `backend`
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. เลื่อนลงไปที่ **Environment Variables** → เพิ่ม:
   - Key: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-...` (API key ของคุณ)
6. กด **Create Web Service** รอ 2-3 นาที ระบบจะ build และ deploy ให้อัตโนมัติ
7. เมื่อเสร็จจะได้ URL ประมาณ `https://your-app-name.onrender.com` — เปิดลิงก์นี้จะเห็นหน้าเว็บแชทบอทพร้อมใช้งานจริง ส่งลิงก์นี้ให้อาจารย์เปิดดูได้เลย

### ข้อควรรู้เกี่ยวกับ Render free tier
- เซิร์ฟเวอร์จะ "หลับ" ถ้าไม่มีคนใช้งานนานๆ (sleep after ~15 นาที) พอมีคนเข้าครั้งแรกจะช้าประมาณ 30-60 วินาที ให้เข้าเว็บทดสอบล่วงหน้าก่อนพรีเซนต์สัก 1-2 นาที
- ไฟล์ฐานข้อมูล SQLite (`data.db`) จะรีเซ็ตทุกครั้งที่ deploy ใหม่ (filesystem ไม่ persistent ถาวรบน free tier) — เหมาะสำหรับใช้โชว์/พรีเซนต์ แต่ถ้าจะใช้งานจริงต่อเนื่องระยะยาว ควรอัปเกรดแพลนหรือเปลี่ยนไปใช้ฐานข้อมูลภายนอก (เช่น Postgres ฟรีจาก Render/Supabase)

### ทางเลือกอื่น (ถ้าไม่อยากใช้ GitHub)
ใช้ **ngrok** เปิดเซิร์ฟเวอร์ที่รันบนเครื่องตัวเองให้เข้าถึงจากอินเทอร์เน็ตชั่วคราว (เหมาะสำหรับวันพรีเซนต์วันเดียว ไม่ต้อง deploy จริงจัง):
```bash
# รัน backend ตามขั้นตอนข้อ 1 ก่อน แล้วเปิด terminal อีกอันรัน
ngrok http 8000
```
จะได้ลิงก์ชั่วคราวเช่น `https://xxxx.ngrok-free.app` ใช้ได้ตลอดที่เครื่องเปิดอยู่และรัน ngrok ค้างไว้

---

## 3. การทำงานของระบบ (สำหรับอธิบายอาจารย์)

1. **อัปโหลดรูป** → frontend ส่งไฟล์ไปที่ `POST /api/upload`
2. **Backend** แปลงรูปเป็น base64 ส่งให้ Claude (Anthropic API) พร้อม prompt ให้อ่านตารางแล้วตอบกลับเป็น JSON โครงสร้างที่กำหนด (day, start, end, subject, room, instructor)
3. **บันทึกผล** ลง SQLite ผูกกับ session ของผู้ใช้แต่ละคน (แยกด้วย `X-Session-Id` header ที่ frontend สร้างและเก็บใน localStorage)
4. **ถามคำถาม** → frontend ส่งข้อความไปที่ `POST /api/chat` → backend ดึงข้อมูลตารางเรียนของ session นั้นมาใส่เป็น system prompt แล้วส่งให้ Claude ตอบ โดยอ้างอิงจากข้อมูลจริงเท่านั้น
5. ประวัติแชทเก็บใน SQLite เช่นกัน เพื่อให้ตอบคำถามต่อเนื่องได้ (context)

## 4. แนวทางต่อยอด (ถ้ามีเวลา)
- เพิ่มปุ่มลบ/แก้ไขรายวิชาแต่ละอันในตาราง (ตอนนี้แก้ได้แค่ล้างทั้งหมด)
- แจ้งเตือนคาบว่าง หรือ export ตารางเป็น .ics ใส่ปฏิทิน
- ระบบล็อกอินจริงแทนการใช้ session id แบบสุ่มใน localStorage
- แคชผลลัพธ์ OCR เพื่อลดการเรียก API ซ้ำ
