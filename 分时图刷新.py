"""
金山文档 Python X 表格：批量刷新每只股票的当日分时图

表格要求：
1. 目标工作表默认名为“冲啊”；
2. 第一行包含“股票代码”和“分时图”表头；
3. 每行股票代码对应同一行的一个嵌入式折线图。

使用前请在 PY 脚本编辑器的“服务列表”中启用“网络 API”。
脚本使用腾讯公开分时接口，接口变化或限流时会在对应单元格写明失败原因。
"""

import concurrent.futures
import re
import time

import requests


# ==================== 配置 ====================
TARGET_SHEET = "冲啊"
HELPER_SHEET = "分时数据"
CODE_HEADERS = ("股票代码", "代码", "code")
CHART_HEADER = "分时图"

REQUEST_TIMEOUT = 5
MAX_WORKERS = 4          # 并发过高容易被行情源限流
MAX_POINTS = 245        # A股一个交易日最多约242个分钟节点
CHART_WIDTH = 300
CHART_HEIGHT = 110
CHART_PREFIX = "CodexIntraday_"
XL_LINE = 4               # Excel/WPS XlChartType.xlLine；Python环境直接使用数值常量

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36"
)


# ==================== 股票代码与网络请求 ====================
def normalize_symbol(raw):
    if raw is None:
        return None

    # WPS数值单元格可能返回600519.0；000001还可能被转成数字1。
    # 对整数型数值统一转成最多6位并补足前导零。
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        try:
            number = float(raw)
            if not number.is_integer() or number < 0 or number > 999999:
                return None
            digits = str(int(number)).zfill(6)
            text = digits
        except (TypeError, ValueError, OverflowError):
            return None
    else:
        text = str(raw).strip().upper().lstrip("'")
        # 同时兼容字符串形式的“600519.0”和“6.00519E+05”。
        try:
            if re.fullmatch(r"\d+(?:\.0+)?", text) or re.fullmatch(r"\d+(?:\.\d+)?E[+-]?\d+", text):
                number = float(text)
                if number.is_integer() and 0 <= number <= 999999:
                    digits = str(int(number)).zfill(6)
                else:
                    return None
            else:
                digits = re.sub(r"\D", "", text)
        except (TypeError, ValueError, OverflowError):
            return None

    if len(digits) != 6:
        return None
    if "SH" in text:
        market = "sh"
    elif "SZ" in text:
        market = "sz"
    elif "BJ" in text:
        market = "bj"
    elif digits[0] in ("6", "5", "9"):
        market = "sh"
    elif digits[0] in ("4", "8"):
        market = "bj"
    else:
        market = "sz"
    return market + digits


def parse_minute_rows(payload, symbol):
    root = payload.get("data") if isinstance(payload, dict) else None
    node = root.get(symbol) if isinstance(root, dict) else None
    if not isinstance(node, dict):
        return []

    minute_node = node.get("data")
    if isinstance(minute_node, dict):
        rows = minute_node.get("data") or []
    elif isinstance(minute_node, list):
        rows = minute_node
    else:
        rows = []

    result = []
    for item in rows[:MAX_POINTS]:
        parts = item.split() if isinstance(item, str) else list(item)
        if len(parts) < 2:
            continue
        hhmm = str(parts[0]).zfill(4)
        try:
            price = float(parts[1])
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        result.append((hhmm[:2] + ":" + hhmm[2:4], price))
    return result


