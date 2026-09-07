/**
 * WPS 在线表格（普通工作簿）· A股/ETF 实时行情刷新脚本
 *
 * 用法：第 1 行填表头，第 2 行起填股票代码（如 600519 / sz000001 / 510300），
 *       运行本脚本即拉取最新行情写入对应列。表为空时脚本自动建表头与 4 个示例代码。
 *
 * 表头列按名称自动识别（顺序无所谓），候选名见 CONFIG.fields：
 *   基础列：股票代码 / 股票名称 / 最新价 / 今日涨跌 / 昨日涨跌 / 涨跌额 /
 *          今开 / 最高 / 最低 / 昨收 / 更新时间 / 状态
 *   （旧表头「涨跌幅」会自动当作「今日涨跌」用）
 *   持仓列（可选，手填持仓数量后自动算）：持仓数量 / 成本价 / 持仓市值 / 实时涨跌 / 浮动盈亏 / 持仓收益率
 *   汇总列（可选，只在表头下一格显示）：总浮动盈亏 / 当日总盈亏
 *
 * 昨日涨跌：当天缓存，基准日存第 1 行第 CONFIG.yesterdayCacheCol 列。
 * 数据源：多源实时快照 + 腾讯/东方财富历史K线（提供昨日涨跌）。同步 API，禁用 async/await。
 */

// ==================== 1. 配置 ====================
var CONFIG = {
  // 固定运行的工作表名称。无论当前停留在哪个 Sheet，脚本始终更新这里指定的工作表。
  // 以后需要换表时只改这一处，例如：targetSheet: '我的持仓'
  targetSheet: '冲啊',

  fields: {
    code:      ['股票代码', '代码', 'code'],
    name:      ['股票名称', '名称', 'name'],
    price:     ['最新价', '现价', '价格', 'price'],
    change:    ['今日涨跌', '涨跌幅', '涨跌%', '幅度', '涨跌幅%'],   // 「今日涨跌」为主，兼容旧表头「涨跌幅」
    changeY:   ['昨日涨跌', '昨日涨跌幅'],
    changeAmt: ['涨跌额', '涨跌'],
    open:      ['今开', '开盘价', '开盘'],
    high:      ['最高', '最高价'],
    low:       ['最低', '最低价'],
    prevClose: ['昨收', '昨收价', '昨收盘'],
    updateAt:  ['更新时间', '时间'],
    status:    ['状态']
  },
  // ---- 持仓相关（可选）：持仓数量/成本价由你手填，衍生列由脚本自动算 ----
  // 需要的列，只要把对应表头加到表里就会被自动识别（顺序无所谓）：
  //   持仓数量  必填：手填持仓，如 1000 / 1000.00
  //   成本价    可选：手填成本，填了才会算「浮动盈亏」和「持仓收益率」
  //   持仓市值  = 最新价 × 持仓数量
  //   当日盈亏  = 涨跌额 × 持仓数量   （相对昨收的当日浮盈浮亏）
  //   浮动盈亏  = (最新价 - 成本价) × 持仓数量（需要「成本价」列）
  //   持仓收益率 = (最新价 - 成本价) ÷ 成本价（需要「成本价」列，按百分比显示，受 redGreen 控制）
  qty:       ['持仓数量', '持股数量', '持仓', '数量', '份额'],
  cost:      ['成本价', '持仓成本', '买入价', '成本'],
  value:     ['持仓市值', '当前市值', '市值'],
  plDay:     ['当日盈亏', '实时涨跌', '持仓盈亏', '当日收益'],
  plTotal:   ['浮动盈亏', '累计盈亏', '总盈亏'],
  plRate:    ['持仓收益率', '收益率', '盈亏比例', '持仓盈亏率', '收益率%', '盈亏率'],
  totalPl:   ['总浮动盈亏', '持仓总盈亏', '浮动盈亏合计'],
  totalDay:  ['当日总盈亏', '今日总盈亏', '当日盈亏合计'],

  batchSize: 80,        // 批量接口单次处理数量；80 可明显减少网络往返，URL 长度仍较安全
  timeout:   5000,      // 首选批量源超时；失败后立即切备用源，不在同一节点长时间重试
  fastTimeout: 2200,    // 降级源快速失败超时
  klineTimeout: 1800,   // 「昨日涨跌」单次超时；配合连续失败熔断，避免接口异常时长时间卡住
  fillName:  true,
  enableHoldings: true,  // 关掉则完全不读写持仓相关列
  enableYesterday: true, // 「昨日涨跌」列：腾讯/东财历史K线逐只请求；关掉则不请求不写入
  yesterdayPreferTencent: true, // 腾讯历史K线优先；当前网络下更稳定，缺失项再由东财补取
  yesterdayCache: true,  // 「昨日涨跌」当天缓存：同一交易日只请求一次，之后复用表格已有值（提速关键，
                         // 否则每次点刷新都逐只请求 N 次历史K线，这是脚本最慢的一段）
  yesterdayCacheCol: 30, // 缓存标记写在「第 1 行第 N 列」，明码显示缓存日期、行数和校验码。
                         // 注意：必须是「未被占用的空列」且固定不变——不能随表宽动态漂移，
                         // 否则每跑一次列就右移一格，缓存永远命中不了还会把表越撑越宽。
                         // 若你的数据列已达 30 列，请改成更大的、确定空着的列号。
                         // （若该格已被你的表头占用，脚本会跳过写入并在日志提示，不会覆盖你的内容）

  // 今日/昨日涨跌显示方式：
  //   'percent' —— 写小数 + 百分比格式，显示 0.05%，仍是数值，可参与计算/条件格式（推荐）
  //   'text'    —— 写文本 "+0.05%"，带正负号，但不能再参与数值计算
  //   'number'  —— 写纯数字 0.05（旧行为）
  changeMode: 'percent',
  redGreen:    false,  // 涨红跌绿（A股习惯）。默认关闭；需要时设 true。
                       // 同一开关统一控制：「今日涨跌」「昨日涨跌」以及盈亏类列（实时涨跌 / 浮动盈亏 / 持仓收益率）。
                       // 关掉后下次刷新会把已上色的单元格复位成黑色（双向生效，无需手动清除）。
  timeToSecond: true    // 更新时间精确到秒，并锁定文本格式，避免被 WPS 截断成日期
};

// 只请求脚本实际使用的字段；f5成交量、f6成交额未写入表格，已移除以缩小响应。
var API_FIELDS = 'f2,f3,f4,f12,f13,f14,f15,f16,f17,f18,f124';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36';

// ==================== 2. 通用工具与表格读取 ====================

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function fmtTime(ts) {
  var n = parseInt(ts, 10);
  if (!n || isNaN(n)) return '';
  var t = new Date(n * 1000 + 8 * 3600 * 1000);
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) +
         ' ' + pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':' + pad(t.getUTCSeconds());
}

// 统计对象自有属性个数。不用 Object.keys —— 部分 AirScript 引擎对 ES5 方法支持不稳，
// 而这处在核心路径上，一旦抛错整个脚本会挂，故用 ES3 的 for...in + hasOwnProperty。
function keyCount(obj) {
  var n = 0;
  for (var k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) n++;
  }
  return n;
}

// 去重且保持原顺序。表里允许同一代码出现多行，但网络请求只应发送一次。
function uniqueList(arr) {
  var seen = {}, out = [];
  for (var i = 0; i < arr.length; i++) {
    var k = String(arr[i]);
    if (!Object.prototype.hasOwnProperty.call(seen, k)) {
      seen[k] = true;
      out.push(arr[i]);
    }
  }
  return out;
}

