// A股开仓 — 行情/列表/K线/模拟交易 (纯前端, 数据存本地)
// 数据源: 腾讯行情(JSONP不封IP) + 东方财富(全市场列表/日K)

// ==================== 基础 ====================
const $ = (id) => document.getElementById(id);
const fmt2 = (n, d = 2) => (n === null || n === undefined || isNaN(n)) ? "--" : Number(n).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = (n) => (n === null || isNaN(n)) ? "--" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const fmtYi = (n) => { // 元 → 亿/万
  if (n === null || isNaN(n)) return "--";
  if (n >= 1e12) return (n / 1e12).toFixed(2) + "万亿";
  if (n >= 1e8) return (n / 1e8).toFixed(1) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
  return n.toFixed(0);
};
const clsOf = (n) => n > 0 ? "c-up" : n < 0 ? "c-down" : "";
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// 6位代码 → 腾讯前缀 (沪指数白名单 + 6/9沪 + 4/8/92北 + 其余深)
// 显式前缀(sh000001)直接透传: 000001 有"上证指数 vs 平安银行"歧义
const SH_IDX = new Set(["000300", "000905", "000016", "000688", "000852"]);
function txPrefix(code) {
  const c = code.toLowerCase();
  if (c.startsWith("sh") || c.startsWith("sz") || c.startsWith("bj")) return c.slice(0, 2);
  if (code.startsWith("92") || code.startsWith(("4")) || code.startsWith("8")) return "bj";
  if (code.startsWith("6") || code.startsWith("9") || SH_IDX.has(code)) return "sh";
  return "sz";
}
const emSecid = (code) => (code.startsWith("6") || code.startsWith("9") ? "1." : "0.") + code;

// 腾讯代码归一: 已带前缀(sh000001)原样使用, 裸6位码自动补前缀
const txFull = (c) => /^[a-z]{2}\d+$/i.test(c) ? c.toLowerCase() : txPrefix(c) + c;

// ==================== 腾讯行情 (JSONP, GBK, 不封IP) ====================
// qt.gtimg.cn 返回 v_shXXXXXX="..." 形式的变量赋值, script执行后读全局变量
function fetchTX(codes) {
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.charset = "GBK";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      const out = {};
      codes.forEach(c => {
        const raw = window["v_" + txFull(c)];
        if (typeof raw === "string") {
          const v = raw.split("~");
          if (v.length >= 50) out[c] = parseTX(v);
        }
      });
      s.remove();
      resolve(out);
    };
    const timer = setTimeout(done, 8000);
    s.onload = () => { clearTimeout(timer); done(); };
    s.onerror = () => { clearTimeout(timer); done(); };
    s.src = "https://qt.gtimg.cn/q=" + codes.map(txFull).join(",");
    document.head.appendChild(s);
  });
}
function parseTX(v) {
  const num = (x) => { const n = parseFloat(x); return isNaN(n) ? null : n; };
  return {
    name: v[1], code: v[2],
    price: num(v[3]), lastClose: num(v[4]), open: num(v[5]),
    changeAmt: num(v[31]), changePct: num(v[32]),
    high: num(v[33]), low: num(v[34]),
    volumeWan: num(v[36]),           // 成交量(手)
    amountWan: num(v[37]),           // 成交额(万元)
    turnoverPct: num(v[38]),         // 换手率%
    peTtm: num(v[39]),
    amplitudePct: num(v[43]),
    floatMcap: num(v[44]),           // 流通市值(亿)
    mcap: num(v[45]),                // 总市值(亿)
    pb: num(v[46]),
    limitUp: num(v[47]), limitDown: num(v[48]),
    volRatio: num(v[49]),
    time: v[30] || "",
  };
}

// ==================== 东方财富: 全市场列表(JSONP跨域 + 双主机回退) ====================
const EM_HOSTS = ["https://push2delay.eastmoney.com", "https://push2.eastmoney.com"];
const UNI_KEY = "astk_universe_v1";
let emJsonpSeq = 0;

function emJsonp(host, params, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const fn = "emcb_" + (++emJsonpSeq) + "_" + Date.now();
    const s = document.createElement("script");
    const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    let settled = false;
    const cleanup = () => { delete window[fn]; s.remove(); };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; cleanup(); reject(new Error("timeout"));
    }, timeoutMs);
    window[fn] = (d) => {
      if (settled) return;
      settled = true; clearTimeout(timer); cleanup(); resolve(d);
    };
    s.onerror = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); cleanup(); reject(new Error("load error"));
    };
    s.src = `${host}/api/qt/clist/get?${q}&cb=${fn}`;
    document.head.appendChild(s);
  });
}

