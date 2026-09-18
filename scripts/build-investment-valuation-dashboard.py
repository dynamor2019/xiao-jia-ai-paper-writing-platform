"""Build a public-data PE valuation dashboard for long-term stock tracking."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from time import sleep
from contextlib import contextmanager

import akshare as ak
import pandas as pd


OUTPUT_PATH = Path("output/investment-valuation/index.html")
YEARS_BACK = 5
SOURCE_NAME = (
    "百度股市通 A 股估值数据、东方财富 A 股行情数据与乐咕乐股市场估值数据，"
    "经 AkShare stock_zh_valuation_baidu / stock_zh_a_hist / stock_market_pe_lg 获取"
)
COMPANIES = (
    ("600036", "招商银行", "银行"),
    ("600900", "长江电力", "公用事业"),
    ("600941", "中国移动", "通信运营"),
    ("601138", "工业富联", "电子制造"),
    ("000651", "格力电器", "家用电器"),
)
MARKETS = (
    ("hs300", "沪深300", "index", "沪深300"),
    ("sz", "深证A股", "market", "深证"),
    ("cyb", "创业板", "market", "创业板"),
)


@contextmanager
def without_proxy() -> object:
    """Temporarily clear proxy environment variables for public data calls."""

    proxy_keys = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ]
    old_values = {key: os.environ.get(key) for key in proxy_keys}
    for key in proxy_keys:
        os.environ.pop(key, None)
    try:
        yield
    finally:
        for key, value in old_values.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@dataclass(frozen=True)
class CompanySeries:
    """Quarterly PE series and valuation bands for one company."""

    code: str
    name: str
    sector: str
    quarters: list[dict[str, float | str]]
    mean: float
    std: float
    lower: float
    upper: float
    latest_pe: float
    latest_price: float
    latest_percentile: float
    price_change_4q: float
    eps_change_4q: float
    pe_change_4q: float
    valuation_reason: str
    latest_quarter: str
    status: str
    coverage_note: str


@dataclass(frozen=True)
class MarketSeries:
    """Quarterly PE series and percentile for one market board."""

    code: str
    name: str
    quarters: list[dict[str, float | str]]
    mean: float
    std: float
    lower: float
    upper: float
    latest_pe: float
    latest_percentile: float
    latest_quarter: str
    status: str


def fetch_pe_series(code: str) -> pd.DataFrame:
    """Fetch PE(TTM) records from the public Baidu Gushitong valuation API."""

    frame = pd.DataFrame()
    for attempt in range(3):
        try:
            frame = ak.stock_zh_valuation_baidu(
                symbol=code,
                indicator="市盈率(TTM)",
                period="近十年",
            )
            break
        except Exception:
            if attempt == 2:
                raise
            sleep(1.5 * (attempt + 1))
    frame = frame.rename(columns={"date": "date", "value": "pe_ttm"})
    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame["pe_ttm"] = pd.to_numeric(frame["pe_ttm"], errors="coerce")
    return frame.dropna(subset=["date", "pe_ttm"]).sort_values("date")


def fetch_market_pe_series(code: str, kind: str, symbol: str) -> pd.DataFrame:
    """Fetch public market or index PE records."""

    frame = pd.DataFrame()
    for attempt in range(3):
        try:
            if kind == "index":
                frame = ak.stock_index_pe_lg(symbol=symbol)
            else:
                frame = ak.stock_market_pe_lg(symbol=symbol)
            break
        except Exception:
            if attempt == 2:
                raise
            sleep(1.5 * (attempt + 1))
    date_column = frame.columns[0]
    close_column = frame.columns[1]
    pe_column = frame.columns[6] if kind == "index" else frame.columns[2]
    market = frame.loc[:, [date_column, close_column, pe_column]].copy()
    market.columns = ["date", "close", "pe_ttm"]
    market["date"] = pd.to_datetime(market["date"], errors="coerce")
    market["close"] = pd.to_numeric(market["close"], errors="coerce")
    market["pe_ttm"] = pd.to_numeric(market["pe_ttm"], errors="coerce")
    return market.dropna(subset=["date", "pe_ttm"]).sort_values("date")


def fetch_price_series(code: str, start_date: pd.Timestamp, end_date: pd.Timestamp) -> pd.DataFrame:
    """Fetch forward-adjusted daily closing prices from public quote APIs."""

    frame = pd.DataFrame()
    for attempt in range(3):
        try:
            with without_proxy():
                frame = ak.stock_zh_a_hist(
                    symbol=code,
                    period="daily",
                    start_date=start_date.strftime("%Y%m%d"),
                    end_date=end_date.strftime("%Y%m%d"),
                    adjust="qfq",
                    timeout=15,
                )
            break
        except Exception:
            if attempt == 2:
                tx_symbol = f"{'sh' if code.startswith('6') else 'sz'}{code}"
                frame = ak.stock_zh_a_hist_tx(
                    symbol=tx_symbol,
                    start_date=start_date.strftime("%Y%m%d"),
                    end_date=end_date.strftime("%Y%m%d"),
                    adjust="qfq",
                    timeout=15,
                )
                break
            sleep(1.5 * (attempt + 1))
    date_column = "date" if "date" in frame.columns else frame.columns[0]
    close_column = "close" if "close" in frame.columns else frame.columns[3]
    prices = frame.loc[:, [date_column, close_column]].copy()
    prices.columns = ["date", "close_price"]
    prices["date"] = pd.to_datetime(prices["date"], errors="coerce")
    prices["close_price"] = pd.to_numeric(prices["close_price"], errors="coerce")
    return prices.dropna(subset=["date", "close_price"]).sort_values("date")


def to_quarterly(frame: pd.DataFrame) -> pd.DataFrame:
    """Keep the last available PE observation in each calendar quarter."""

    end_date = frame["date"].max()
    start_date = end_date - pd.DateOffset(years=YEARS_BACK)
    scoped = frame.loc[frame["date"].between(start_date, end_date)].copy()
    scoped["quarter"] = scoped["date"].dt.to_period("Q").astype(str)
    quarterly = scoped.groupby("quarter", as_index=False).tail(1)
    return quarterly.reset_index(drop=True)


def to_quarterly_prices(frame: pd.DataFrame) -> pd.DataFrame:
    """Keep the last available closing price in each calendar quarter."""

    prices = frame.copy()
    prices["quarter"] = prices["date"].dt.to_period("Q").astype(str)
    quarterly = prices.groupby("quarter", as_index=False).tail(1)
    return quarterly.loc[:, ["quarter", "close_price"]].reset_index(drop=True)


def classify_valuation(latest_pe: float, mean: float, std: float) -> str:
    """Classify the latest valuation versus the mean plus/minus one sigma."""

    if latest_pe > mean + std:
        return "高于估值带"
    if latest_pe < mean - std:
        return "低于估值带"
    return "位于估值带"


def percentile_rank(values: pd.Series, latest_value: float) -> float:
    """Return the inclusive percentile rank of the latest PE in the sample."""

    less_count = int((values < latest_value).sum())
    equal_count = int((values == latest_value).sum())
    percentile = (less_count + 0.5 * equal_count) / len(values) * 100
    return float(percentile)


def percent_change(current: float, previous: float) -> float:
    """Calculate percent change while guarding against invalid baselines."""

    if previous == 0:
        return 0.0
    return (current - previous) / previous * 100


def explain_valuation(
    percentile: float,
    price_change: float,
    eps_change: float,
    pe_change: float,
) -> str:
    """Explain whether low valuation is driven more by earnings or sentiment."""

    if percentile > 40:
        return "当前估值不算明显偏低，暂不做低估归因。"
    if eps_change >= 10 and price_change >= 0:
        return "偏低更像业绩上涨摊薄 PE：隐含 EPS 上升快于估值扩张。"
    if price_change <= -10 and eps_change <= 10:
        return "偏低更像市场压低估值：股价走弱，反映外界预期下修。"
    if eps_change >= 10 and price_change < 0:
        return "偏低来自业绩改善与市场压估值共同作用。"
    if pe_change <= -10:
        return "PE 明显回落，但业绩和股价贡献不单一，需结合财报验证。"
    return "估值偏低幅度有限，暂未显示单一主因。"


def build_company_series(code: str, name: str, sector: str) -> CompanySeries:
    """Create a dashboard-ready company valuation series."""

    quarterly = to_quarterly(fetch_pe_series(code))
    price_frame = fetch_price_series(code, quarterly["date"].min(), quarterly["date"].max())
    quarterly = quarterly.merge(to_quarterly_prices(price_frame), on="quarter", how="left")
    quarterly["implied_eps"] = quarterly["close_price"] / quarterly["pe_ttm"]
    values = quarterly["pe_ttm"].astype(float)
    mean = float(values.mean())
    std = float(values.std(ddof=0))
    latest_pe = float(values.iloc[-1])
    latest_price = float(quarterly["close_price"].iloc[-1])
    latest_percentile = percentile_rank(values, latest_pe)
    base_index = max(0, len(quarterly) - 5)
    base_row = quarterly.iloc[base_index]
    latest_eps = float(quarterly["implied_eps"].iloc[-1])
    price_change_4q = percent_change(latest_price, float(base_row.close_price))
    eps_change_4q = percent_change(latest_eps, float(base_row.implied_eps))
    pe_change_4q = percent_change(latest_pe, float(base_row.pe_ttm))
    valuation_reason = explain_valuation(
        latest_percentile,
        price_change_4q,
        eps_change_4q,
        pe_change_4q,
    )
    latest_quarter = str(quarterly["quarter"].iloc[-1])
    quarters = [
        {
            "quarter": str(row.quarter),
            "date": row.date.strftime("%Y-%m-%d"),
            "pe": round(float(row.pe_ttm), 2),
            "price": round(float(row.close_price), 2),
            "implied_eps": round(float(row.implied_eps), 2),
        }
        for row in quarterly.itertuples(index=False)
    ]
    first_quarter = str(quarterly["quarter"].iloc[0])
    coverage_note = f"{first_quarter} 至 {latest_quarter}，季度末/近季度最后可得值"
    return CompanySeries(
        code=code,
        name=name,
        sector=sector,
        quarters=quarters,
        mean=round(mean, 2),
        std=round(std, 2),
        lower=round(mean - std, 2),
        upper=round(mean + std, 2),
        latest_pe=round(latest_pe, 2),
        latest_price=round(latest_price, 2),
        latest_percentile=round(latest_percentile, 1),
        price_change_4q=round(price_change_4q, 1),
        eps_change_4q=round(eps_change_4q, 1),
        pe_change_4q=round(pe_change_4q, 1),
        valuation_reason=valuation_reason,
        latest_quarter=latest_quarter,
        status=classify_valuation(latest_pe, mean, std),
        coverage_note=coverage_note,
    )


def build_market_series(code: str, name: str, kind: str, symbol: str) -> MarketSeries:
    """Create a dashboard-ready market valuation series."""

    quarterly = to_quarterly(fetch_market_pe_series(code, kind, symbol))
    values = quarterly["pe_ttm"].astype(float)
    mean = float(values.mean())
    std = float(values.std(ddof=0))
    latest_pe = float(values.iloc[-1])
    latest_percentile = percentile_rank(values, latest_pe)
    latest_quarter = str(quarterly["quarter"].iloc[-1])
    quarters = [
        {
            "quarter": str(row.quarter),
            "date": row.date.strftime("%Y-%m-%d"),
            "pe": round(float(row.pe_ttm), 2),
        }
        for row in quarterly.itertuples(index=False)
    ]
    return MarketSeries(
        code=code,
        name=name,
        quarters=quarters,
        mean=round(mean, 2),
        std=round(std, 2),
        lower=round(mean - std, 2),
        upper=round(mean + std, 2),
        latest_pe=round(latest_pe, 2),
        latest_percentile=round(latest_percentile, 1),
        latest_quarter=latest_quarter,
        status=classify_valuation(latest_pe, mean, std),
    )


def build_payload() -> dict[str, object]:
    """Fetch all company data and return a serializable dashboard payload."""

    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    companies = [build_company_series(*company) for company in COMPANIES]
    markets = [build_market_series(*market) for market in MARKETS]
    return {
        "generatedAt": generated_at,
        "yearsBack": YEARS_BACK,
        "source": SOURCE_NAME,
        "companies": [company.__dict__ for company in companies],
        "markets": [market.__dict__ for market in markets],
    }


def render_html(payload: dict[str, object]) -> str:
    """Render a self-contained dashboard with SVG charts and embedded data."""

    data_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>长线投资估值观察台</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --ink: #17202a;
      --muted: #64748b;
      --line: #d7dde8;
      --blue: #2563eb;
      --green: #0f9f6e;
      --amber: #b7791f;
      --red: #c2410c;
      --purple: #7c3aed;
      --band: rgba(37, 99, 235, 0.12);
      --shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
      font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--ink);
    }}
    header {{
      padding: 28px 32px 18px;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
    }}
    main {{ max-width: 1180px; margin: 0 auto; padding: 22px 24px 42px; }}
    h1 {{ margin: 0 0 8px; font-size: 28px; font-weight: 700; }}
    h2 {{ margin: 0; font-size: 18px; }}
    p {{ margin: 0; }}
    .subhead {{ color: var(--muted); line-height: 1.7; max-width: 960px; }}
    .toolbar {{
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 18px;
    }}
    button {{
      border: 1px solid var(--line);
      background: #ffffff;
      color: var(--ink);
      border-radius: 8px;
      padding: 9px 13px;
      cursor: pointer;
      font-size: 14px;
    }}
    button.undervalued {{
      border-color: #16a34a;
      background: #dcfce7;
      color: #14532d;
      font-weight: 800;
      box-shadow: 0 8px 18px rgba(22, 163, 74, 0.22);
      text-shadow: 0 1px 0 rgba(255, 255, 255, 0.75);
    }}
    button[aria-pressed="true"] {{
      border-color: var(--blue);
      background: #edf4ff;
      color: #174ea6;
      font-weight: 700;
    }}
    button.undervalued[aria-pressed="true"] {{
      border-color: #15803d;
      background: #bbf7d0;
      color: #052e16;
      box-shadow: 0 0 0 2px #ffffff, 0 0 0 4px rgba(22, 163, 74, 0.8), 0 10px 22px rgba(22, 163, 74, 0.28);
    }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin: 18px 0;
    }}
    .metric, .panel {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }}
    .metric {{ padding: 16px; min-height: 108px; }}
    .label {{ color: var(--muted); font-size: 13px; }}
    .value {{ margin-top: 8px; font-size: 28px; font-weight: 750; }}
    .hint {{ margin-top: 8px; color: var(--muted); font-size: 13px; line-height: 1.5; }}
    .panel {{ padding: 18px; }}
    .panel-head {{
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }}
    .badge {{
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 13px;
      font-weight: 700;
      background: #eef2ff;
      color: #174ea6;
      white-space: nowrap;
    }}
    .badge.low {{ background: #ecfdf3; color: var(--green); }}
    .badge.high {{ background: #fff7ed; color: var(--red); }}
    .chart-wrap {{ width: 100%; overflow-x: auto; }}
    svg {{ display: block; width: 100%; min-width: 760px; height: 430px; }}
    .axis {{ stroke: #94a3b8; stroke-width: 1; }}
    .grid-line {{ stroke: #e7ebf2; stroke-width: 1; }}
    .pe-line {{ fill: none; stroke: var(--blue); stroke-width: 3; }}
    .price-line {{ fill: none; stroke: var(--purple); stroke-width: 2.5; }}
    .market-line {{ fill: none; stroke-width: 3; }}
    .mean-line {{ stroke: var(--green); stroke-width: 2; stroke-dasharray: 6 6; }}
    .band-line {{ stroke: var(--amber); stroke-width: 1.5; stroke-dasharray: 4 5; }}
    .point {{ fill: var(--blue); stroke: #fff; stroke-width: 2; }}
    .latest-point {{ fill: var(--red); stroke: #fff; stroke-width: 3; }}
    .hover-line {{ stroke: #475569; stroke-width: 1; stroke-dasharray: 3 4; opacity: 0.75; pointer-events: none; }}
    .hover-point {{ fill: #ffffff; stroke: var(--blue); stroke-width: 3; pointer-events: none; }}
    .tooltip {{
      position: fixed;
      z-index: 20;
      display: none;
      min-width: 150px;
      padding: 9px 11px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: var(--shadow);
      color: var(--ink);
      font-size: 13px;
      line-height: 1.55;
      pointer-events: none;
    }}
    .tooltip strong {{ display: block; margin-bottom: 3px; }}
    .legend {{
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      color: var(--muted);
      font-size: 13px;
      margin-top: 10px;
    }}
    .legend span::before {{
      content: "";
      display: inline-block;
      width: 16px;
      height: 3px;
      margin-right: 6px;
      vertical-align: middle;
      background: var(--blue);
    }}
    .legend .mean::before {{ background: var(--green); }}
    .legend .band::before {{ background: var(--amber); }}
    .legend .price::before {{ background: var(--purple); }}
    .legend .hs300::before {{ background: #2563eb; }}
    .legend .sz::before {{ background: #7c3aed; }}
    .legend .cyb::before {{ background: #c2410c; }}
    footer {{ color: var(--muted); font-size: 13px; line-height: 1.7; margin-top: 16px; }}
    @media (max-width: 880px) {{
      header {{ padding: 22px 18px 14px; }}
      main {{ padding: 16px 14px 32px; }}
      .grid {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
      .panel-head {{ display: block; }}
      .badge {{ margin-top: 10px; }}
    }}
    @media (max-width: 560px) {{
      h1 {{ font-size: 24px; }}
      .grid {{ grid-template-columns: 1fr; }}
      .value {{ font-size: 25px; }}
    }}
  </style>
</head>
<body>
  <div class="tooltip" id="tooltip"></div>
  <header>
    <h1>长线投资估值观察台</h1>
    <p class="subhead">用最近五年 PE(TTM) 与前复权收盘价的季度序列观察估值位置：绿色虚线为五年均值，橙色虚线和浅蓝区域为均值正负 1 个标准差估值带。</p>
    <div class="toolbar" id="companyTabs"></div>
  </header>
  <main>
    <section class="grid" id="metrics"></section>
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>沪深创业板板块估值水平</h2>
          <p class="hint">近五年季度 PE 序列；沪深300采用指数滚动 PE，深证A股与创业板采用市场平均 PE。</p>
        </div>
      </div>
      <div class="toolbar" id="marketTabs"></div>
      <div class="chart-wrap" id="marketChart"></div>
      <div class="legend">
        <span class="hs300">沪深300</span>
        <span class="sz">深证A股</span>
        <span class="cyb">创业板</span>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2 id="chartTitle"></h2>
          <p class="hint" id="chartSubtitle"></p>
        </div>
        <span class="badge" id="statusBadge"></span>
      </div>
      <div class="chart-wrap" id="chart"></div>
      <div class="legend">
        <span>PE(TTM)</span>
        <span class="price">股价（前复权，右轴）</span>
        <span class="mean">五年均值</span>
        <span class="band">均值 ±1σ</span>
      </div>
    </section>
    <footer id="sourceNote"></footer>
  </main>
  <script>
    const payload = {data_json};
    let selectedCode = payload.companies[0].code;
    let selectedMarketCode = payload.markets[0].code;

    const fmt = new Intl.NumberFormat("zh-CN", {{ maximumFractionDigits: 2 }});
    const tabs = document.getElementById("companyTabs");
    const metrics = document.getElementById("metrics");
    const chart = document.getElementById("chart");
    const marketTabs = document.getElementById("marketTabs");
    const marketChart = document.getElementById("marketChart");
    const title = document.getElementById("chartTitle");
    const subtitle = document.getElementById("chartSubtitle");
    const badge = document.getElementById("statusBadge");
    const sourceNote = document.getElementById("sourceNote");
    const tooltip = document.getElementById("tooltip");

    function companyByCode(code) {{
      return payload.companies.find((company) => company.code === code);
    }}

    function marketByCode(code) {{
      return payload.markets.find((market) => market.code === code);
    }}

    function statusClass(status) {{
      if (status.includes("低于")) return "low";
      if (status.includes("高于")) return "high";
      return "";
    }}

    function isUndervalued(company) {{
      return company.latest_percentile <= 30;
    }}

    function xScale(index, count, left, width) {{
      return count === 1 ? left + width / 2 : left + (index / (count - 1)) * width;
    }}

    function yScale(value, minValue, maxValue, top, height) {{
      if (maxValue === minValue) return top + height / 2;
      return top + height - ((value - minValue) / (maxValue - minValue)) * height;
    }}

    function pathFrom(points) {{
      return points.map((point, index) => `${{index === 0 ? "M" : "L"}} ${{point.x.toFixed(1)}} ${{point.y.toFixed(1)}}`).join(" ");
    }}

    function positionTooltip(event, row) {{
      tooltip.innerHTML = `
        <strong>${{row.quarter}}｜${{row.date}}</strong>
        <div>PE(TTM)：${{fmt.format(row.pe)}}</div>
        <div>股价：${{fmt.format(row.price)}}</div>
        <div>隐含 EPS：${{fmt.format(row.implied_eps)}}</div>
      `;
      tooltip.style.display = "block";
      tooltip.style.left = `${{event.clientX + 14}}px`;
      tooltip.style.top = `${{event.clientY + 14}}px`;
    }}

    function hideTooltip() {{
      tooltip.style.display = "none";
    }}

    function positionMarketTooltip(event, row, market) {{
      tooltip.innerHTML = `
        <strong>${{market.name}}｜${{row.quarter}}</strong>
        <div>日期：${{row.date}}</div>
        <div>PE：${{fmt.format(row.pe)}}</div>
      `;
      tooltip.style.display = "block";
      tooltip.style.left = `${{event.clientX + 14}}px`;
      tooltip.style.top = `${{event.clientY + 14}}px`;
    }}

    function renderTabs() {{
      tabs.innerHTML = "";
      payload.companies.forEach((company) => {{
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${{company.name}} ${{company.code}}`;
        if (isUndervalued(company)) {{
          button.classList.add("undervalued");
          button.title = `低估：历史百分位 ${{fmt.format(company.latest_percentile)}}%`;
        }}
        button.setAttribute("aria-pressed", String(company.code === selectedCode));
        button.addEventListener("click", () => {{
          selectedCode = company.code;
          render();
        }});
        tabs.appendChild(button);
      }});
    }}

    function renderMetrics(company) {{
      const items = [
        ["最新 PE / 股价", `${{fmt.format(company.latest_pe)}} / ${{fmt.format(company.latest_price)}}`, company.latest_quarter],
        ["历史百分位", `${{fmt.format(company.latest_percentile)}}%`, "近五年季度 PE 样本"],
        ["估值归因", company.valuation_reason, `近四季度：PE ${{fmt.format(company.pe_change_4q)}}%，股价 ${{fmt.format(company.price_change_4q)}}%，隐含 EPS ${{fmt.format(company.eps_change_4q)}}%`],
        ["五年均值", fmt.format(company.mean), "季度末样本均值"],
        ["估值带下沿", fmt.format(company.lower), "均值 - 1σ"],
        ["估值带上沿", fmt.format(company.upper), "均值 + 1σ"],
      ];
      metrics.innerHTML = items.map(([label, value, hint]) => `
        <article class="metric">
          <p class="label">${{label}}</p>
          <p class="value" style="font-size: ${{String(value).length > 18 ? "16px" : "28px"}}">${{value}}</p>
          <p class="hint">${{hint}}</p>
        </article>
      `).join("");
    }}

    function renderMarketTabs() {{
      marketTabs.innerHTML = "";
      payload.markets.forEach((market) => {{
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${{market.name}} PE ${{fmt.format(market.latest_pe)}}｜百分位 ${{fmt.format(market.latest_percentile)}}%`;
        if (market.latest_percentile <= 30) {{
          button.classList.add("undervalued");
          button.title = `低估：历史百分位 ${{fmt.format(market.latest_percentile)}}%`;
        }}
        button.setAttribute("aria-pressed", String(market.code === selectedMarketCode));
        button.addEventListener("click", () => {{
          selectedMarketCode = market.code;
          renderMarketTabs();
          renderMarketChart();
        }});
        marketTabs.appendChild(button);
      }});
    }}

    function renderMarketChart() {{
      const market = marketByCode(selectedMarketCode);
      const margin = {{ top: 24, right: 34, bottom: 52, left: 58 }};
      const width = 1050;
      const height = 360;
      const innerWidth = width - margin.left - margin.right;
      const innerHeight = height - margin.top - margin.bottom;
      const color = {{ hs300: "#2563eb", sz: "#7c3aed", cyb: "#c2410c" }}[market.code];
      const bandValues = [market.lower, market.upper, market.mean, ...market.quarters.map((row) => row.pe)];
      const minValue = Math.floor(Math.min(...bandValues) * 0.9);
      const maxValue = Math.ceil(Math.max(...bandValues) * 1.08);
      const baseRows = market.quarters;
      const ticks = Array.from({{ length: 5 }}, (_, index) => minValue + ((maxValue - minValue) * index) / 4);
      const xLabels = baseRows.filter((_, index) => index % 2 === 0 || index === baseRows.length - 1);
      const points = market.quarters.map((row, index) => ({{
        x: xScale(index, market.quarters.length, margin.left, innerWidth),
        y: yScale(row.pe, minValue, maxValue, margin.top, innerHeight),
        row,
      }}));
      const latestPoint = points[points.length - 1];
      const lowerY = yScale(market.lower, minValue, maxValue, margin.top, innerHeight);
      const upperY = yScale(market.upper, minValue, maxValue, margin.top, innerHeight);
      const meanY = yScale(market.mean, minValue, maxValue, margin.top, innerHeight);

      marketChart.innerHTML = `
        <svg id="marketSvg" viewBox="0 0 ${{width}} ${{height}}" role="img" aria-label="${{market.name}}估值水平">
          <rect x="${{margin.left}}" y="${{upperY}}" width="${{innerWidth}}" height="${{lowerY - upperY}}" fill="var(--band)"></rect>
          ${{ticks.map((tick) => {{
            const y = yScale(tick, minValue, maxValue, margin.top, innerHeight);
            return `<line class="grid-line" x1="${{margin.left}}" y1="${{y}}" x2="${{width - margin.right}}" y2="${{y}}"></line>
              <text x="18" y="${{y + 4}}" font-size="12" fill="#64748b">${{fmt.format(tick)}}</text>`;
          }}).join("")}}
          <line class="axis" x1="${{margin.left}}" y1="${{margin.top + innerHeight}}" x2="${{width - margin.right}}" y2="${{margin.top + innerHeight}}"></line>
          <line class="axis" x1="${{margin.left}}" y1="${{margin.top}}" x2="${{margin.left}}" y2="${{margin.top + innerHeight}}"></line>
          <line class="band-line" x1="${{margin.left}}" y1="${{upperY}}" x2="${{width - margin.right}}" y2="${{upperY}}"></line>
          <line class="band-line" x1="${{margin.left}}" y1="${{lowerY}}" x2="${{width - margin.right}}" y2="${{lowerY}}"></line>
          <line class="mean-line" x1="${{margin.left}}" y1="${{meanY}}" x2="${{width - margin.right}}" y2="${{meanY}}"></line>
          <path class="market-line" stroke="${{color}}" d="${{pathFrom(points)}}"></path>
          <circle cx="${{latestPoint.x}}" cy="${{latestPoint.y}}" r="6" fill="${{color}}" stroke="#fff" stroke-width="2"></circle>
          <text x="${{latestPoint.x + 8}}" y="${{latestPoint.y - 8}}" font-size="12" fill="${{color}}">最新</text>
          <line id="marketHoverLine" class="hover-line" x1="0" y1="${{margin.top}}" x2="0" y2="${{margin.top + innerHeight}}" visibility="hidden"></line>
          <circle id="marketHoverPoint" class="hover-point" cx="0" cy="0" r="6" visibility="hidden"></circle>
          ${{xLabels.map((row) => {{
            const actualIndex = baseRows.indexOf(row);
            const x = xScale(actualIndex, baseRows.length, margin.left, innerWidth);
            return `<text x="${{x}}" y="${{height - 22}}" text-anchor="middle" font-size="12" fill="#64748b">${{row.quarter.replace("Q", " Q")}}</text>`;
          }}).join("")}}
          <text x="${{margin.left}}" y="18" text-anchor="start" font-size="12" fill="#2563eb">${{market.name}} PE</text>
          <text x="${{width - margin.right + 8}}" y="${{meanY + 4}}" font-size="12" fill="#0f9f6e">均值 ${{fmt.format(market.mean)}}</text>
          <text x="${{width - margin.right + 8}}" y="${{upperY + 4}}" font-size="12" fill="#b7791f">+1σ</text>
          <text x="${{width - margin.right + 8}}" y="${{lowerY + 4}}" font-size="12" fill="#b7791f">-1σ</text>
        </svg>
      `;
      const svg = document.getElementById("marketSvg");
      const hoverLine = document.getElementById("marketHoverLine");
      const hoverPoint = document.getElementById("marketHoverPoint");
      svg.addEventListener("mousemove", (event) => {{
        const rect = svg.getBoundingClientRect();
        const viewX = ((event.clientX - rect.left) / rect.width) * width;
        const nearest = points.reduce((best, point) => {{
          return Math.abs(point.x - viewX) < Math.abs(best.x - viewX) ? point : best;
        }}, points[0]);
        hoverLine.setAttribute("x1", nearest.x);
        hoverLine.setAttribute("x2", nearest.x);
        hoverLine.setAttribute("visibility", "visible");
        hoverPoint.setAttribute("cx", nearest.x);
        hoverPoint.setAttribute("cy", nearest.y);
        hoverPoint.setAttribute("visibility", "visible");
        hoverPoint.setAttribute("stroke", color);
        positionMarketTooltip(event, nearest.row, market);
      }});
      svg.addEventListener("mouseleave", () => {{
        hoverLine.setAttribute("visibility", "hidden");
        hoverPoint.setAttribute("visibility", "hidden");
        hideTooltip();
      }});
    }}

    function renderChart(company) {{
      const margin = {{ top: 28, right: 54, bottom: 58, left: 58 }};
      const width = 1050;
      const height = 430;
      const innerWidth = width - margin.left - margin.right;
      const innerHeight = height - margin.top - margin.bottom;
      const bandValues = [company.lower, company.upper, company.mean, ...company.quarters.map((row) => row.pe)];
      const minValue = Math.floor(Math.min(...bandValues) * 0.9);
      const maxValue = Math.ceil(Math.max(...bandValues) * 1.08);
      const priceValues = company.quarters.map((row) => row.price);
      const minPrice = Math.floor(Math.min(...priceValues) * 0.92);
      const maxPrice = Math.ceil(Math.max(...priceValues) * 1.08);
      const points = company.quarters.map((row, index) => ({{
        x: xScale(index, company.quarters.length, margin.left, innerWidth),
        y: yScale(row.pe, minValue, maxValue, margin.top, innerHeight),
        row,
      }}));
      const pricePoints = company.quarters.map((row, index) => ({{
        x: xScale(index, company.quarters.length, margin.left, innerWidth),
        y: yScale(row.price, minPrice, maxPrice, margin.top, innerHeight),
        row,
      }}));
      const lowerY = yScale(company.lower, minValue, maxValue, margin.top, innerHeight);
      const upperY = yScale(company.upper, minValue, maxValue, margin.top, innerHeight);
      const meanY = yScale(company.mean, minValue, maxValue, margin.top, innerHeight);
      const ticks = Array.from({{ length: 5 }}, (_, index) => minValue + ((maxValue - minValue) * index) / 4);
      const priceTicks = Array.from({{ length: 5 }}, (_, index) => minPrice + ((maxPrice - minPrice) * index) / 4);
      const xLabels = company.quarters.filter((_, index) => index % 2 === 0 || index === company.quarters.length - 1);
      const latestPoint = points[points.length - 1];

      chart.innerHTML = `
        <svg id="valuationSvg" viewBox="0 0 ${{width}} ${{height}}" role="img" aria-label="${{company.name}} PE估值趋势">
          <rect x="${{margin.left}}" y="${{upperY}}" width="${{innerWidth}}" height="${{lowerY - upperY}}" fill="var(--band)"></rect>
          ${{ticks.map((tick) => {{
            const y = yScale(tick, minValue, maxValue, margin.top, innerHeight);
            return `<line class="grid-line" x1="${{margin.left}}" y1="${{y}}" x2="${{width - margin.right}}" y2="${{y}}"></line>
              <text x="18" y="${{y + 4}}" font-size="12" fill="#64748b">${{fmt.format(tick)}}</text>`;
          }}).join("")}}
          ${{priceTicks.map((tick) => {{
            const y = yScale(tick, minPrice, maxPrice, margin.top, innerHeight);
            return `<text x="${{width - 42}}" y="${{y + 4}}" font-size="12" fill="#7c3aed">${{fmt.format(tick)}}</text>`;
          }}).join("")}}
          <line class="axis" x1="${{margin.left}}" y1="${{margin.top + innerHeight}}" x2="${{width - margin.right}}" y2="${{margin.top + innerHeight}}"></line>
          <line class="axis" x1="${{margin.left}}" y1="${{margin.top}}" x2="${{margin.left}}" y2="${{margin.top + innerHeight}}"></line>
          <line class="axis" x1="${{width - margin.right}}" y1="${{margin.top}}" x2="${{width - margin.right}}" y2="${{margin.top + innerHeight}}"></line>
          <line class="band-line" x1="${{margin.left}}" y1="${{upperY}}" x2="${{width - margin.right}}" y2="${{upperY}}"></line>
          <line class="band-line" x1="${{margin.left}}" y1="${{lowerY}}" x2="${{width - margin.right}}" y2="${{lowerY}}"></line>
          <line class="mean-line" x1="${{margin.left}}" y1="${{meanY}}" x2="${{width - margin.right}}" y2="${{meanY}}"></line>
          <path class="pe-line" d="${{pathFrom(points)}}"></path>
          <path class="price-line" d="${{pathFrom(pricePoints)}}"></path>
          ${{points.map((point) => `<circle class="point" cx="${{point.x}}" cy="${{point.y}}" r="4">
            <title>${{point.row.quarter}}：PE ${{fmt.format(point.row.pe)}}，股价 ${{fmt.format(point.row.price)}}</title>
          </circle>`).join("")}}
          <circle class="latest-point" cx="${{latestPoint.x}}" cy="${{latestPoint.y}}" r="6"></circle>
          <text x="${{latestPoint.x + 9}}" y="${{latestPoint.y - 10}}" font-size="12" fill="#c2410c">最新</text>
          <line id="hoverLine" class="hover-line" x1="0" y1="${{margin.top}}" x2="0" y2="${{margin.top + innerHeight}}" visibility="hidden"></line>
          <circle id="hoverPoint" class="hover-point" cx="0" cy="0" r="6" visibility="hidden"></circle>
          ${{xLabels.map((row, index) => {{
            const actualIndex = company.quarters.indexOf(row);
            const x = xScale(actualIndex, company.quarters.length, margin.left, innerWidth);
            return `<text x="${{x}}" y="${{height - 24}}" text-anchor="middle" font-size="12" fill="#64748b">${{row.quarter.replace("Q", " Q")}}</text>`;
          }}).join("")}}
          <text x="${{width - margin.right + 8}}" y="${{meanY + 4}}" font-size="12" fill="#0f9f6e">均值 ${{fmt.format(company.mean)}}</text>
          <text x="${{width - margin.right + 8}}" y="${{upperY + 4}}" font-size="12" fill="#b7791f">+1σ</text>
          <text x="${{width - margin.right + 8}}" y="${{lowerY + 4}}" font-size="12" fill="#b7791f">-1σ</text>
          <text x="${{width - margin.right}}" y="18" text-anchor="end" font-size="12" fill="#7c3aed">股价</text>
          <text x="${{margin.left}}" y="18" text-anchor="start" font-size="12" fill="#2563eb">PE</text>
        </svg>
      `;
      const svg = document.getElementById("valuationSvg");
      const hoverLine = document.getElementById("hoverLine");
      const hoverPoint = document.getElementById("hoverPoint");
      svg.addEventListener("mousemove", (event) => {{
        const rect = svg.getBoundingClientRect();
        const viewX = ((event.clientX - rect.left) / rect.width) * width;
        const nearest = points.reduce((best, point) => {{
          return Math.abs(point.x - viewX) < Math.abs(best.x - viewX) ? point : best;
        }}, points[0]);
        hoverLine.setAttribute("x1", nearest.x);
        hoverLine.setAttribute("x2", nearest.x);
        hoverLine.setAttribute("visibility", "visible");
        hoverPoint.setAttribute("cx", nearest.x);
        hoverPoint.setAttribute("cy", nearest.y);
        hoverPoint.setAttribute("visibility", "visible");
        positionTooltip(event, nearest.row);
      }});
      svg.addEventListener("mouseleave", () => {{
        hoverLine.setAttribute("visibility", "hidden");
        hoverPoint.setAttribute("visibility", "hidden");
        hideTooltip();
      }});
    }}

    function render() {{
      const company = companyByCode(selectedCode);
      renderTabs();
      renderMetrics(company);
      renderChart(company);
      renderMarketTabs();
      renderMarketChart();
      title.textContent = `${{company.name}}（${{company.code}}）PE(TTM) 与股价季度走势`;
      subtitle.textContent = `${{company.sector}}｜${{company.coverage_note}}`;
      badge.textContent = company.status;
      badge.className = `badge ${{statusClass(company.status)}}`;
      sourceNote.textContent = `数据源：${{payload.source}}。快照生成时间：${{payload.generatedAt}}。说明：股价为季度最后一个交易日的前复权收盘价；估值归因为基于股价/PE 得到的隐含 EPS 粗略分解，不等同于市场真实预期调查；中国移动 A 股上市时间较短，五年窗口内仅包含上市后的可得样本；本页面为估值观察工具，不构成投资建议。`;
    }}

    render();
  </script>
</body>
</html>
"""


def main() -> None:
    """Build the dashboard file."""

    payload = build_payload()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(render_html(payload), encoding="utf-8", newline="\n")
    print(f"wrote {OUTPUT_PATH}")
    print(f"companies: {', '.join(item['name'] for item in payload['companies'])}")


if __name__ == "__main__":
    main()
