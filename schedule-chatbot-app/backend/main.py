import os
import json
import sqlite3
import base64
from contextlib import contextmanager
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, File, UploadFile, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv
import anthropic

load_dotenv()

API_KEY = os.environ.get("ANTHROPIC_API_KEY")
if not API_KEY:
    print("WARNING: ANTHROPIC_API_KEY is not set. Set it in a .env file or your host's env vars.")

client = anthropic.Anthropic(api_key=API_KEY) if API_KEY else None

# Model used for both OCR (vision) and chat. Swap to "claude-haiku-4-5-20251001"
# for a cheaper/faster option if needed.
MODEL = "claude-sonnet-5"

DB_PATH = os.path.join(os.path.dirname(__file__), "data.db")

# Using Claude's tool-use feature forces the model to return data that
# already matches this schema, instead of us having to parse free-form JSON
# text out of a text reply (which occasionally came back malformed).
SCHEDULE_TOOL = {
    "name": "record_schedule",
    "description": "บันทึกรายวิชาทั้งหมดที่อ่านได้จากตารางเรียนในไฟล์",
    "input_schema": {
        "type": "object",
        "properties": {
            "classes": {
                "type": "array",
                "description": "รายวิชาทั้งหมดที่พบในตาราง ถ้าไม่พบเลยให้เป็น array ว่าง",
                "items": {
                    "type": "object",
                    "properties": {
                        "day": {
                            "type": "string",
                            "enum": ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"],
                        },
                        "start": {"type": "string", "description": "เวลาเริ่มเรียน รูปแบบ HH:MM"},
                        "end": {"type": "string", "description": "เวลาเลิกเรียน รูปแบบ HH:MM"},
                        "subject": {"type": "string", "description": "ชื่อวิชา"},
                        "room": {"type": "string", "description": "ห้องเรียน (ใส่ค่าว่างถ้าไม่มี)"},
                        "instructor": {"type": "string", "description": "ชื่ออาจารย์ (ใส่ค่าว่างถ้าไม่มี)"},
                    },
                    "required": ["day", "start", "end", "subject", "room", "instructor"],
                },
            }
        },
        "required": ["classes"],
    },
}

app = FastAPI(title="ตารางเรียนบอท API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schedule (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                day TEXT NOT NULL,
                start TEXT,
                end TEXT,
                subject TEXT,
                room TEXT,
                instructor TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )


init_db()


def require_session(x_session_id: Optional[str]) -> str:
    if not x_session_id:
        raise HTTPException(400, "Missing X-Session-Id header")
    return x_session_id


def require_client():
    if client is None:
        raise HTTPException(500, "Server is missing ANTHROPIC_API_KEY")


class ChatRequest(BaseModel):
    message: str