async function emGet(url, params) {
  const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url + "?" + q, { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// 全量列表(约5900只): JSONP逐页拉取(服务端单页上限100条, 全量约60页)
async function tryFullUniverse() {
  let host = null;
  for (const h of EM_HOSTS) {
    try {
      const d = await emJsonp(h, {
        pn: "1", pz: "100", po: "0", np: "1", fltt: "2", invt: "2", fid: "f12",
        fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
        fields: "f2,f3,f6,f8,f12,f14",
      }, 7000);
      if (d?.data?.diff) { host = h; break; }
    } catch (e) { /* 换下一个主机 */ }
  }
  if (!host) return null;
  const rows = [];
  for (let pn = 1; pn <= 80; pn++) {
    let d;
    try {
      d = await emJsonp(host, {
        pn: String(pn), pz: "100", po: "0", np: "1", fltt: "2", invt: "2", fid: "f12",
        fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
        fields: "f2,f3,f6,f8,f12,f14",
      });
    } catch (e) { break; }
    const diff = d?.data?.diff;
    if (!diff || !diff.length) break;
    for (const it of diff) {
      const code = it.f12, name = it.f14;
      if (!code || !name) continue;
      const num = (x) => { const n = parseFloat(x); return isNaN(n) ? 0 : n; };
      rows.push({
        c: code, n: name,
        p: num(it.f2), ch: num(it.f3), amt: num(it.f6), turn: num(it.f8),
      });
    }
    const total = d?.data?.total || 0;
    if (diff.length < 100 || rows.length >= total) break;   // 到末页
    await new Promise(r => setTimeout(r, 60));
  }
  return rows.length > 5000 ? rows : null;
}

// 核心池 + 腾讯实时行情 → universe(立即可用)
async function loadCorePool() {
  const pool = BAKED_UNIVERSE.map(s => ({ ...s }));
  for (let i = 0; i < pool.length; i += 40) {
    const batch = pool.slice(i, i + 40);
    const q = await fetchTX(batch.map(s => s.c));
    batch.forEach(s => {
      const d = q[s.c];
      if (d && d.price) {
        s.p = d.price; s.ch = d.changePct ?? 0;
        s.amt = (d.amountWan || 0) * 1e4; s.turn = d.turnoverPct ?? 0;
        s.pe = d.peTtm; s.pb = d.pb; s.mc = d.mcap;
      } else { s.p = 0; s.ch = 0; s.amt = 0; s.turn = 0; }
    });
  }
  universe = pool;
  universeSource = `核心池${pool.length}只`;
}

// 全市场升级: 缓存(当日)优先, 否则东财JSONP分页拉取(约5900只)
async function upgradeUniverse(force = false) {
  if (upgrading) return;
  upgrading = true;
  setUniInfo("全市场加载中…");
  try {
    if (!force) {
      try {
        const cache = JSON.parse(localStorage.getItem(UNI_KEY) || "null");
        if (cache && cache.date === todayStr() && cache.rows?.length > 5000) {
          universe = cache.rows;
          universeSource = `全市场${cache.rows.length}只`;
          renderMarket();
          setUniInfo(null);
          upgrading = false;
          return;
        }
      } catch (e) { /* ignore */ }
    }
    const full = await tryFullUniverse();
    if (full) {
      universe = full;
      universeSource = `全市场${full.length}只`;
      try { localStorage.setItem(UNI_KEY, JSON.stringify({ date: todayStr(), rows: full })); } catch (e) {}
      renderMarket();
      setUniInfo(null);
    } else {
      setUniInfo("全量不可用(东财接口受阻), 用核心池 · 点此重试");
    }
  } finally { upgrading = false; }
}
let upgrading = false;
function setUniInfo(msg) {
  const el = $("uniRetry");
  if (!el) return;
  if (msg) { el.textContent = msg; el.classList.remove("hidden"); }
  else el.classList.add("hidden");
}

// ==================== 腾讯日K(前复权, CORS可用) ====================
async function fetchKline(code, lmt = 320) {
  const full = txFull(code);
  const r = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${full},day,,,${lmt},qfq`);
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  const node = d?.data?.[full];
  const rows = node?.qfqday || node?.day || [];
  return rows.map(p => ({ date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4], vol: +p[5] }));
}

// ==================== 状态 ====================
let universe = [];            // [{c,n,p,ch,amt,turn,pe,mc,pb}]
let curCode = null;           // 当前选中股票
let quote = null;             // 当前股票腾讯报价
let kline = [];               // 当前股票日K
let klineCode = null;
let timer = null;
const INDICES = [
  { code: "sh000001", name: "上证指数" },
  { code: "sz399001", name: "深证成指" },
  { code: "sz399006", name: "创业板指" },
  { code: "sh000300", name: "沪深300" },
];

// ==================== 交易时段 ====================
function marketState() {
  const d = new Date();
  const day = d.getDay();
  const hm = d.getHours() * 100 + d.getMinutes();
  if (day === 0 || day === 6) return " weekend";
  if (hm >= 915 && hm <= 1130) return "";
  if (hm >= 1300 && hm <= 1500) return "";
  return " weekend";
}
function stateLabel() {
  const s = marketState();
  if (s === "") return "🟢 交易中";
  const d = new Date(), hm = d.getHours() * 100 + d.getMinutes();
  if (d.getDay() !== 0 && d.getDay() !== 6 && hm > 1500) return "已收盘";
  return "休市·显示最后数据";
}

// ==================== 指数条 ====================
async function refreshIndices() {
  const q = await fetchTX([...INDICES.map(i => i.code), "sz000001"]);
  $("idxStrip").innerHTML = INDICES.map(i => {
    const d = q[i.code];
    if (!d) return "";
    return `<div class="idx-chip">
      <div class="ic-name">${i.name}</div>
      <div class="ic-val ${clsOf(d.changePct)}">${fmt2(d.price)}</div>
      <div class="ic-chg ${clsOf(d.changePct)}">${fmtPct(d.changePct)}</div>
    </div>`;
  }).join("") || "<span class='loading'>指数加载失败</span>";
  // 数据交易日: 用个股快照时间戳判断(指数时间戳恒为当前时刻, 个股才是数据时间)
  const stock = q["sz000001"];
  if (stock && stock.time && /^\d{14}$/.test(stock.time)) {
    const d = stock.time;
    const ymd = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const hm = `${d.slice(8, 10)}:${d.slice(10, 12)}`;
    tradeDateTxt = (ymd === todayStr() ? `今日 ${hm}` : `交易日 ${ymd} ${hm}`);
  }
}

// ==================== 市场总览 ====================
let rankTab = "up";
let rankPage = 1;
const RANK_PAGE_SIZE = 30;
function renderMarket() {
  if (!universe.length) return;
  const up = universe.filter(s => s.ch > 0).length;
  const down = universe.filter(s => s.ch < 0).length;
  const flat = universe.length - up - down;
  const totalAmt = universe.reduce((s, x) => s + (x.amt || 0), 0);
  const limUp = universe.filter(s => s.ch >= 9.9).length;
  const limDown = universe.filter(s => s.ch <= -9.9).length;
  $("universeInfo").textContent = `${universe.length}只沪深北A股 · 成交额${fmtYi(totalAmt)}` + (tradeDateTxt ? ` · ${tradeDateTxt}` : "");
  $("breadth").innerHTML =
    `<span>上涨 <b class="c-up">${up}</b></span><span>下跌 <b class="c-down">${down}</b></span>` +
    `<span>平 <b>${flat}</b></span><span>涨停级 <b class="c-up">${limUp}</b></span>` +
    `<span>跌停级 <b class="c-down">${limDown}</b></span>`;

  let all;
  if (rankTab === "up") all = [...universe].sort((a, b) => b.ch - a.ch);
  else if (rankTab === "down") all = [...universe].sort((a, b) => a.ch - b.ch);
  else if (rankTab === "amt") all = [...universe].sort((a, b) => (b.amt || 0) - (a.amt || 0));
  else all = [...universe].sort((a, b) => (b.turn || 0) - (a.turn || 0));
  const maxPage = Math.max(1, Math.ceil(all.length / RANK_PAGE_SIZE));
  if (rankPage > maxPage) rankPage = maxPage;
  if (rankPage < 1) rankPage = 1;
  const start = (rankPage - 1) * RANK_PAGE_SIZE;
  const rows = all.slice(start, start + RANK_PAGE_SIZE);
  $("rankList").innerHTML = rows.map((s, i) => `<div class="rk-row" data-code="${s.c}">
    <span class="rk-i">${start + i + 1}</span><span class="rk-code">${s.c}</span>
    <span class="rk-name">${s.n}</span><span class="rk-price">${fmt2(s.p)}</span>
    <span class="rk-chg ${clsOf(s.ch)}">${fmtPct(s.ch)}</span>
    <span class="rk-extra">${rankTab === "amt" ? "额" + fmtYi(s.amt) : rankTab === "turn" ? "换" + (s.turn || 0).toFixed(1) + "%" : "额" + fmtYi(s.amt)}</span>
  </div>`).join("");
  $("rankList").querySelectorAll(".rk-row").forEach(el =>
    el.addEventListener("click", () => selectStock(el.dataset.code)));

  // 分页条
  const pager = $("rankPager");
  if (all.length > RANK_PAGE_SIZE) {
    pager.classList.remove("hidden");
    $("pgPrev").disabled = rankPage <= 1;
    $("pgNext").disabled = rankPage >= maxPage;
    $("pgInfo").textContent = `第 ${rankPage} / ${maxPage} 页 · 共${all.length}只`;
    $("pgInput").max = maxPage;
    $("pgInput").value = rankPage;
  } else {
    pager.classList.add("hidden");
  }
}
function gotoRankPage(p) {
  rankPage = Math.max(1, Math.floor(+p || 1));
  renderMarket();
  $("rankList").scrollTop = 0;
}

// ==================== 个股详情 ====================
async function selectStock(code) {
  curCode = code;
  $("searchInput").value = "";
  $("searchDrop").classList.add("hidden");
  $("stockHint").textContent = "加载中…";
  $("quoteHead").innerHTML = "<span class='loading'>加载中…</span>";
  refreshQuote();
  loadKline();
}
async function refreshQuote() {
  if (!curCode) return;
  const q = await fetchTX([curCode]);
  const d = q[curCode];
  if (!d) { $("quoteHead").innerHTML = "<span class='loading'>行情获取失败</span>"; return; }
  quote = d;
  $("stockHint").textContent = `${d.name} · ${txPrefix(curCode).toUpperCase()}${curCode}`;
  $("quoteHead").innerHTML = `
    <span class="qh-name">${d.name}</span><span class="qh-code">${curCode}</span>
    <span class="qh-price ${clsOf(d.changePct)}">${fmt2(d.price)}</span>
    <span class="qh-chg ${clsOf(d.changePct)}">${d.changePct >= 0 ? "+" : ""}${fmt2(d.changeAmt)} ${fmtPct(d.changePct)}</span>
    <span class="qh-time">${d.time ? d.time.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3 $4:$5:$6") : ""}</span>`;
  const mg = (k, v, c = "") => `<div class="mg-cell"><span class="k">${k}</span><span class="v ${c}">${v}</span></div>`;
  $("metricGrid").innerHTML =
    mg("今开", fmt2(d.open)) + mg("昨收(T-1)", fmt2(d.lastClose)) +
    mg("最高", fmt2(d.high), "c-up") + mg("最低", fmt2(d.low), "c-down") +
    mg("成交量(手)", fmt2(d.volumeWan, 0)) + mg("成交额", fmtYi(d.amountWan * 1e4)) +
    mg("换手率", (d.turnoverPct ?? "--") + "%") + mg("振幅", (d.amplitudePct ?? "--") + "%") +
    mg("PE(TTM)", d.peTtm ?? "--") + mg("PB", d.pb ?? "--") +
    mg("总市值", (d.mcap ?? "--") + "亿") + mg("流通市值", (d.floatMcap ?? "--") + "亿") +
    mg("量比", d.volRatio ?? "--") +
    mg("涨停", fmt2(d.limitUp), "c-up") + mg("跌停", fmt2(d.limitDown), "c-down");
  updateBuyPreview();
  updatePositionsLive();
}

async function loadKline() {
  if (!curCode) return;
  $("klineChart").innerHTML = "<span class='loading'>K线加载中…</span>";
  try {
    kline = await fetchKline(curCode);
    klineCode = curCode;
  } catch (e) { $("klineChart").innerHTML = "<span class='loading'>K线获取失败</span>"; return; }
  if (!kline.length) { $("klineChart").innerHTML = "<span class='loading'>无K线数据</span>"; return; }
  renderKline();
}
function renderKline() {
  const W = 560, H = 200, PL = 62, PR = 10, PT = 10, PB = 20;
  const cw = W - PL - PR, chh = H - PT - PB;
  const closes = kline.map(k => k.close);
  const ma = (n) => closes.map((_, i) => i < n - 1 ? null : closes.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n);
  const ma20 = ma(20);
  const hi250 = Math.max(...kline.map(k => k.high));
  const lo250 = Math.min(...kline.map(k => k.low));
  const range = hi250 - lo250 || 1;
  const x = i => PL + (i / (kline.length - 1)) * cw;
  const y = p => PT + (1 - (p - lo250) / range) * chh;
  const chg = (closes[closes.length - 1] / closes[0] - 1) * 100;
  const lc = chg >= 0 ? "#e54545" : "#24b28c";
  const pts = closes.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(" ");
  const maPts = ma20.map((m, i) => m === null ? null : `${x(i).toFixed(1)},${y(m).toFixed(1)}`).filter(Boolean).join(" ");
  $("klineChart").innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    <line x1="${PL}" y1="${y(hi250)}" x2="${W-PR}" y2="${y(hi250)}" stroke="#2a3242" stroke-dasharray="3,3" stroke-width="0.5"/>
    <line x1="${PL}" y1="${y(lo250)}" x2="${W-PR}" y2="${y(lo250)}" stroke="#2a3242" stroke-dasharray="3,3" stroke-width="0.5"/>
    <text x="${PL-4}" y="${y(hi250)+3}" text-anchor="end" font-size="8.5" fill="#7a8299">${fmt2(hi250)}</text>
    <text x="${PL-4}" y="${y(lo250)+3}" text-anchor="end" font-size="8.5" fill="#7a8299">${fmt2(lo250)}</text>
    <polyline points="${maPts}" fill="none" stroke="#f0b90b" stroke-width="1" opacity="0.75"/>
    <polygon points="${PL},${H-PB} ${pts} ${x(closes.length-1)},${H-PB}" fill="${lc}" opacity="0.07"/>
    <polyline points="${pts}" fill="none" stroke="${lc}" stroke-width="1.5"/>
    <circle cx="${x(closes.length-1)}" cy="${y(closes[closes.length-1])}" r="2.6" fill="${lc}"/>
    <text x="${W-PR}" y="13" text-anchor="end" font-size="10.5" fill="${lc}" font-weight="700">${fmtPct(chg)}</text>
    <text x="${PL}" y="${H-6}" font-size="8" fill="#7a8299">${kline[0].date}</text>
    <text x="${W-PR}" y="${H-6}" text-anchor="end" font-size="8" fill="#7a8299">${kline[kline.length-1].date} · 黄线MA20</text>
  </svg>`;

  const chgN = (n) => closes.length > n ? (closes[closes.length - 1] / closes[closes.length - 1 - n] - 1) * 100 : null;
  const cell = (k, v) => `<div class="rs-cell"><span class="k">${k}</span><b class="${clsOf(v)}">${fmtPct(v)}</b></div>`;
  $("rangeStats").innerHTML =
    cell("近5日", chgN(5)) + cell("近20日", chgN(20)) + cell("近60日", chgN(60)) + cell("近250日", chgN(250)) +
    `<div class="rs-cell"><span class="k">250日高</span><b>${fmt2(hi250)}</b></div>` +
    `<div class="rs-cell"><span class="k">250日低</span><b>${fmt2(lo250)}</b></div>`;
}

// ==================== 模拟交易 (T+1, 无杠杆) ====================
const TRADE_KEY = "astk_trades_v1";
const loadTrades = () => { try { return JSON.parse(localStorage.getItem(TRADE_KEY)) || []; } catch (e) { return []; } };
const saveTrades = (l) => localStorage.setItem(TRADE_KEY, JSON.stringify(l));
// 手续费: 佣金万2.5(最低5元) 双向 + 印花税万5 卖出 + 过户费万0.1 双向
const buyFee = (amt) => Math.max(5, amt * 0.00025) + amt * 0.00001;
const sellFee = (amt) => Math.max(5, amt * 0.00025) + amt * 0.0005 + amt * 0.00001;

function updateBuyPreview() {
  if (!quote) { $("buyPreview").textContent = ""; return; }
  const amt = +$("buyAmount").value || 0;
  if (amt < 100) { $("buyPreview").textContent = "金额太小"; return; }
  const shares = Math.floor(amt / quote.price / 100) * 100;
  if (shares < 100) { $("buyPreview").textContent = "不足一手(100股), 需至少 " + fmt2(quote.price * 100, 0) + " 元"; return; }
  const cost = shares * quote.price;
  const fee = buyFee(cost);
  $("buyPreview").innerHTML =
    `按现价 ${fmt2(quote.price)} 买入 <b>${shares}股</b> · 本金 ${fmt2(cost, 0)}元 · 费用 ${fee.toFixed(2)}元 · 合计 <b>${fmt2(cost + fee, 0)}</b>元 (余 ${fmt2(amt - cost - fee)} 元不计)`;
}
$("buyAmount").addEventListener("input", updateBuyPreview);

$("buyBtn").addEventListener("click", () => {
  if (!quote || !curCode) { alert("请先选择股票"); return; }
  if (quote.price <= 0) { alert("价格无效"); return; }
  const amt = +$("buyAmount").value || 0;
  const shares = Math.floor(amt / quote.price / 100) * 100;
  if (shares < 100) { alert("金额不足一手(100股)"); return; }
  const cost = shares * quote.price;
  const fee = buyFee(cost);
  const list = loadTrades();
  list.push({
    id: Date.now(), code: curCode, name: quote.name,
    shares, buyPrice: quote.price, buyFee: +fee.toFixed(2),
    buyTime: Date.now(), buyDate: todayStr(),
    sellPrice: null, sellTime: null, sellFee: null,
    pnl: null, pct: null, status: "hold",
  });
  saveTrades(list);
  renderPositions();
  dbAutoSync();
});

const sellable = (t) => t.buyDate !== todayStr();   // T+1: 买入当日不可卖

function renderPositions() {
  const list = loadTrades().filter(t => t.status === "hold");
  if (!list.length) { $("posList").innerHTML = "<span class='loading'>暂无持仓</span>"; $("posSummary").textContent = ""; return; }
  $("posList").innerHTML = list.map(t => `<div class="pos-card" data-id="${t.id}">
    <div class="pos-head">
      <span class="pc-name">${t.name}</span><span class="pc-code">${t.code}</span>
      <span class="t1-tag">${sellable(t) ? "" : "🔒T+1今日不可卖"}</span>
      <span class="pc-pnl" data-pnl="${t.id}">…</span>
    </div>
    <div class="pc-rows">
      <span>${t.shares}股 @${fmt2(t.buyPrice)}</span><span>本金${fmt2(t.shares * t.buyPrice, 0)}</span>
      <span>买入费${t.buyFee}元</span><span>${t.buyDate}</span>
    </div>
    <div class="pc-actions">
      <button class="sell-btn" data-id="${t.id}" ${sellable(t) ? "" : "disabled"}>💰 卖出平仓</button>
    </div>
  </div>`).join("");
  $("posList").querySelectorAll(".sell-btn").forEach(b =>
    b.addEventListener("click", () => sellTrade(+b.dataset.id)));
  updatePositionsLive();
}

async function updatePositionsLive() {
  const list = loadTrades().filter(t => t.status === "hold");
  if (!list.length) return;
  const q = await fetchTX([...new Set(list.map(t => t.code))]);
  let totalPnl = 0, totalCost = 0;
  list.forEach(t => {
    const d = q[t.code];
    const el = document.querySelector(`[data-pnl="${t.id}"]`);
    if (!d || !el) return;
    const gross = (d.price - t.buyPrice) * t.shares;
    const est = gross - t.buyFee - sellFee(d.price * t.shares);
    totalPnl += est; totalCost += t.shares * t.buyPrice;
    el.textContent = `${est >= 0 ? "+" : ""}${est.toFixed(0)}元 (${(est / (t.shares * t.buyPrice) * 100).toFixed(2)}%) · 现${fmt2(d.price)}`;
    el.className = "pc-pnl " + clsOf(est);
  });
  if (totalCost > 0) $("posSummary").textContent = `共${list.length}只 · 投入${fmt2(totalCost, 0)}元 · 浮动${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}元`;
}

function sellTrade(id) {
  const list = loadTrades();
  const t = list.find(x => x.id === id);
  if (!t || t.status !== "hold") return;
  if (!sellable(t)) { alert("T+1: 今日买入, 明天才能卖"); return; }
  // 用当前报价成交
  const uni = universe.find(s => s.c === t.code);
  const px = (quote && curCode === t.code) ? quote.price : (uni ? uni.p : null);
  if (!px || px <= 0) { alert("获取卖出价失败, 请刷新重试"); return; }
  const gross = px * t.shares;
  const fee = sellFee(gross);
  t.sellPrice = px;
  t.sellFee = +fee.toFixed(2);
  t.sellTime = Date.now();
  t.pnl = +((px - t.buyPrice) * t.shares - t.buyFee - fee).toFixed(2);
  t.pct = +(t.pnl / (t.shares * t.buyPrice) * 100).toFixed(2);
  t.status = "closed";
  saveTrades(list);
  renderPositions();
  renderHistory();
  dbAutoSync();
}

function renderHistory() {
  const closed = loadTrades().filter(t => t.status === "closed").sort((a, b) => b.sellTime - a.sellTime);
  if (!closed.length) { $("histList").innerHTML = "<span class='loading'>暂无交易</span>"; $("histSummary").textContent = ""; return; }
  const wins = closed.filter(t => t.pnl > 0).length;
  const total = closed.reduce((s, t) => s + t.pnl, 0);
  $("histSummary").textContent = `${closed.length}笔 · 胜率${(wins / closed.length * 100).toFixed(0)}% · 净收益${total >= 0 ? "+" : ""}${total.toFixed(0)}元`;
  $("histList").innerHTML = closed.slice(0, 30).map(t => {
    const days = t.sellTime ? Math.max(1, Math.round((t.sellTime - t.buyTime) / 86400000)) : "--";
    return `<div class="hist-row">
      <span class="hr-date">${new Date(t.sellTime).toLocaleDateString("zh-CN")}</span>
      <span class="hr-name">${t.name}</span>
      <span class="hr-detail">${fmt2(t.buyPrice)}→${fmt2(t.sellPrice)} ${t.shares}股 ${days}天 费${(t.buyFee + t.sellFee).toFixed(0)}元</span>
      <span class="hr-pnl ${clsOf(t.pnl)}">${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)}元 ${fmtPct(t.pct)}</span>
    </div>`;
  }).join("");
}

// ==================== 搜索 ====================
$("searchInput").addEventListener("input", (e) => {
  const kw = e.target.value.trim().toLowerCase();
  const drop = $("searchDrop");
  if (!kw || !universe.length) { drop.classList.add("hidden"); return; }
  const hits = universe.filter(s => s.c.startsWith(kw) || s.n.toLowerCase().includes(kw)).slice(0, 12);
  if (!hits.length) { drop.classList.add("hidden"); return; }
  drop.innerHTML = hits.map(s => `<div class="sd-row" data-code="${s.c}">
    <span class="sd-code">${s.c}</span><span class="sd-name">${s.n}</span>
    <span class="${clsOf(s.ch)}">${fmt2(s.p)} ${fmtPct(s.ch)}</span>
  </div>`).join("");
  drop.classList.remove("hidden");
  drop.querySelectorAll(".sd-row").forEach(el =>
    el.addEventListener("click", () => selectStock(el.dataset.code)));
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box")) $("searchDrop").classList.add("hidden");
});

// ==================== 榜单tab & 分页 ====================
document.querySelectorAll(".rt-btn").forEach(b =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".rt-btn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    rankTab = b.dataset.tab;
    rankPage = 1;   // 切榜回到第一页
    renderMarket();
  }));
$("pgPrev").addEventListener("click", () => gotoRankPage(rankPage - 1));
$("pgNext").addEventListener("click", () => gotoRankPage(rankPage + 1));
$("pgGo").addEventListener("click", () => gotoRankPage(+$("pgInput").value));
$("pgInput").addEventListener("keydown", (e) => { if (e.key === "Enter") gotoRankPage(+$("pgInput").value); });


// ==================== 数据库同步(桥接服务 server.py) ====================
// 浏览器无法直连数据库, 通过局域网桥接服务HTTP转发; 未连接时一切功能照常(localStorage)
const DB_URL_KEY = "astk_db_url";
let dbOnline = false;

function dbBase() { return (localStorage.getItem(DB_URL_KEY) || "http://localhost:8765").replace(/\/$/, ""); }

// 混合内容检测: https页面(GitHub Pages)无法直连http内网地址, 唯一豁免localhost
function dbBlockedByMixedContent(url) {
  return location.protocol === "https:" &&
    /^http:\/\//i.test(url) &&
    !/\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(url);
}

async function dbPing(silent = false) {
  const el = $("dbStatus");
  if (dbBlockedByMixedContent(dbBase())) {
    dbOnline = false;
    el.innerHTML = '● <span class="db-off">被浏览器拦截</span> · https页面不能直连http内网地址, 改用 <b>http://localhost:8088/astk</b>(Mac先执行ssh转发) 或直接访问网关页 http://10.168.1.178:8088/astk/';
    return false;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(dbBase() + "/api/db/ping", { signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    if (d.ok) {
      dbOnline = true;
      el.innerHTML = '● <span class="db-on">在线</span> · ' + d.db;
      return true;
    }
    throw new Error(d.error || "失败");
  } catch (e) {
    dbOnline = false;
    if (!silent) el.innerHTML = '● <span class="db-off">离线</span> · ' + (e.message === "The user aborted a request." ? "连不上桥接服务" : e.message);
    return false;
  }
}

async function dbPush() {
  if (!dbOnline) return;
  try {
    await fetch(dbBase() + "/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trades: loadTrades() }),
    });
  } catch (e) { dbOnline = false; $("dbStatus").innerHTML = '● <span class="db-off">离线</span>'; }
}

async function dbPull() {
  if (!dbOnline) return;
  try {
    const r = await fetch(dbBase() + "/api/trades");
    const d = await r.json();
    if (d.ok && Array.isArray(d.trades)) {
      saveTrades(d.trades);
      renderPositions();
      renderHistory();
      $("dbStatus").innerHTML = '● <span class="db-on">在线</span> · 已从库载入' + d.trades.length + "笔";
    }
  } catch (e) { /* 保持本地 */ }
}

$("dbTest").addEventListener("click", async () => {
  localStorage.setItem(DB_URL_KEY, $("dbUrl").value.trim() || "http://localhost:8765");
  $("dbStatus").innerHTML = "连接中…";
  if (await dbPing()) await dbPull();
});
$("dbSync").addEventListener("click", async () => {
  localStorage.setItem(DB_URL_KEY, $("dbUrl").value.trim() || "http://localhost:8765");
  if (await dbPing()) { await dbPush(); await dbPull(); }
});

// 买卖后自动推送
function dbAutoSync() { if ($("dbAuto")?.checked && dbOnline) dbPush(); }

async function dbInit() {
  let def = localStorage.getItem(DB_URL_KEY) || "http://localhost:8765";
  // 经Kong网关打开时默认同源(http页面无跨域限制)
  if (!localStorage.getItem(DB_URL_KEY) && location.protocol === "http:" && /:8088$/.test(location.host)) {
    def = location.origin + "/astk";
  }
  $("dbUrl").value = def;
  if (await dbPing(true)) await dbPull();
}


// ==================== 行业研究 ====================
// 同花顺行业代码/名称 → 东财行业板块 → 成分股实时行情
const IND_KEY = "astk_industry";
let indBoards = null, indBoardsTime = 0;   // 东财行业板块缓存
let curInd = null;                          // {code,name,bk,bkName}

function resolveIndustry(q) {
  q = (q || "").trim();
  if (!q) return null;
  let m = q.toUpperCase().match(/^(\d{6})(\.TI)?$/);
  if (m && THS_INDUSTRIES[m[1]]) return { code: m[1], name: THS_INDUSTRIES[m[1]] };
  q = q.replace(/\.ti$/i, "");
  const lower = q.toLowerCase();
  // 名称精确 → 前缀
  for (const [c, n] of Object.entries(THS_INDUSTRIES)) {
    if (n === q || n.toLowerCase() === lower) return { code: c, name: n };
  }
  for (const [c, n] of Object.entries(THS_INDUSTRIES)) {
    if (n.includes(q) || q.includes(n)) return { code: c, name: n };
  }
  return null;
}

async function loadIndBoards() {
  if (indBoards && Date.now() - indBoardsTime < 600000) return indBoards;
  const all = [];
  for (let pn = 1; pn <= 8; pn++) {
    const d = await emJsonp("https://push2delay.eastmoney.com", {
      pn: String(pn), pz: "100", po: "1", np: "1", fltt: "2", invt: "2", fid: "f12",
      fs: "m:90+t:2", fields: "f3,f12,f14",
    }, 9000).catch(() => null);
    const diff = d?.data?.diff;
    if (!diff || !diff.length) break;
    for (const b of diff) all.push({ bk: b.f12, name: b.f14, chg: +b.f3 || 0 });
    if (all.length >= (d?.data?.total || 0) || diff.length < 100) break;
  }
  if (all.length) { indBoards = all; indBoardsTime = Date.now(); }
  return indBoards || [];
}

// 名称匹配东财板块: 原名全等 > THS名+行业 > 归一全等 > 最小长度差包含
// (避免"电力"误配"电力设备"这类制造板块)
function matchBoard(indName) {
  const norm = (x) => x.replace(/行业|板块|Ⅰ|Ⅱ|Ⅲ/g, "");
  const t = indName;
  let hit = indBoards.find(b => b.name === t);
  if (hit) return hit;
  hit = indBoards.find(b => b.name === t + "行业");
  if (hit) return hit;
  hit = indBoards.find(b => norm(b.name) === t);
  if (hit) return hit;
  let best = null, bestDiff = 99;
  for (const b of indBoards) {
    const bn = norm(b.name);
    if (bn.includes(t) || t.includes(bn)) {
      const d = Math.abs(bn.length - t.length);
      if (d < bestDiff) { bestDiff = d; best = b; }
    }
  }
  return best;
}

async function fetchBoardStocks(bk) {
  const rows = [];
  for (let pn = 1; pn <= 3; pn++) {
    const d = await emJsonp("https://push2delay.eastmoney.com", {
      pn: String(pn), pz: "100", po: "1", np: "1", fltt: "2", invt: "2", fid: "f3",
      fs: "b:" + bk, fields: "f2,f3,f6,f8,f9,f12,f14,f23",
    }, 9000).catch(() => null);
    const diff = d?.data?.diff;
    if (!diff || !diff.length) break;
    const num = (x) => { const n = parseFloat(x); return isNaN(n) ? 0 : n; };
    for (const it of diff) {
      rows.push({ c: it.f12, n: it.f14, p: num(it.f2), ch: num(it.f3),
        amt: num(it.f6), turn: num(it.f8), pe: it.f9, pb: it.f23 });
    }
    if (diff.length < 100) break;
  }
  rows.sort((a, b) => b.ch - a.ch);
  return rows;
}

async function researchIndustry(query) {
  const ind = resolveIndustry(query);
  const title = $("indTitle"), listEl = $("indList"), br = $("indBreadth");
  if (!ind) { title.innerHTML = '<span style="color:var(--up)">未识别行业代码/名称</span>'; return; }
  curInd = ind;
  localStorage.setItem(IND_KEY, ind.code);
  title.innerHTML = "加载中…";
  await loadIndBoards();
  const b = matchBoard(ind.name);
  if (!b) {
    title.innerHTML = `<b>${ind.name}</b> (${ind.code}.TI) · <span style="color:var(--up)">未找到对应东财板块, 试试行业别名</span>`;
    br.innerHTML = ""; listEl.innerHTML = "";
    return;
  }
  curInd.bk = b.bk; curInd.bkName = b.name;
  const rows = await fetchBoardStocks(b.bk);
  const up = rows.filter(r => r.ch > 0).length, down = rows.filter(r => r.ch < 0).length;
  const avg = rows.length ? rows.reduce((s, r) => s + r.ch, 0) / rows.length : 0;
  const amt = rows.reduce((s, r) => s + r.amt, 0);
  title.innerHTML = `<b style="color:var(--accent)">${ind.name}</b> (${ind.code}.TI) · 板块今日 <b class="${clsOf(b.chg)}">${fmtPct(b.chg)}</b>`;
  br.innerHTML =
    `<span>成分 <b>${rows.length}</b>只(东财:${b.name})</span><span>上涨 <b class="c-up">${up}</b></span>` +
    `<span>下跌 <b class="c-down">${down}</b></span><span>平均 <b class="${clsOf(avg)}">${fmtPct(avg)}</b></span>` +
    `<span>合计成交额 <b>${fmtYi(amt)}</b></span>` +
    (rows.length ? `<span>领涨 <b class="c-up">${rows[0].n} ${fmtPct(rows[0].ch)}</b></span>` : "");
  listEl.innerHTML = rows.map((r, i) => `<div class="rk-row" data-code="${r.c}">
    <span class="rk-i">${i + 1}</span><span class="rk-code">${r.c}</span>
    <span class="rk-name">${r.n}</span><span class="rk-price">${fmt2(r.p)}</span>
    <span class="rk-chg ${clsOf(r.ch)}">${fmtPct(r.ch)}</span>
    <span class="rk-extra">额${fmtYi(r.amt)} 换${r.turn.toFixed(1)}% PE${r.pe ?? "--"}</span>
  </div>`).join("");
  listEl.querySelectorAll(".rk-row").forEach(el =>
    el.addEventListener("click", () => selectStock(el.dataset.code)));
}

$("indGo").addEventListener("click", () => researchIndustry($("indInput").value));
$("indInput").addEventListener("keydown", (e) => { if (e.key === "Enter") researchIndustry($("indInput").value); });

// ==================== 刷新调度 ====================
async function refreshAll() {
  $("statusDot").className = "dot";
  await Promise.all([refreshIndices(), refreshQuote()]);
  $("mktState").textContent = stateLabel();
  $("statusDot").className = "dot ok";
  $("lastUpdate").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}
function startTimer() {
  clearInterval(timer);
  const sec = +$("intervalSel").value;
  if (sec > 0) timer = setInterval(refreshAll, sec * 1000);
}
$("intervalSel").addEventListener("change", startTimer);
$("refreshBtn").addEventListener("click", refreshAll);
$("uniRetry").addEventListener("click", () => upgradeUniverse(true));

// ==================== 启动 ====================
(async function init() {
  $("mktState").textContent = stateLabel();
  refreshIndices();
  await loadCorePool();       // 核心池秒开
  renderMarket();
  renderPositions();
  renderHistory();
  selectStock("600519");   // 默认茅台
  researchIndustry(localStorage.getItem(IND_KEY) || "881145");   // 恢复上次行业(默认电力)
  dbInit();               // 数据库同步(连得上就自动拉取, 连不上静默本地)
  refreshAll();
  startTimer();
  upgradeUniverse();          // 后台升级全市场(~5900只), 成功自动重渲染
})();
