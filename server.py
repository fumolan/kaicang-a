#!/usr/bin/env python3
# A股开仓 — 本地服务: 静态页面 + 数据库桥接(MySQL/PostgreSQL/SQLite)
#
# 用法:
#   python3 server.py                          # SQLite(本地文件astk_local.db, 零配置)
#   ASTK_DB_URL=mysql://user:pass@192.168.1.10:3306/kaicang python3 server.py
#   ASTK_DB_URL=postgres://user:pass@192.168.1.10:5432/kaicang python3 server.py
# 驱动(按需): pip3 install pymysql   或   pip3 install psycopg2-binary
#
# 浏览器无法直连数据库(无TCP), 本服务承担 HTTP→SQL 桥接,
# 同时把页面一并伺服: 局域网设备访问 http://本机IP:8765/ 即可(同源无跨域问题)
import json
import os
import re
import sqlite3
import sys
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

PORT = 8765
DB_URL = os.environ.get("ASTK_DB_URL", "").strip()
ROOT = os.environ.get("ASTK_WEB_DIR") or os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

# ---------------- 数据库层 ----------------
class DB:
    def __init__(self, url):
        self.kind = "sqlite"
        self.conn = None
        self.lock = threading.Lock()
        self.param = "?"
        if url.startswith("mysql://"):
            try:
                import pymysql
            except ImportError:
                sys.exit("缺驱动: pip3 install pymysql")
            self.kind, self.param = "mysql", "%s"
            u = urlparse(url)
            self.conn = lambda: pymysql.connect(host=u.hostname, port=u.port or 3306,
                user=u.username, password=u.password, database=u.path.lstrip("/"),
                charset="utf8mb4", autocommit=True)
        elif url.startswith(("postgres://", "postgresql://")):
            try:
                import psycopg2
            except ImportError:
                sys.exit("缺驱动: pip3 install psycopg2-binary")
            self.kind, self.param = "postgres", "%s"
            u = urlparse(url)
            self.conn = lambda: psycopg2.connect(host=u.hostname, port=u.port or 5432,
                user=u.username, password=u.password, dbname=u.path.lstrip("/"))
        else:
            self.path = os.path.join(os.environ.get("ASTK_DATA_DIR", ROOT), "astk_local.db")
            self.conn = lambda: sqlite3.connect(self.path)

        self.exec("""
            CREATE TABLE IF NOT EXISTS astk_trades (
                id BIGINT PRIMARY KEY, code VARCHAR(16), name VARCHAR(32),
                shares INT, buy_price REAL, buy_fee REAL,
                buy_time BIGINT, buy_date VARCHAR(10),
                sell_price REAL, sell_time BIGINT, sell_fee REAL,
                pnl REAL, pct REAL, status VARCHAR(8)
            )""")
        print("数据库: %s (%s)" % (self.kind, url or self.path))

    def exec(self, sql, args=(), fetch=False):
        with self.lock:
            c = self.conn()
            try:
                cur = c.cursor()
                cur.execute(sql, args)
                rows = cur.fetchall() if fetch else None
                if self.kind != "mysql":
                    c.commit()
                return rows
            finally:
                c.close()

    def replace_all(self, trades):
        self.exec("DELETE FROM astk_trades")
        ph = ",".join(["(" + ",".join([self.param] * 14) + ")"] * len(trades)) if trades else ""
        if trades:
            flat = []
            for t in trades:
                flat += [t.get("id"), t.get("code"), t.get("name"), t.get("shares"),
                         t.get("buyPrice"), t.get("buyFee"), t.get("buyTime"), t.get("buyDate"),
                         t.get("sellPrice"), t.get("sellTime"), t.get("sellFee"),
                         t.get("pnl"), t.get("pct"), t.get("status")]
            # sqlite单语句多值; mysql/pg逐条更稳
            for i in range(len(trades)):
                row = flat[i * 14:(i + 1) * 14]
                self.exec("INSERT INTO astk_trades VALUES (" + ",".join([self.param] * 14) + ")", row)
        return len(trades)

    def load_all(self):
        rows = self.exec("SELECT id,code,name,shares,buy_price,buy_fee,buy_time,buy_date,"
                         "sell_price,sell_time,sell_fee,pnl,pct,status FROM astk_trades", fetch=True)
        keys = ["id", "code", "name", "shares", "buyPrice", "buyFee", "buyTime", "buyDate",
                "sellPrice", "sellTime", "sellFee", "pnl", "pct", "status"]
        out = []
        for r in rows or []:
            d = dict(zip(keys, r))
            for k in ("id", "shares", "buyTime", "sellTime"):
                d[k] = int(d[k]) if d[k] is not None else None
            out.append(d)
        out.sort(key=lambda t: t["id"])
        return out

DBI = None  # 惰性初始化(首次请求时)

# ---------------- HTTP ----------------
class Handler(SimpleHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        global DBI
        if self.path == "/api/db/ping":
            if DBI is None:
                DBI = DB(DB_URL)
            return self._json({"ok": True, "db": DBI.kind})
        if self.path == "/api/trades":
            if DBI is None:
                DBI = DB(DB_URL)
            return self._json({"ok": True, "trades": DBI.load_all()})
        return super().do_GET()

    def do_POST(self):
        global DBI
        if self.path == "/api/trades":
            try:
                if DBI is None:
                    DBI = DB(DB_URL)
                n = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(n))
                cnt = DBI.replace_all(body.get("trades") or [])
                return self._json({"ok": True, "count": cnt})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
        self.send_error(404)

    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    print("A股开仓本地服务 → http://localhost:%d  (局域网设备用本机IP访问)" % PORT)
    print("数据库连接: 环境变量 ASTK_DB_URL=mysql://user:pass@host:3306/db 或 postgres://...  缺省=SQLite本地文件")
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