def _get_schedule(session_id: str):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT day, start, end, subject, room, instructor FROM schedule WHERE session_id=?",
            (session_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/upload")
async def upload_schedule(file: UploadFile = File(...), x_session_id: Optional[str] = Header(None)):
    session_id = require_session(x_session_id)
    require_client()

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(400, "ไฟล์ว่างเปล่า กรุณาเลือกไฟล์ใหม่")

    b64 = base64.b64encode(file_bytes).decode("utf-8")
    content_type = (file.content_type or "").lower()
    filename = (file.filename or "").lower()
    is_pdf = content_type == "application/pdf" or filename.endswith(".pdf")

    if is_pdf:
        media_block = {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": b64},
        }
    else:
        media_type = content_type if content_type.startswith("image/") else "image/jpeg"
        media_block = {
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": b64},
        }

    prompt = (
        "อ่านตารางเรียนในไฟล์นี้อย่างละเอียดและรอบคอบ แล้วเรียกใช้ฟังก์ชัน record_schedule "
        "เพื่อบันทึกรายวิชาที่พบทั้งหมด\n"
        "ก่อนเรียกฟังก์ชัน ให้ไล่ดูตารางทีละแถว/ทีละวันอย่างเป็นระบบ อย่าข้ามวิชาที่ตัวหนังสือเล็กหรืออยู่มุมภาพ "
        "นับจำนวนวิชาที่เห็นในภาพให้ครบก่อนสรุปผล (ถ้าเป็น PDF หลายหน้าให้อ่านทุกหน้า) "
        "ถ้าตัวหนังสือบางจุดไม่ชัดให้เดาที่สมเหตุสมผลที่สุดแทนการข้าม"
    )

    MAX_ATTEMPTS = 3
    parsed = None
    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = client.messages.create(
                model=MODEL,
                max_tokens=4096,
                tools=[SCHEDULE_TOOL],
                tool_choice={"type": "tool", "name": "record_schedule"},
                messages=[
                    {
                        "role": "user",
                        "content": [
                            media_block,
                            {"type": "text", "text": prompt},
                        ],
                    }
                ],
            )
        except Exception as e:
            last_error = f"Anthropic API error: {e}"
            continue

        tool_block = next((b for b in resp.content if getattr(b, "type", None) == "tool_use"), None)
        if tool_block is None:
            last_error = "model did not call the record_schedule tool"
            continue

        # tool_block.input already matches SCHEDULE_TOOL's JSON schema, guaranteed
        # valid by the API itself, so no manual JSON parsing is needed here.
        parsed = tool_block.input.get("classes", [])
        break

    if parsed is None:
        raise HTTPException(
            502,
            "อ่านไฟล์ไม่สำเร็จหลังจากลองหลายครั้ง อาจเป็นเพราะไฟล์ไม่ชัดหรือมีข้อมูลซับซ้อนเกินไป "
            f"ลองไฟล์อื่น หรือลองใหม่อีกครั้ง (รายละเอียด: {last_error})",
        )

    with get_db() as conn:
        for item in parsed:
            conn.execute(
                "INSERT INTO schedule (session_id, day, start, end, subject, room, instructor) VALUES (?,?,?,?,?,?,?)",
                (
                    session_id,
                    item.get("day", ""),
                    item.get("start", ""),
                    item.get("end", ""),
                    item.get("subject", ""),
                    item.get("room", ""),
                    item.get("instructor", ""),
                ),
            )

    return {"added": len(parsed), "schedule": _get_schedule(session_id)}


@app.get("/api/schedule")
def get_schedule(x_session_id: Optional[str] = Header(None)):
    session_id = require_session(x_session_id)
    return {"schedule": _get_schedule(session_id)}


@app.delete("/api/schedule")
def clear_schedule(x_session_id: Optional[str] = Header(None)):
    session_id = require_session(x_session_id)
    with get_db() as conn:
        conn.execute("DELETE FROM schedule WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM messages WHERE session_id=?", (session_id,))
    return {"ok": True}


@app.post("/api/chat")
def chat(req: ChatRequest, x_session_id: Optional[str] = Header(None)):
    session_id = require_session(x_session_id)
    require_client()

    schedule = _get_schedule(session_id)
    schedule_context = json.dumps(schedule, ensure_ascii=False) if schedule else "ยังไม่มีข้อมูลตารางเรียน"

    with get_db() as conn:
        conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?,?,?,?)",
            (session_id, "user", req.message, datetime.utcnow().isoformat()),
        )
        history_rows = conn.execute(
            "SELECT role, content FROM messages WHERE session_id=? ORDER BY id ASC LIMIT 20",
            (session_id,),
        ).fetchall()

    history = [{"role": r["role"], "content": r["content"]} for r in history_rows]

    system_prompt = (
        "คุณเป็นผู้ช่วยตอบคำถามเกี่ยวกับตารางเรียนของผู้ใช้ อ้างอิงจากข้อมูล JSON ต่อไปนี้เท่านั้น:\n"
        f"{schedule_context}\n"
        "ตอบเป็นภาษาไทย กระชับ ตรงประเด็น ถ้าไม่มีข้อมูลที่ถูกถามให้บอกตรงๆ ว่าไม่พบข้อมูลนั้นในตาราง"
    )

    try:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=1000,
            system=system_prompt,
            messages=history,
        )
    except Exception as e:
        raise HTTPException(502, f"Anthropic API error: {e}")

    reply = "".join(block.text for block in resp.content if hasattr(block, "text"))

    with get_db() as conn:
        conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?,?,?,?)",
            (session_id, "assistant", reply, datetime.utcnow().isoformat()),
        )

    return {"reply": reply}


@app.get("/api/health")
def health():
    return {"ok": True, "has_api_key": client is not None}


# Serve the frontend (built as plain static files) from the same server,
# so a single deploy gives you both the API and the web page.
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
