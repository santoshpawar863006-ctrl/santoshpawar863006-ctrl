import sqlite3
from pathlib import Path
from datetime import datetime

APP_DIR = Path.home() / "ContractorERP"
APP_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = APP_DIR / "contractor_erp.db"

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        client_name TEXT,
        location TEXT,
        start_date TEXT,
        end_date TEXT,
        contract_value REAL DEFAULT 0,
        status TEXT DEFAULT 'Active',
        progress REAL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        address TEXT,
        gstin TEXT,
        notes TEXT,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS boq (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        item_code TEXT,
        description TEXT NOT NULL,
        unit TEXT,
        quantity REAL DEFAULT 0,
        rate REAL DEFAULT 0,
        material_rate REAL DEFAULT 0,
        labour_rate REAL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        date TEXT,
        supplier TEXT,
        material TEXT NOT NULL,
        unit TEXT,
        quantity REAL DEFAULT 0,
        rate REAL DEFAULT 0,
        amount REAL DEFAULT 0,
        invoice_no TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS labour (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        date TEXT,
        worker_name TEXT NOT NULL,
        trade TEXT,
        attendance REAL DEFAULT 1,
        daily_wage REAL DEFAULT 0,
        advance REAL DEFAULT 0,
        paid REAL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        date TEXT,
        category TEXT NOT NULL,
        description TEXT,
        amount REAL DEFAULT 0,
        payment_mode TEXT,
        reference TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        address TEXT,
        gstin TEXT,
        notes TEXT,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        bill_no TEXT,
        bill_date TEXT,
        description TEXT,
        amount REAL DEFAULT 0,
        received REAL DEFAULT 0,
        due_date TEXT,
        status TEXT DEFAULT 'Pending',
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS purchase_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        po_no TEXT,
        po_date TEXT,
        supplier TEXT,
        description TEXT,
        amount REAL DEFAULT 0,
        status TEXT DEFAULT 'Open',
        notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
    """
]

def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db():
    with connect() as conn:
        for stmt in SCHEMA:
            conn.execute(stmt)
        conn.commit()

def now():
    return datetime.now().isoformat(timespec="seconds")

def query(sql, params=()):
    with connect() as conn:
        return conn.execute(sql, params).fetchall()

def execute(sql, params=()):
    with connect() as conn:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.lastrowid

def scalar(sql, params=(), default=0):
    with connect() as conn:
        row = conn.execute(sql, params).fetchone()
        if not row:
            return default
        val = row[0]
        return default if val is None else val

def backup_database(target_path):
    src = connect()
    dest = sqlite3.connect(target_path)
    with dest:
        src.backup(dest)
    dest.close()
    src.close()