// 为当前「行号+股票代码」生成短签名，用于识别当天换代码、调行或增删行。
// 只存一个 8 位十六进制摘要，避免缓存单元格内容过长。
function jobsSignature(jobs) {
  var h = 2166136261;
  for (var i = 0; i < jobs.length; i++) {
    var s = jobs[i].row + ':' + jobs[i].key + ';';
    for (var j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      // FNV-1a 的 ES3 兼容写法；位运算把结果稳定限制在 32 位。
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

// Value2 转文本时不能用「v || ''」：数值 0 是有效值（例如昨日涨跌 0%）。
function cellText(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

// 适合名称、状态、缓存标记等多数刷新都不变的字段：值相同时跳过写入。
function setValueIfChanged(cell, value) {
  try {
    if (cellText(cell.Value2) === cellText(value)) return false;
  } catch (e) { /* 无法回读时仍正常写入 */ }
  cell.Value2 = value;
  return true;
}

// -------- 表格写回：普通值批量队列 --------
// 百分比、颜色和持仓金额仍由专用函数逐格处理；无样式要求的字段合并成连续区域写入。
function queueCellWrite(queues, col, row, value) {
  if (col <= 0) return;
  var key = String(col);
  if (!queues[key]) queues[key] = [];
  queues[key].push({ row: row, value: value });
}

function flushWriteRun(sheet, col, items, from, to) {
  var firstRow = items[from].row;
  var lastRow = items[to].row;
  try {
    if (from === to) {
      sheet.Cells(firstRow, col).Value2 = items[from].value;
    } else {
      var values = [];
      for (var i = from; i <= to; i++) values.push([items[i].value]);
      sheet.Range(sheet.Cells(firstRow, col), sheet.Cells(lastRow, col)).Value2 = values;
    }
    return 1;
  } catch (e) {
    // 某些 AirScript 版本不接受二维数组区域写入，自动回退，不影响正确性。
    for (var j = from; j <= to; j++) sheet.Cells(items[j].row, col).Value2 = items[j].value;
    return 0;
  }
}

function flushWriteQueues(sheet, queues) {
  var runs = 0, fallbacks = 0;
  for (var key in queues) {
    if (!Object.prototype.hasOwnProperty.call(queues, key)) continue;
    var items = queues[key];
    if (!items || items.length === 0) continue;
    var from = 0;
    for (var i = 1; i <= items.length; i++) {
      if (i === items.length || items[i].row !== items[i - 1].row + 1) {
        if (flushWriteRun(sheet, parseInt(key, 10), items, from, i - 1)) runs++;
        else fallbacks++;
        from = i;
      }
    }
  }
  console.log('普通字段批量写回：' + runs + ' 个连续区域' +
              (fallbacks > 0 ? '，逐格回退 ' + fallbacks + ' 个区域' : ''));
}

// 当前时间（本地时区），精确到秒 —— 行情源没给时间时兜底
function nowStr() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
         ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// ---- 耗时打点：把每一段花多久打进日志，慢在哪一眼可见，不用靠感觉猜 ----
var _t0 = Date.now();
var _tLap = _t0;
function lap(label) {
  var now = Date.now();
  console.log('[耗时] ' + label + '：本阶段 ' + (now - _tLap) +
              'ms，累计 ' + (now - _t0) + 'ms');
  _tLap = now;
}

// -------- 单元格样式：颜色 / 数字格式 --------
//
// 【重要·之前红绿不生效的根因】
// WPS AirScript 的 Font.Color 是 **String**，取 '#RRGGBB' 形式（如 '#eb5451'），
// 不是 Excel VBA 那套 BGR 数值。之前传数字 255 被引擎忽略，外面又套了 try/catch
// 把错误吞掉，于是「开关看起来无效」且没有任何日志。
// 现改为：传 16 进制字符串 + 运行时探测可用写法 + 回读校验 + 失败打日志。
var COLOR_UP   = '#FF0000';   // 涨 - 红（A 股习惯）
var COLOR_DOWN = '#00B050';   // 跌 - 绿
var COLOR_FLAT = '#808080';   // 平 - 灰
var COLOR_TEXT = '#000000';   // 常规 - 黑（用于把上过色的单元格恢复）

// '#RRGGBB' -> Excel/WPS 的 BGR 数值（少数版本只认数值，作为兜底）
function hexToBgr(hex) {
  var h = String(hex).replace('#', '');
  if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  var r = parseInt(h.substring(0, 2), 16);
  var g = parseInt(h.substring(2, 4), 16);
  var b = parseInt(h.substring(4, 6), 16);
  return r + g * 256 + b * 65536;
}

// 不同版本的实现位置有差异，按成功率从高到低尝试
var COLOR_MODES = ['fontHex', 'styleFontHex', 'fontBgr', 'styleFontBgr'];
var _colorMode = null;   // null=未探测，false=确认不支持，字符串=已确认的写法

function applyColor(cell, mode, hex) {
  var v = (mode === 'fontBgr' || mode === 'styleFontBgr') ? hexToBgr(hex) : hex;
  if (mode === 'fontHex' || mode === 'fontBgr') cell.Font.Color = v;
  else cell.Style.Font.Color = v;
}

function readColor(cell, mode) {
  return (mode === 'fontHex' || mode === 'fontBgr') ? cell.Font.Color : cell.Style.Font.Color;
}

// 回读校验：读不到值（undefined）时无法验证，视为成功
function colorMatches(got, hex) {
  if (got === null || got === undefined || got === '') return true;
  return colorIsAlready(got, hex);
}

// 「当前色是否已经是目标色」——用于写前跳过，语义与 colorMatches 相反：
// 读不到值一律当作「不是」，保证至少写一次，不会因为读不到就永远跳过。
// 写前跳过 + 写后校验 共用一个比对实现，避免两处逻辑走偏。
function colorIsAlready(got, hex) {
  if (got === null || got === undefined || got === '') return false;
  var h = String(hex).replace('#', '').toLowerCase();
  var g = String(got);
  if (g.charAt(0) === '#') return g.substring(1).toLowerCase() === h;
  var n = parseFloat(g);
  if (!isNaN(n)) return Math.round(n) === hexToBgr(hex);
  return g.toLowerCase() === h;
}

// 设置字体颜色。首次调用会探测当前环境支持的写法并缓存，探测结果打进日志
function setFontColor(cell, hex) {
  if (!cell || !hex) return false;
  if (_colorMode === false) return false;
  if (_colorMode) {
    try {
      // 已经是目标色就跳过写入：读一个属性比改一个属性便宜得多。
      // 红绿开关关闭时（默认）每次都要写黑字，除首次外基本都能命中，能省下大量 COM 调用。
      if (colorIsAlready(readColor(cell, _colorMode), hex)) return true;
    } catch (e) { /* 读不到就照常写 */ }
    try { applyColor(cell, _colorMode, hex); return true; } catch (e) { return false; }
  }
  for (var i = 0; i < COLOR_MODES.length; i++) {
    var m = COLOR_MODES[i];
    try {
      applyColor(cell, m, hex);
      if (colorMatches(readColor(cell, m), hex)) {
        _colorMode = m;
        console.log('字体颜色写入方式：' + m + '（如 ' + hex + '）');
        return true;
      }
    } catch (e) { /* 换下一种写法 */ }
  }
  _colorMode = false;
  console.log('[警告] 当前环境不支持设置字体颜色，已跳过上色（数据写入不受影响）');
  return false;
}

// 数字格式：先读后写。0.00% / @ 这些格式一旦设过就不会变，
// 重复刷新时每次都重写纯属白花 COM 调用。读比写便宜，命中就跳过；
// 环境读不出来（抛错）时照常写入，不影响正确性。
var _fmtWarned = false;
function setNumberFormat(cell, fmt) {
  try {
    if (cell.NumberFormatLocal === fmt) return true;
  } catch (e) { /* 不支持读，继续尝试写 */ }
  try { cell.NumberFormatLocal = fmt; return true; }
  catch (e) {
    if (!_fmtWarned) {
      _fmtWarned = true;
      console.log('[警告] 当前环境不支持设置数字格式，值仍以常规格式显示');
    }
    return false;
  }
}

// 涨红 / 跌绿 / 平灰：统一取色，消除 writeChange / writeMoney 里的重复三元
function colorOf(v) {
  return v > 0 ? COLOR_UP : (v < 0 ? COLOR_DOWN : COLOR_FLAT);
}

// 涨跌幅：按 CONFIG.changeMode 写入，并按 A 股习惯上色
function writeChange(cell, pct) {
  if (CONFIG.changeMode === 'text') {
    cell.Value2 = (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';
  } else if (CONFIG.changeMode === 'percent') {
    cell.Value2 = pct / 100;                       // 0.05 -> 0.0005
    setNumberFormat(cell, '0.00%');
  } else {
    cell.Value2 = pct;
  }
  setFontColor(cell, CONFIG.redGreen ? colorOf(pct) : COLOR_TEXT);
}

// 金额类：保留 2 位小数，可选涨红跌绿。值为空时清空单元格并复位颜色，避免残留旧数据
function writeMoney(cell, amount, withColor) {
  // 解除上一版留下的固定两位格式；其他自定义格式保留。
  try {
    if (cell.NumberFormatLocal === '0.00') setNumberFormat(cell, 'General');
  } catch (e) { /* 无法读取格式时，仍按原逻辑写入数值 */ }
  if (amount === null || amount === undefined || !isFinite(amount)) {
    cell.Value2 = '';
    setFontColor(cell, COLOR_TEXT);
    return;
  }
  cell.Value2 = Math.round(amount * 100) / 100;
  setFontColor(cell, (CONFIG.redGreen && withColor) ? colorOf(amount) : COLOR_TEXT);
}

// 清空一个「带百分比格式和颜色」的单元格：置空 + 复位黑色。
// 用于计算条件不满足时（如缺成本价），避免残留上一次的旧值造成视觉矛盾。
function clearPercentCell(cell) {
  cell.Value2 = '';
  setFontColor(cell, COLOR_TEXT);
}

// 更新时间：精确到秒；源没给时间时用当前时间兜底，并锁定文本格式避免被 WPS 截断成日期
function writeTime(cell, t) {
  // 必须先设文本格式再写值。若顺序相反，WPS 会先把日期字符串转换成 46269.67… 之类的序列号。
  if (CONFIG.timeToSecond) setNumberFormat(cell, '@');
  cell.Value2 = t || nowStr();
}

function num(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  // 去掉千分位逗号：手填的「持仓数量」可能是 "1,000" 这种写法
  var n = parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

// ==================== 3. 股票代码转换 ====================
function toSecid(rawCode) {
  var raw = String(rawCode === null || rawCode === undefined ? '' : rawCode).trim();
  if (!raw) return null;
  var upper = raw.toUpperCase();
  var mk = '';
  if (upper.indexOf('SH') >= 0) mk = 'SH';
  else if (upper.indexOf('SZ') >= 0) mk = 'SZ';
  else if (upper.indexOf('BJ') >= 0) mk = 'BJ';
  var c = raw.replace(/\D/g, '');
  if (c.length !== 6) return null;
  if (!mk) {
    var h1 = c.charAt(0);
    var h2 = c.substring(0, 2);
    if (h2 === '15' || h2 === '16' || h2 === '12') mk = 'SZ';
    else if (h1 === '6' || h1 === '5' || h1 === '9') mk = 'SH';
    else if (h1 === '0' || h1 === '3' || h1 === '2') mk = 'SZ';
    else if (h1 === '4' || h1 === '8') mk = 'BJ';
    else mk = 'SZ';
  }
  return (mk === 'SH' ? '1' : '0') + '.' + c;
}

function findCol(headers, candidates, baseCol) {
  for (var i = 0; i < headers.length; i++) {
    for (var j = 0; j < candidates.length; j++) {
      if (headers[i] === candidates[j]) return baseCol + i;
    }
  }
  return -1;
}

// 只按股票代码列确定最后一条数据，避免 UsedRange 因历史格式或空行膨胀而扫描几千行。
function findLastCodeRow(sheet, codeCol, headerRow, usedLastRow) {
  try {
    var last = sheet.Cells(sheet.Rows.Count, codeCol).End(-4162).Row; // -4162 = xlUp
    if (last >= headerRow) return last;
  } catch (e) { /* 不支持 End 时使用下面的兼容回退 */ }
  var r = usedLastRow;
  while (r > headerRow) {
    try {
      if (cellText(sheet.Cells(r, codeCol).Value2) !== '') return r;
    } catch (re) {}
    r--;
  }
  return headerRow;
}

// ==================== 4. 实时行情数据源 ====================
// 东财主域名(push2)容易对机房 IP 限流返回 502，delay 节点实测更稳，故排第一
var EM_HOSTS = ['push2delay.eastmoney.com', 'push2.eastmoney.com'];
// 同花顺 realhead 公开接口（免费、无需 token）；中文名 UTF-8 不乱码、涨跌幅直给、不支持批量（每只一次）
var THS_URL = 'https://d.10jqka.com.cn/v2/realhead/hs_';
// 备用源：腾讯 / 新浪（GBK 编码 —— 中文名会乱码，但价格类字段是 ASCII 不受影响）
var TX_URL   = 'https://qt.gtimg.cn/q=';
var SINA_URL = 'https://hq.sinajs.cn/list=';

function busyWait(ms) {
  var t = Date.now() + ms;
  while (Date.now() < t) { /* 同步环境无 sleep，用空转退避 */ }
}

// secid(1.600519) -> 腾讯/新浪符号(sh600519)
function secidToSym(secid) {
  var p = String(secid).split('.');
  var mk = p[0], c = p[1], h = c.charAt(0);
  if (mk === '1') return 'sh' + c;
  if (h === '4' || h === '8') return 'bj' + c;
  if (h === '9' || h === '5') return 'sh' + c;
  return 'sz' + c;
}

function mapSyms(secids) {
  var out = [];
  for (var i = 0; i < secids.length; i++) out.push(secidToSym(secids[i]));
  return out;
}

function txTime(s) {
  if (!s || s.length < 14) return '';
  return s.substring(0, 4) + '-' + s.substring(4, 6) + '-' + s.substring(6, 8) + ' ' +
         s.substring(8, 10) + ':' + s.substring(10, 12) + ':' + s.substring(12, 14);
}

// 计算涨跌额/涨跌幅（腾讯、新浪不直接给，需自算）
function calcDelta(price, prev) {
  if (price === null || prev === null || !prev) return { amt: null, pct: null };
  var amt = Math.round((price - prev) * 1000) / 1000;
  return { amt: amt, pct: Math.round(amt / prev * 10000) / 100 };
}

// 统一行情结构：{ name, price, change, changeAmt, open, high, low, prevClose, time, noName }

// secid 数组 -> { 符号: secid } 映射（腾讯/新浪解析时反查用）
function buildSymMap(secids) {
  var bySym = {};
  for (var i = 0; i < secids.length; i++) bySym[secidToSym(secids[i])] = secids[i];
  return bySym;
}

function parseEastmoney(body) {
  var data = JSON.parse(body);
  if (!data || !data.data || !data.data.diff) return null;
  var map = {};
  for (var i = 0; i < data.data.diff.length; i++) {
    var d = data.data.diff[i];
    map[String(d.f13) + '.' + String(d.f12)] = {
      name: d.f14, price: d.f2, change: d.f3, changeAmt: d.f4,
      open: d.f17, high: d.f15, low: d.f16, prevClose: d.f18, time: fmtTime(d.f124)
    };
  }
  return map;
}

function parseTencent(body, secids) {
  var bySym = buildSymMap(secids), map = {};
  var lines = String(body).split(';');
  for (var j = 0; j < lines.length; j++) {
    var m = /v_([a-z]{2}\d{6})="([^"]*)"/.exec(lines[j]);
    if (!m || !bySym[m[1]]) continue;
    var f = m[2].split('~');
    if (f.length < 35) continue;
    var price = num(f[3]), prev = num(f[4]);
    var dl = calcDelta(price, prev);
    map[bySym[m[1]]] = {
      name: f[1], price: price, change: dl.pct, changeAmt: dl.amt,
      open: num(f[5]), high: num(f[33]), low: num(f[34]), prevClose: prev,
      time: txTime(f[30]), noName: true   // GBK 源名称可能乱码，不覆盖已有名称
    };
  }
  return map;
}

function parseSina(body, secids) {
  var bySym = buildSymMap(secids), map = {};
  var lines = String(body).split(';');
  for (var j = 0; j < lines.length; j++) {
    var m = /hq_str_([a-z]{2}\d{6})="([^"]*)"/.exec(lines[j]);
    if (!m || !bySym[m[1]]) continue;
    var f = m[2].split(',');
    if (f.length < 10) continue;
    var price = num(f[3]), prev = num(f[2]);
    var dl = calcDelta(price, prev);
    map[bySym[m[1]]] = {
      name: f[0], price: price, change: dl.pct, changeAmt: dl.amt,
      open: num(f[1]), high: num(f[4]), low: num(f[5]), prevClose: prev,
      time: (f[30] && f[31]) ? f[30] + ' ' + f[31] : '', noName: true
    };
  }
  return map;
}

// 同花顺 realhead：JSONP 包装「quotebridge_v2_realhead_hs_{code}_last({...})」
// 字段 ID 映射（实测验证）：
//   5       = 股票代码（"600519"）
//   6       = 昨收
//   7       = 今开
//   8       = 最高
//   9       = 最低
//   10      = 最新价
//   13      = 成交量（手）
//   19      = 成交额（元）
//   199112  = 涨跌幅%（直接给小数：2.40 表示 2.40%）
//   name    = 中文名（UTF-8 明文，不会乱码）
//   updateTime = 行情时间戳（"2026-09-04 15:30"）
//   marketType  = "HS_stock_sh" / "HS_stock_sz"
function parseTonghuashun(body) {
  var m = /^quotebridge_v2_realhead_hs_\d+_last\((.*)\)\s*$/.exec(String(body).trim());
  if (!m) return null;
  var obj;
  try { obj = JSON.parse(m[1]); } catch (e) { return null; }
  var items = obj && obj.items;
  // items 为空 = 没数据（停牌/限流）→ 返回 null 让 fetchTonghuashunMap 跳过、走批量降级
  if (!items || keyCount(items) === 0) return null;
  var price = num(items['10']);
  var prevClose = num(items['6']);
  var pct = num(items['199112']);   // 已经是百分比小数（2.40 = 2.40%）
  var ut = String(items['updateTime'] || '');
  if (ut && ut.length === 16) ut = ut + ':00';   // "2026-09-04 15:30" -> "2026-09-04 15:30:00"
  return {
    name: String(items['name'] || ''),
    price: price,
    change: pct,
    changeAmt: calcDelta(price, prevClose).amt,
    open: num(items['7']),
    high: num(items['8']),
    low: num(items['9']),
    prevClose: prevClose,
    time: ut,
    noName: false   // UTF-8 明文，覆盖名称
  };
}

// 同花顺不支持批量，每只一次请求；每只间隔 50ms 避免触发频率限制
// 返回 { secid: dataObj }；某只失败不影响其他
function fetchTonghuashunMap(secids) {
  var map = {};
  if (secids.length === 0) return map;
  for (var i = 0; i < secids.length; i++) {
    var code = String(secids[i]).split('.')[1];
    if (!code) continue;
    var resp = null;
    try {
      resp = HTTP.get(THS_URL + code + '/last.js',
        { timeout: CONFIG.fastTimeout, headers: { 'User-Agent': UA } });
    } catch (e) { continue; }
    if (!resp || resp.status !== 200) continue;
    try {
      var obj = parseTonghuashun(resp.text());
      if (obj) map[secids[i]] = obj;
    } catch (pe) { /* 单只解析失败跳过 */ }
    if (i < secids.length - 1) busyWait(50);
  }
  console.log('同花顺：获取 ' + keyCount(map) + '/' + secids.length + ' 个（中文名UTF-8，涨跌幅直给）');
  return map;
}

function fetchBatch(secids) {
  var all = {};
  var remaining = secids.slice(0);
  var emHeaders = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };
  // 每个批量源只查询上一个源缺失的标的，不因“部分返回”提前结束降级链。
  for (var pi = 0; pi < 4 && remaining.length > 0; pi++) {
    var q = pi < 2 ? '?secids=' + remaining.join(',') + '&fields=' + API_FIELDS + '&fltt=2&invt=2' : '';
    var syms = pi >= 2 ? mapSyms(remaining).join(',') : '';
    var plan;
    if (pi === 0) {
      plan = { n: '东财delay', u: 'https://' + EM_HOSTS[0] + '/api/qt/ulist.np/get' + q,
               p: parseEastmoney, h: emHeaders, timeout: CONFIG.timeout };
    } else if (pi === 1) {
      plan = { n: '东财主站', u: 'https://' + EM_HOSTS[1] + '/api/qt/ulist.np/get' + q,
               p: parseEastmoney, h: emHeaders, timeout: CONFIG.fastTimeout };
    } else if (pi === 2) {
      plan = { n: '腾讯', u: TX_URL + syms, p: parseTencent,
               h: { 'User-Agent': UA, 'Referer': 'https://gu.qq.com/' }, timeout: CONFIG.fastTimeout };
    } else {
      plan = { n: '新浪', u: SINA_URL + syms, p: parseSina,
               h: { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn' }, timeout: CONFIG.fastTimeout };
    }
    var lastStatus = '无响应';
    var resp = null;
    try {
      resp = HTTP.get(plan.u, { timeout: plan.timeout, headers: plan.h });
    } catch (e) {
      lastStatus = String(e);
    }
    if (resp && resp.status === 200) {
      var parsed = null;
      try {
        parsed = plan.p(resp.text(), remaining);
      } catch (pe) {
        console.log('[' + plan.n + '] 解析失败：' + pe);
      }
      if (parsed && keyCount(parsed) > 0) {
        for (var pk in parsed) {
          if (Object.prototype.hasOwnProperty.call(parsed, pk)) all[pk] = parsed[pk];
        }
        var next = [];
        for (var ri = 0; ri < remaining.length; ri++) {
          if (!all[remaining[ri]]) next.push(remaining[ri]);
        }
        console.log('数据源：' + plan.n + '，返回 ' + keyCount(parsed) + ' 条，剩余 ' + next.length + ' 条');
        remaining = next;
        continue;
      }
      lastStatus = '返回为空';
    } else if (resp) {
      lastStatus = String(resp.status);
    }
    console.log('[降级] ' + plan.n + ' 不可用（' + lastStatus + '），切换下一数据源');
  }
  if (keyCount(all) === 0) console.log('[错误] 全部批量行情数据源均不可用，请稍后重试');
  return all;
}

// ==================== 5. 历史行情数据源 ====================
// 采用保守的 ES3/ES5 写法；连续失败 3 次立即停止，避免接口异常时逐只超时。
function fetchEastmoneyYesterdayMap(secids) {
  var map = {};
  if (CONFIG.enableYesterday === false || secids.length === 0) return map;
  var today = nowStr().substring(0, 10);
  var base = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?klt=101&fqt=1&lmt=3&end=20500101&fields1=f1,f2,f3&fields2=f51,f59&secid=';
  var klineHeaders = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };
  var failCount = 0;
  for (var i = 0; i < secids.length; i++) {
    var resp = null;
    try {
      resp = HTTP.get(base + secids[i], { timeout: CONFIG.klineTimeout, headers: klineHeaders });
    } catch (e) {
      resp = null;
    }
    if (!resp || resp.status !== 200) {
      failCount++;
      if (failCount >= 3) {
        console.log('[熔断] 东财历史K线连续失败 3 次，停止剩余请求');
        break;
      }
      continue;
    }
    try {
      var obj = JSON.parse(resp.text());
      var ks = obj && obj.data && obj.data.klines;
      if (ks && ks.length >= 2) {
        var bars = [];
        for (var k = 0; k < ks.length; k++) {
          bars.push(String(ks[k]).split(','));
        }
        var last = bars[bars.length - 1];
        var yBar = (last[0] === today) ? bars[bars.length - 2] : last;
        var yPct = yBar ? num(yBar[1]) : null;
        if (yPct !== null) {
          map[secids[i]] = yPct;
          failCount = 0;
        } else {
          failCount++;
        }
      } else {
        failCount++;
      }
    } catch (pe) {
      failCount++;
    }
    if (failCount >= 3) {
      console.log('[熔断] 东财历史K线连续返回无效数据，停止剩余请求');
      break;
    }
  }
  console.log('昨日涨跌：东财获取 ' + keyCount(map) + '/' + secids.length + ' 个');
  return map;
}

// 腾讯历史K线备用源。返回行格式通常为：日期、开盘、收盘、最高、最低、成交量。
// 接口不直接给昨日涨跌幅，因此用目标交易日收盘价和前一交易日收盘价计算。
function fetchTencentYesterdayMap(secids) {
  var map = {};
  if (secids.length === 0) return map;
  var todayNum = nowStr().substring(0, 10).replace(/\D/g, '');
  var txHeaders = { 'User-Agent': UA, 'Referer': 'https://gu.qq.com/' };
  var failCount = 0;
  for (var i = 0; i < secids.length; i++) {
    var sym = secidToSym(secids[i]);
    var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + sym + ',day,,,4,qfq';
    var resp = null;
    try {
      resp = HTTP.get(url, { timeout: CONFIG.klineTimeout, headers: txHeaders });
    } catch (e) {
      resp = null;
    }
    if (!resp || resp.status !== 200) {
      failCount++;
    } else {
      try {
        var obj = JSON.parse(resp.text());
        var node = obj && obj.data ? obj.data[sym] : null;
        var bars = null;
        if (node) {
          if (node.qfqday) bars = node.qfqday;
          else if (node.day) bars = node.day;
        }
        if (bars && bars.length >= 2) {
          var lastIndex = bars.length - 1;
          var lastDateNum = String(bars[lastIndex][0]).replace(/\D/g, '');
          var targetIndex = lastDateNum === todayNum ? lastIndex - 1 : lastIndex;
          var prevIndex = targetIndex - 1;
          if (prevIndex >= 0) {
            var targetClose = num(bars[targetIndex][2]);
            var prevClose = num(bars[prevIndex][2]);
            if (targetClose !== null && prevClose !== null && prevClose !== 0) {
              map[secids[i]] = Math.round((targetClose - prevClose) / prevClose * 10000) / 100;
              failCount = 0;
            } else {
              failCount++;
            }
          } else {
            failCount++;
          }
        } else {
          failCount++;
        }
      } catch (pe) {
        failCount++;
      }
    }
    if (failCount >= 3) {
      console.log('[熔断] 腾讯历史K线连续失败 3 次，停止剩余请求');
      break;
    }
  }
  console.log('昨日涨跌：腾讯获取 ' + keyCount(map) + '/' + secids.length + ' 个');
  return map;
}

function fetchYesterdayMap(secids) {
  if (CONFIG.enableYesterday === false || secids.length === 0) return {};
  var map, fallbackMap;
  var missing = [];
  var i, k;

  // 当前已验证腾讯源可用，因此默认腾讯优先，避免先等待东财连续超时。
  // 如以后东财在你的网络中更快，可把 yesterdayPreferTencent 改为 false。
  if (CONFIG.yesterdayPreferTencent !== false) {
    map = fetchTencentYesterdayMap(secids);
  } else {
    map = fetchEastmoneyYesterdayMap(secids);
  }

  if (keyCount(map) < secids.length) {
    for (i = 0; i < secids.length; i++) {
      if (map[secids[i]] === undefined) missing.push(secids[i]);
    }
    if (CONFIG.yesterdayPreferTencent !== false) {
      fallbackMap = fetchEastmoneyYesterdayMap(missing);
    } else {
      fallbackMap = fetchTencentYesterdayMap(missing);
    }
    for (k in fallbackMap) {
      if (Object.prototype.hasOwnProperty.call(fallbackMap, k)) map[k] = fallbackMap[k];
    }
  }
  console.log('昨日涨跌：合计获取 ' + keyCount(map) + '/' + secids.length + ' 个');
  if (keyCount(map) === 0) {
    console.log('[提示] 东财和腾讯历史K线当前均不可用；已快速熔断，下次运行会重试');
  }
  return map;
}

// ==================== 6. 昨日涨跌缓存 ====================
// 写缓存标记，格式：'昨日涨跌缓存:2026-09-04|12|a1b2c3d4'
// 日期明码显示；|12 是完整缓存行数；最后 8 位是代码与行号的校验码。
function writeYesterdayCache(cell, todayStr, rowCount, signature) {
  try {
    var prev = String(cell.Value2 === undefined ? '' : cell.Value2).trim();
    var isOldCache = /^Y?\d{4}-\d{2}-\d{2}(\|\d+)?(\|[0-9a-fA-F]{8})?$/.test(prev);
    // 不在正则字面量中放中文，兼容部分较旧的 AirScript 解析器。
    var isVisibleCache = prev.indexOf('昨日涨跌缓存:') === 0;
    if (prev !== '' && !isOldCache && !isVisibleCache) {
      console.log('[警告] 第 ' + CONFIG.yesterdayCacheCol +
                  ' 列第 1 行已被你的内容占用，未写入缓存基准日（请改大 yesterdayCacheCol）；' +
                  '本次仍能出数，但每次刷新都会逐只请求K线、慢一些');
      return false;
    }
    var marker = '昨日涨跌缓存:' + todayStr + '|' + rowCount + '|' + signature;
    setValueIfChanged(cell, marker);
    // 覆盖旧版的 ;;; 隐藏格式，强制按文本显示。
    try { if (cell.NumberFormatLocal !== '@') cell.NumberFormatLocal = '@'; } catch (ne) {}
    return true;
  } catch (e) {
    return false;
  }
}

// 汇总列只在表头下一格显示；清理其余数据行，避免股票增删后留下旧合计。
function writeHoldingSummary(sheet, col, firstDataRow, lastDataRow, amount) {
  if (col < 0) return;
  writeMoney(sheet.Cells(firstDataRow, col), amount, true);
  if (lastDataRow > firstDataRow) {
    try { sheet.Range(sheet.Cells(firstDataRow + 1, col), sheet.Cells(lastDataRow, col)).ClearContents(); }
    catch (e) {
      for (var r = firstDataRow + 1; r <= lastDataRow; r++) sheet.Cells(r, col).Value2 = '';
    }
  }
}

// 从旧版第16列迁移到新的缓存列。只有确认是脚本缓存标记时才清除，避免误删用户内容。
function cleanupLegacyCacheMarker(sheet) {
  if (CONFIG.yesterdayCacheCol === 16) return;
  try {
    var oldCell = sheet.Cells(1, 16);
    var oldValue = cellText(oldCell.Value2);
    var oldFormat = /^Y?\d{4}-\d{2}-\d{2}(\|\d+)?(\|[0-9a-fA-F]{8})?$/.test(oldValue);
    var visibleFormat = oldValue.indexOf('昨日涨跌缓存:') === 0;
    if (oldFormat || visibleFormat) {
      oldCell.Value2 = '';
      try { oldCell.NumberFormatLocal = '@'; } catch (fe) {}
      console.log('已清理旧缓存标记：第16列第1行');
    }
  } catch (e) { /* 清理失败不影响行情刷新 */ }
}

// ==================== 7. 主流程：表格读取与任务调度 ====================

function runMain() {
  var sheet = null;
  try {
    sheet = Application.Worksheets.Item(CONFIG.targetSheet);
  } catch (se) {
    console.log('[错误] 找不到目标工作表「' + CONFIG.targetSheet + '」，脚本已停止；请检查 CONFIG.targetSheet');
    return;
  }
  if (!sheet) {
    console.log('[错误] 找不到目标工作表「' + CONFIG.targetSheet + '」，脚本已停止；请检查 CONFIG.targetSheet');
    return;
  }
  console.log('目标工作表：' + CONFIG.targetSheet);
  var used;
  try { used = sheet.UsedRange; } catch (e) {
    console.log('[错误] 读取工作表失败：' + e);
    return;
  }

  var startRow, startCol, rowCount, colCount, headers;

  if (!used) {
    // UsedRange 返回 null（完全空白的工作表）
    startRow = 1; startCol = 1; rowCount = 0; colCount = 0; headers = [];
  } else {
    startRow = used.Row;
    startCol = used.Column;
    rowCount = used.Rows.Count;
    colCount = used.Columns.Count;
    headers = [];
    for (var c = 0; c < colCount; c++) {
      headers.push(String(sheet.Cells(startRow, startCol + c).Value2 || '').trim());
    }
  }

  // 判断是否需要自动建表头：只要第一行「没有任何表头」（用户没建过），就视为空白工作表自动建。
  // 之前要求 rowCount<=1 && colCount<=1 太严：WPS 的 UsedRange 一旦被点击/选区就会扩大，
  // 即使内容为空也会返回 (1,1)~(n,m)，导致这个守卫把"视觉空白但选区存在"的情况挡在外面，
  // 跳过自动建表直接退出，用户体验为"注释说会建但实际没建"。
  var isEmpty = !used || headers.length === 0 || headers.join('').trim() === '';

  if (isEmpty) {
    console.log('工作表为空，自动建立表头与示例代码');
    var dh = ['股票代码', '股票名称', '最新价', '今日涨跌', '昨日涨跌', '涨跌额', '今开', '最高', '最低', '昨收',
              '持仓数量', '成本价', '实时涨跌', '持仓收益率', '更新时间', '状态', '总浮动盈亏', '当日总盈亏'];
    for (var i = 0; i < dh.length; i++) sheet.Cells(1, i + 1).Value2 = dh[i];
    // 注意：示例代码用 "sh600519" 这种带前缀的形式，"000001" 前加 "sz" 前缀，
    // 避免 WPS 工作簿的「常规」格式把 "000001" 误识别为数字 1 而丢失前导零
    sheet.Cells(2, 1).Value2 = '600519';
    sheet.Cells(3, 1).Value2 = 'sz000001';
    sheet.Cells(4, 1).Value2 = '510300';
    sheet.Cells(5, 1).Value2 = '159915';
    headers = dh;
    startRow = 1; startCol = 1; rowCount = 5; colCount = dh.length;
  }

  console.log('表头：' + headers.join(' | '));

  var colCode = findCol(headers, CONFIG.fields.code, startCol);
  if (colCode < 0) {
    console.log('[错误] 找不到股票代码列，表头需包含：' + CONFIG.fields.code.join('/'));
    return;
  }

  var cols = {
    name:      findCol(headers, CONFIG.fields.name, startCol),
    price:     findCol(headers, CONFIG.fields.price, startCol),
    change:    findCol(headers, CONFIG.fields.change, startCol),
    changeY:   findCol(headers, CONFIG.fields.changeY, startCol),
    changeAmt: findCol(headers, CONFIG.fields.changeAmt, startCol),
    open:      findCol(headers, CONFIG.fields.open, startCol),
    high:      findCol(headers, CONFIG.fields.high, startCol),
    low:       findCol(headers, CONFIG.fields.low, startCol),
    prevClose: findCol(headers, CONFIG.fields.prevClose, startCol),
    updateAt:  findCol(headers, CONFIG.fields.updateAt, startCol),
    status:    findCol(headers, CONFIG.fields.status, startCol)
  };

  // ---- 持仓列识别（可选）：持仓数量/成本价由你手填，其余列脚本自动算 ----
  // 实时涨跌（当日盈亏）= 涨跌额 × 持仓数量；持仓市值 = 最新价 × 持仓数量；
  // 浮动盈亏 = (最新价 - 成本价) × 持仓数量
  var hcols = null;
  if (CONFIG.enableHoldings) {
    hcols = {
      qty:     findCol(headers, CONFIG.qty, startCol),
      cost:    findCol(headers, CONFIG.cost, startCol),
      value:   findCol(headers, CONFIG.value, startCol),
      plDay:   findCol(headers, CONFIG.plDay, startCol),
      plTotal: findCol(headers, CONFIG.plTotal, startCol),
      plRate:  findCol(headers, CONFIG.plRate, startCol),
      totalPl: findCol(headers, CONFIG.totalPl, startCol),
      totalDay: findCol(headers, CONFIG.totalDay, startCol)
    };
    var hAny = hcols.qty > 0 || hcols.cost > 0 || hcols.value > 0 ||
               hcols.plDay > 0 || hcols.plTotal > 0 || hcols.plRate > 0 ||
               hcols.totalPl > 0 || hcols.totalDay > 0;
    if (hAny) {
      console.log('持仓列识别 —— 数量' + (hcols.qty > 0 ? '√' : '×') + ' 成本' + (hcols.cost > 0 ? '√' : '×') +
                  ' 市值' + (hcols.value > 0 ? '√' : '×') + ' 实时涨跌' + (hcols.plDay > 0 ? '√' : '×') +
                  ' 浮动盈亏' + (hcols.plTotal > 0 ? '√' : '×') + ' 收益率' + (hcols.plRate > 0 ? '√' : '×') +
                  ' 总浮动盈亏' + (hcols.totalPl > 0 ? '√' : '×') + ' 当日总盈亏' + (hcols.totalDay > 0 ? '√' : '×'));
      if (hcols.qty < 0) {
        console.log('[提示] 未找到「持仓数量」列，市值和盈亏金额将不计算；持仓收益率仍可根据成本价独立计算');
      }
      // 收益率依赖成本价：只加了收益率列却没成本价列时给出明确指引，避免"列加了却一直空白"
      if (hcols.plRate > 0 && hcols.cost < 0) {
        console.log('[提示] 已识别「持仓收益率」列，但未找到「成本价」列；添加表头「成本价」并填入买入成本后才会计算');
      }
    } else {
      console.log('[提示] 未检测到任何持仓列；如需自动计算实时涨跌，请添加表头「持仓数量」「实时涨跌」（可选：「成本价」「持仓市值」「浮动盈亏」「持仓收益率」）');
    }
  }

  if (cols.changeY < 0 && CONFIG.enableYesterday !== false) {
    console.log('[提示] 未找到「昨日涨跌」列；加一列表头「昨日涨跌」即可自动填充上一交易日涨跌幅');
  }

  // 收集代码
  var jobs = [];
  var usedLastRow = startRow + rowCount - 1;
  var lastCodeRow = findLastCodeRow(sheet, colCode, startRow, usedLastRow);
  console.log('代码数据范围：第 ' + (startRow + 1) + ' 行至第 ' + lastCodeRow + ' 行');
  for (var r = startRow + 1; r <= lastCodeRow; r++) {
    var code = String(sheet.Cells(r, colCode).Value2 || '').trim();
    if (!code) continue;
    var secid = toSecid(code);
    if (!secid) {
      if (cols.status > 0) sheet.Cells(r, cols.status).Value2 = '代码无效：' + code;
      console.log('第 ' + r + ' 行代码无效：' + code);
      continue;
    }
    jobs.push({ row: r, key: secid });
  }
  console.log('有效代码 ' + jobs.length + ' 个');
  lap('扫描表格');
  if (jobs.length === 0) {
    if (hcols) {
      writeHoldingSummary(sheet, hcols.totalPl, startRow + 1, lastCodeRow, null);
      writeHoldingSummary(sheet, hcols.totalDay, startRow + 1, lastCodeRow, null);
    }
    return;
  }

  // 分批请求。速度优化的关键：先走批量源，只有批量链全部未返回的少数标的
  // 才逐只请求同花顺。旧版把同花顺放第一位，N 只股票就必做 N 次 HTTP 请求。
  var quoteMap = {};
  var size = CONFIG.batchSize > 0 ? CONFIG.batchSize : 40;
  // 行情请求按标的去重，同一代码出现在多行时只请求一次。
  var secidListAll = [];
  for (var sl = 0; sl < jobs.length; sl++) secidListAll.push(jobs[sl].key);
  var secidList = uniqueList(secidListAll);
  if (secidList.length < jobs.length) {
    console.log('检测到重复代码：共 ' + jobs.length + ' 行、' + secidList.length + ' 只标的；相同代码仅请求一次');
  }
  // 第一阶段：批量链（东财delay → 东财主站 → 腾讯 → 新浪）。
  for (var s = 0; s < secidList.length; s += size) {
    var e = Math.min(s + size, secidList.length);
    var batch = secidList.slice(s, e);
    console.log('批量请求第 ' + (Math.floor(s / size) + 1) + ' 批，' + batch.length + ' 个代码');
    var result = fetchBatch(batch);
    if (result) {
      for (var key in result) {
        if (Object.prototype.hasOwnProperty.call(result, key)) quoteMap[key] = result[key];
      }
    }
  }

  // 第二阶段：仅对批量源没拿到的标的逐只补齐；正常情况下不会进入这一段。
  if (keyCount(quoteMap) < secidList.length) {
    var missing = [];
    for (var mi = 0; mi < secidList.length; mi++) {
      if (!quoteMap[secidList[mi]]) missing.push(secidList[mi]);
    }
    console.log('批量源缺失 ' + missing.length + ' 只，使用同花顺逐只补齐...');
    var ttsMap = fetchTonghuashunMap(missing);
    for (var k1 in ttsMap) {
      if (Object.prototype.hasOwnProperty.call(ttsMap, k1)) quoteMap[k1] = ttsMap[k1];
    }
  }
  if (keyCount(quoteMap) === secidList.length) {
    console.log('行情获取：全部 ' + secidList.length + ' 只均有数据');
  } else {
    console.log('行情获取：仍有 ' + (secidList.length - keyCount(quoteMap)) + ' 只无数据');
  }
  lap('行情请求');

  // 昨日涨跌（上一交易日涨跌幅）：腾讯优先、东财补缺；无「昨日涨跌」列则跳过。
  // 提速：同一交易日该值恒定不变，只需取一次——缓存基准日写在第 yesterdayCacheCol 列第 1 行，
  // 命中缓存后分三种情况处理：
  //   ① 日期 + 行数都没变 → 快路径：一次请求、一次读格都不做（最快，每次刷新走这条）
  //   ② 日期和签名相同，但缓存不完整 → 逐行扫空值，只补缺口
  //   ③ 日期或签名不同（含增删行、换代码）→ 全量重取
  var yMap = {};
  if (cols.changeY > 0 && CONFIG.enableYesterday !== false) {
    var yToday = nowStr().substring(0, 10);
    var yTodayNum = yToday.replace(/\D/g, '');          // '2026-09-04' -> '20260904'
    cleanupLegacyCacheMarker(sheet);
    var yCacheCell = sheet.Cells(1, CONFIG.yesterdayCacheCol);
    // 即使本次所有历史源都失败，也先解除旧版的隐藏格式，让已有缓存日期可见。
    try { if (yCacheCell.NumberFormatLocal !== '@') yCacheCell.NumberFormatLocal = '@'; } catch (fe) {}
    // 只比对数字：同时兼容 'Y2026-09-04|12'(新写法) 和 '2026-09-04'(旧写法)。
    // 万一该格被 WPS 转成了日期序列号，数字比对自然不相等 → 判为未命中，重取一次即自愈。
    var yRaw = '';
    try { yRaw = String(yCacheCell.Value2 === undefined ? '' : yCacheCell.Value2); } catch (e) {}
    var yParts = yRaw.split('|');
    var yCacheDate = yParts[0].replace(/\D/g, '');
    var yCacheCnt = parseInt(yParts[1], 10);
    if (isNaN(yCacheCnt)) yCacheCnt = -1;               // 旧格式没记行数 → 视为未知，走扫描
    var ySignature = jobsSignature(jobs);
    var yCacheSignature = yParts[2] || '';
    // 日期相同但签名不同，说明代码/行号发生变化，必须全量重取，不能沿用原行旧值。
    // 旧版缓存没有签名，也会安全地全量刷新一次并升级成新格式。
    var hit = CONFIG.yesterdayCache !== false && yCacheDate === yTodayNum &&
              yCacheSignature === ySignature;

    if (hit && yCacheCnt === jobs.length) {
      // ① 快路径：日期对、行数也没变 → 认定无缺口，连 N 次读格都省掉
      console.log('昨日涨跌：命中今日缓存（日期+行数均一致），完全跳过（提速）');
    } else if (hit) {
      // ② 同一批股票缓存尚未完整：扫描缺口
      var gaps = [];
      for (var gi = 0; gi < jobs.length; gi++) {
        var gv = '';
        try { gv = cellText(sheet.Cells(jobs[gi].row, cols.changeY).Value2); } catch (ge) {}
        if (!gv) gaps.push(jobs[gi].key);
      }
      if (gaps.length === 0) {
        console.log('昨日涨跌：命中今日缓存且无缺口，跳过逐只请求（提速）');
        writeYesterdayCache(yCacheCell, yToday, jobs.length, ySignature);   // 补记签名，下次走快路径
      } else {
        console.log('昨日涨跌：命中今日缓存，补取 ' + gaps.length + ' 个缺口（当天新增/被清空的行）');
        gaps = uniqueList(gaps);
        yMap = fetchYesterdayMap(gaps);
        // 缺口全补齐才记行数，否则记 0 —— 下次继续补，避免"行数一致"把失败的行永久漏掉
        writeYesterdayCache(yCacheCell, yToday, keyCount(yMap) === gaps.length ? jobs.length : 0, ySignature);
      }
    } else {
      // ③ 新交易日 / 首次运行：全量重取
      yMap = fetchYesterdayMap(secidList);
      // 仅在确实取到数据时才写缓存基准日；否则一次全网失败（如限流）会"污染"缓存，
      // 导致当天后续刷新全部误判命中、昨日涨跌永久为空
      if (CONFIG.yesterdayCache !== false && keyCount(yMap) > 0) {
        writeYesterdayCache(yCacheCell, yToday, keyCount(yMap) === secidList.length ? jobs.length : 0, ySignature);
      }
    }
  }
  lap('昨日涨跌');

  // 写回
  var ok = 0, noData = 0;
  var totalPl = 0, totalDay = 0, totalPlCount = 0, totalDayCount = 0;
  var summaryMissingPl = false, summaryMissingDay = false;
  // 只汇总本轮有效报价；缺数据时清空对应合计并提示，避免部分合计冒充总额。
  if (hcols && (hcols.totalPl > 0 || hcols.totalDay > 0)) {
    for (var sr = startRow + 1; sr <= lastCodeRow; sr++) {
      var sq = hcols.qty > 0 ? num(sheet.Cells(sr, hcols.qty).Value2) : null;
      if (sq === null || sq <= 0) continue;
      var sk = toSecid(sheet.Cells(sr, colCode).Value2);
      var sd = sk ? quoteMap[sk] : null;
      var sp = sd ? num(sd.price) : null;
      if (sp === null || sp <= 0) {
        summaryMissingPl = true;
        summaryMissingDay = true;
      } else {
        var sc = hcols.cost > 0 ? num(sheet.Cells(sr, hcols.cost).Value2) : null;
        if (sc === null || sc <= 0) summaryMissingPl = true;
        if (num(sd.changeAmt) === null && num(sd.prevClose) === null) summaryMissingDay = true;
      }
    }
  }
  var writeQueues = {};
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    var d = quoteMap[job.key];
    if (!d) {
      noData++;
      queueCellWrite(writeQueues, cols.status, job.row, '无数据');
      continue;
    }
    var price = num(d.price);
    if (price !== null && price <= 0) price = null;
    // GBK 源（腾讯/新浪）名称可能乱码，标记 noName 的行不覆盖已有名称
    if (CONFIG.fillName && d.name && !d.noName && cols.name > 0) {
      queueCellWrite(writeQueues, cols.name, job.row, d.name);
    }
    var v;
    if (price !== null) queueCellWrite(writeQueues, cols.price, job.row, price);
    if ((v = num(d.change))    !== null && cols.change    > 0) writeChange(sheet.Cells(job.row, cols.change), v);
    if ((v = num(d.changeAmt)) !== null) queueCellWrite(writeQueues, cols.changeAmt, job.row, v);
    if ((v = num(d.open))      !== null) queueCellWrite(writeQueues, cols.open, job.row, v);
    if ((v = num(d.high))      !== null) queueCellWrite(writeQueues, cols.high, job.row, v);
    if ((v = num(d.low))       !== null) queueCellWrite(writeQueues, cols.low, job.row, v);
    if ((v = num(d.prevClose)) !== null) queueCellWrite(writeQueues, cols.prevClose, job.row, v);
    // 停牌时保留旧「更新时间」：没有新行情就不覆盖时间戳
    if (price !== null && cols.updateAt > 0) writeTime(sheet.Cells(job.row, cols.updateAt), d.time);

    // 昨日涨跌：停牌标的同样有效（K线最后一根即最近一个交易日）。
    // 命中快路径时（yMap 没值），仍要刷新单元格字体色——避免「redGreen 从 true 改 false」后
    // 上次留下的红/绿字留在表上。仅调 setFontColor，不动值；setFontColor 内部已有「写前跳过」逻辑，
    // 当前色 == 目标色时不会真发起写入，所以反复刷新基本零开销。
    if (cols.changeY > 0 && CONFIG.enableYesterday !== false) {
      if (yMap[job.key] !== undefined) {
        writeChange(sheet.Cells(job.row, cols.changeY), yMap[job.key]);
      } else {
        setFontColor(sheet.Cells(job.row, cols.changeY), COLOR_TEXT);
      }
    }

    // ==================== 8. 持仓计算 ====================
    // 市值 / 实时涨跌（当日盈亏）/ 浮动盈亏
    if (hcols && price !== null) {
      var qty  = hcols.qty  > 0 ? num(sheet.Cells(job.row, hcols.qty).Value2)  : null;
      var cost = hcols.cost > 0 ? num(sheet.Cells(job.row, hcols.cost).Value2) : null;
      if (qty !== null && qty > 0) {
        if (hcols.value > 0) {
          writeMoney(sheet.Cells(job.row, hcols.value), price * qty, false);
        }
        // 实时涨跌 = 涨跌额 × 持仓数量；涨跌额缺失时用 (最新价 - 昨收) 兜底
        var dayAmt = num(d.changeAmt);
        if (dayAmt === null) {
          var pc = num(d.prevClose);
          dayAmt = pc !== null ? price - pc : null;
        }
        if (hcols.plDay > 0) {
          writeMoney(sheet.Cells(job.row, hcols.plDay), dayAmt !== null ? dayAmt * qty : null, true);
        }
        if (dayAmt !== null) {
          totalDay += dayAmt * qty;
          totalDayCount++;
        }
        if (hcols.plTotal > 0) {
          writeMoney(sheet.Cells(job.row, hcols.plTotal), cost !== null && cost > 0 ? (price - cost) * qty : null, true);
        }
        if (cost !== null && cost > 0) {
          totalPl += (price - cost) * qty;
          totalPlCount++;
        }
      } else {
        // 未填持仓数量：清空衍生列，避免残留上次的旧值
        if (hcols.value   > 0) writeMoney(sheet.Cells(job.row, hcols.value),   null, false);
        if (hcols.plDay   > 0) writeMoney(sheet.Cells(job.row, hcols.plDay),   null, true);
        if (hcols.plTotal > 0) writeMoney(sheet.Cells(job.row, hcols.plTotal), null, true);
      }

      // 收益率只依赖最新价和成本价，与持仓数量无关。
      // 成本价缺失或 <= 0 时清空，避免除零及残留旧值。
      if (hcols.plRate > 0) {
        if (cost !== null && cost > 0) {
          writeChange(sheet.Cells(job.row, hcols.plRate), (price - cost) / cost * 100);
        } else {
          clearPercentCell(sheet.Cells(job.row, hcols.plRate));
        }
      }
    }

    if (price === null) {
      noData++;
      queueCellWrite(writeQueues, cols.status, job.row, '停牌/无报价');
      // 停牌：只清「今日涨跌」（当日无交易，不应显示今日涨跌幅）；
      // 其余数据（最新价/涨跌额/今开/最高/最低/昨收/更新时间/持仓衍生列）一律保留原值，
      // 「昨日涨跌」由上方 K 线逻辑正常写入
      if (cols.change > 0) {
        var cc = sheet.Cells(job.row, cols.change);
        cc.Value2 = '';
        setFontColor(cc, COLOR_TEXT);
      }
    } else {
      ok++;
      queueCellWrite(writeQueues, cols.status, job.row, '正常');
    }
  }
  // ==================== 9. 表格批量写回 ====================
  flushWriteQueues(sheet, writeQueues);
  if (hcols) {
    writeHoldingSummary(sheet, hcols.totalPl, startRow + 1, lastCodeRow,
                        totalPlCount > 0 && !summaryMissingPl ? totalPl : null);
    writeHoldingSummary(sheet, hcols.totalDay, startRow + 1, lastCodeRow,
                        totalDayCount > 0 && !summaryMissingDay ? totalDay : null);
    if (hcols.totalPl > 0 && summaryMissingPl) console.log('[提示] 总浮动盈亏已清空：部分持仓缺少有效代码、报价或成本价');
    if (hcols.totalDay > 0 && summaryMissingDay) console.log('[提示] 当日总盈亏已清空：部分持仓缺少有效代码、报价或涨跌额');
  }
  lap('写回完成');
  console.log('完成：成功 ' + ok + ' 个，无数据/停牌 ' + noData + ' 个');
}

// 关闭屏幕刷新 —— 写入速度最大的一个杠杆。
// 开着时 WPS 几乎每写一个格就重绘一次（50 行 × 十几列 = 几百次重绘），关掉通常能快数倍。
// 用 finally 保证无论中途报错还是正常结束都能恢复，避免表格"卡住不刷新"。
function main() {
  var canToggle = false;
  try {
    Application.ScreenUpdating = false;
    canToggle = true;
  } catch (e) {
    console.log('[提示] 当前环境不支持关闭屏幕刷新，写入会慢一些（不影响数据正确性）');
  }
  try {
    runMain();
  } finally {
    if (canToggle) {
      try { Application.ScreenUpdating = true; } catch (e) {}
    }
  }
}

main();