def fetch_intraday(symbol):
    url = "https://web.ifzq.gtimg.cn/appstock/app/minute/query"
    try:
        response = requests.get(
            url,
            params={"code": symbol},
            headers={"User-Agent": UA, "Referer": "https://gu.qq.com/"},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        points = parse_minute_rows(response.json(), symbol)
        if not points:
            return symbol, [], "无分时数据"
        return symbol, points, ""
    except Exception as exc:
        return symbol, [], "请求失败：" + str(exc)[:60]


# ==================== WPS 表格工具 ====================
def get_sheet(name):
    try:
        return Application.Worksheets.Item(name)
    except Exception:
        return None


def get_or_create_helper_sheet():
    helper = get_sheet(HELPER_SHEET)
    if helper is not None:
        return helper
    helper = Application.Worksheets.Add()
    helper.Name = HELPER_SHEET
    return helper


def find_columns(sheet):
    used = sheet.UsedRange
    if used is None:
        return None, None, 1, 1
    header_row = used.Row
    start_col = used.Column
    col_count = used.Columns.Count
    code_col = None
    chart_col = None
    for offset in range(col_count):
        col = start_col + offset
        value = str(sheet.Cells(header_row, col).Value2 or "").strip()
        if value in CODE_HEADERS and code_col is None:
            code_col = col
        if value == CHART_HEADER and chart_col is None:
            chart_col = col
    return code_col, chart_col, header_row, header_row + used.Rows.Count - 1


def last_code_row(sheet, code_col, header_row, fallback_row):
    try:
        # -4162 = xlUp
        row = sheet.Cells(sheet.Rows.Count, code_col).End(-4162).Row
        return max(header_row, row)
    except Exception:
        row = fallback_row
        while row > header_row:
            if str(sheet.Cells(row, code_col).Value2 or "").strip():
                return row
            row -= 1
        return header_row


def column_name(number):
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def remove_old_chart(sheet, shape_name):
    shapes = sheet.Shapes
    try:
        shapes.Item(shape_name).Delete()
        return
    except Exception:
        pass
    # 部分版本不支持按名称 Item，倒序扫描作为兼容回退。
    try:
        for index in range(shapes.Count, 0, -1):
            shape = shapes.Item(index)
            if str(shape.Name) == shape_name:
                shape.Delete()
                return
    except Exception:
        pass


def write_helper_data(helper, block_index, symbol, points):
    first_col = block_index * 2 + 1
    second_col = first_col + 1
    col_a = column_name(first_col)
    col_b = column_name(second_col)

    # 清掉上次可能更长的数据，避免旧分钟点残留在图表中。
    helper.Range(f"{col_a}1:{col_b}{MAX_POINTS + 1}").ClearContents()
    values = [[symbol + " 时间", symbol + " 价格"]]
    values.extend([[clock, price] for clock, price in points])
    helper.Range(f"{col_a}1:{col_b}{len(values)}").Value2 = values
    return helper.Range(f"{col_a}1:{col_b}{len(values)}")


def add_chart(sheet, target_cell, source_range, shape_name, symbol):
    remove_old_chart(sheet, shape_name)

    # 调整承载分时图的行列尺寸；图表是浮动对象，但与对应单元格对齐。
    try:
        sheet.Rows.Item(target_cell.Row).RowHeight = CHART_HEIGHT
        sheet.Columns.Item(target_cell.Column).ColumnWidth = 42
    except Exception:
        pass

    left = target_cell.Left + 2
    top = target_cell.Top + 2
    width = max(CHART_WIDTH, target_cell.Width - 4)
    height = max(CHART_HEIGHT - 4, target_cell.Height - 4)

    # Python X 表格中的 Application.Enum 是 DbEnum，并不提供 JS 风格的
    # Application.Enum.XlChartType.xlLine，因此使用兼容数值常量4。
    shape = sheet.Shapes.AddChart2(201, XL_LINE, left, top, width, height)
    shape.Name = shape_name
    chart = shape.Chart
    chart.SetSourceData(source_range)

    # 金山文档Python端设置HasTitle后，ChartTitle仍可能返回None。
    # 标题和图例都属于可选外观，失败时不能影响图表本身。
    try:
        chart.HasTitle = True
        title = chart.ChartTitle
        if title is not None:
            title.Text = symbol + " 分时"
        else:
            chart.HasTitle = False
    except Exception:
        try:
            chart.HasTitle = False
        except Exception:
            pass
    try:
        chart.HasLegend = False
    except Exception:
        pass

    # 外观属性在不同版本中支持度不一致，失败时保留默认样式。
    try:
        series = chart.SeriesCollection(1)
        series.Format.Line.ForeColor.RGB = 255  # 红色
        series.Format.Line.Weight = 1.5
    except Exception:
        pass
    return shape


# ==================== 主流程 ====================
def main():
    started = time.time()
    sheet = get_sheet(TARGET_SHEET)
    if sheet is None:
        print(f"[错误] 找不到工作表：{TARGET_SHEET}")
        return

    code_col, chart_col, header_row, used_last_row = find_columns(sheet)
    if code_col is None:
        print("[错误] 找不到‘股票代码’列")
        return
    if chart_col is None:
        print("[错误] 找不到‘分时图’列，请先添加表头‘分时图’")
        return

    end_row = last_code_row(sheet, code_col, header_row, used_last_row)
    jobs = []
    for row in range(header_row + 1, end_row + 1):
        raw_code = sheet.Cells(row, code_col).Value2
        if raw_code in (None, ""):
            continue
        symbol = normalize_symbol(raw_code)
        if symbol is None:
            sheet.Cells(row, chart_col).Value2 = "代码无效"
            continue
        jobs.append((row, symbol))

    if not jobs:
        print("[提示] 没有有效股票代码")
        return

    # 相同代码只请求一次，并发数有限，兼顾速度与接口限流风险。
    symbols = list(dict.fromkeys(symbol for _, symbol in jobs))
    fetched = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(symbols))) as pool:
        futures = [pool.submit(fetch_intraday, symbol) for symbol in symbols]
        for future in concurrent.futures.as_completed(futures):
            symbol, points, error = future.result()
            fetched[symbol] = (points, error)

    helper = get_or_create_helper_sheet()
    success = 0
    failed = 0
    for block_index, (row, symbol) in enumerate(jobs):
        points, error = fetched.get(symbol, ([], "请求未完成"))
        cell = sheet.Cells(row, chart_col)
        shape_name = CHART_PREFIX + str(row)
        if not points:
            remove_old_chart(sheet, shape_name)
            cell.Value2 = error or "无分时数据"
            failed += 1
            continue
        try:
            cell.Value2 = ""
            source = write_helper_data(helper, block_index, symbol, points)
            add_chart(sheet, cell, source, shape_name, symbol)
            success += 1
        except Exception as exc:
            remove_old_chart(sheet, shape_name)
            cell.Value2 = "绘图失败：" + str(exc)[:60]
            failed += 1

    print(
        f"完成：成功 {success} 个，失败 {failed} 个，"
        f"耗时 {int((time.time() - started) * 1000)}ms"
    )


main()
