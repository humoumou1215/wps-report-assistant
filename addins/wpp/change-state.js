/* Reversible host mutations. No duplicate slides, files, clipboard or native undo stack. */
(function (global) {
  'use strict';
  var fontKeys = ['Name', 'NameFarEast', 'NameAscii', 'NameComplexScript', 'Size', 'Bold', 'Italic', 'Underline', 'Shadow', 'Emboss', 'BaselineOffset', 'AutoRotateNumbers', 'Subscript', 'Superscript'];
  var paragraphKeys = ['Alignment', 'BaseLineAlignment', 'FarEastLineBreakControl', 'HangingPunctuation', 'LineRuleAfter', 'LineRuleBefore', 'LineRuleWithin', 'SpaceAfter', 'SpaceBefore', 'SpaceWithin', 'TextDirection', 'WordWrap'];
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function canonical(x) {
    if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
    if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical(x[k]); }).join(',') + '}';
    return JSON.stringify(x);
  }
  function equal(a, b) { return canonical(a) === canonical(b); }
  function properties(obj, keys, required) {
    if (!obj) throw new Error('宿主缺少格式接口');
    var out = {};
    keys.forEach(function (k) {
      var v = obj[k];
      if (v === undefined || v === null) { if ((required || []).indexOf(k) >= 0) throw new Error('宿主不支持读取 ' + k); return; }
      if (typeof v !== 'string' && typeof v !== 'boolean' && (typeof v !== 'number' || !isFinite(v))) throw new Error('无法序列化 ' + k);
      out[k] = typeof v === 'number' ? Math.round(v * 10000) / 10000 : v;
    });
    return out;
  }
  function setProperties(obj, values) { Object.keys(values).forEach(function (k) { obj[k] = values[k]; }); }
  function color(c) {
    var out = properties(c, ['Type', 'RGB', 'SchemeColor', 'ObjectThemeColor', 'TintAndShade', 'Brightness'], ['RGB']);
    if (out.Type !== undefined && out.Type !== 1 && out.Type !== 2) throw new Error('暂不支持此文字颜色类型的撤销');
    return out;
  }
  function restoreColor(c, s) {
    if (s.Type === 2 && s.ObjectThemeColor > 0) c.ObjectThemeColor = s.ObjectThemeColor;
    else if (s.Type === 2 && s.SchemeColor !== undefined) c.SchemeColor = s.SchemeColor;
    else c.RGB = s.RGB;
    ['TintAndShade', 'Brightness'].forEach(function (k) { if (s[k] !== undefined) c[k] = s[k]; });
  }
  function font(f) { return { properties: properties(f, fontKeys, ['Name', 'Size', 'Bold', 'Italic', 'Underline']), color: color(f.Color) }; }
  function restoreFont(f, s) { setProperties(f, s.properties); restoreColor(f.Color, s.color); }
  function actionSetting(run, index) {
    var settings;
    try { settings = run.ActionSettings; } catch (e) { return null; }
    try {
      if (typeof settings === 'function') return settings(index);
      if (settings && typeof settings.Item === 'function') return settings.Item(index);
      if (settings && typeof settings.item === 'function') return settings.item(index);
      if (settings && settings[index] !== undefined) return settings[index];
    } catch (e) { return null; }
    return null;
  }
  function textState(shape) {
    var frame = shape.TextFrame, tr = frame.TextRange, text = String(tr.Text || '');
    if (text.length > 30000) throw new Error('单个对象文字超过 30,000 字符，暂不支持可撤销修改');
    var out = { text: text, frame: properties(frame, ['AutoSize', 'WordWrap', 'MarginLeft', 'MarginRight', 'MarginTop', 'MarginBottom', 'VerticalAnchor', 'Orientation'], ['AutoSize']), runs: [], paragraphs: [] };
    var runs = tr.Runs(), count = Number(runs.Count);
    if (!isFinite(count) || count > 30000) throw new Error('无法读取文字格式分段');
    for (var i = 1; i <= count; i++) {
      var run = tr.Runs(i, 1);
      // Text replacement would destroy character-level hyperlinks/actions.
      if (run.ActionSettings) for (var a = 1; a <= 2; a++) {
        var action = actionSetting(run, a);
        if (action && Number(action.Action || 0) !== 0) throw new Error('文字包含超链接或交互动作，暂不支持可撤销替换');
      }
      var start = Number(run.Start) - Number(tr.Start) + 1, length = Number(run.Length);
      if (!isFinite(start) || !isFinite(length) || start < 1 || length < 0) throw new Error('无法读取文字分段位置');
      out.runs.push({ start: start, length: length, font: font(run.Font), language: properties(run, ['LanguageID']) });
    }
    if (!out.runs.length) out.emptyFont = font(tr.Font);
    var paragraphs = tr.Paragraphs(), pc = Number(paragraphs.Count);
    if (!isFinite(pc) || pc > 30000) throw new Error('无法读取段落格式');
    for (var p = 1; p <= pc; p++) {
      var range = tr.Paragraphs(p, 1), pf = range.ParagraphFormat, bullet = pf.Bullet;
      var bs = properties(bullet, ['Type', 'Visible', 'Character', 'Style', 'StartValue', 'RelativeSize', 'UseTextColor', 'UseTextFont'], ['Type']);
      if (bs.Type === 3) throw new Error('图片项目符号暂不支持可撤销替换');
      out.paragraphs.push({ properties: properties(pf, paragraphKeys, ['Alignment']), indent: properties(range, ['IndentLevel']), bullet: bs, bulletFont: bs.Type ? font(bullet.Font) : null });
    }
    return out;
  }
  function restoreText(shape, s) {
    var frame = shape.TextFrame, tr = frame.TextRange;
    frame.AutoSize = 0;
    tr.Text = s.text;
    if (s.emptyFont) restoreFont(tr.Font, s.emptyFont);
    s.runs.forEach(function (r) { var range = tr.Characters(r.start, r.length); restoreFont(range.Font, r.font); setProperties(range, r.language); });
    s.paragraphs.forEach(function (p, i) {
      var range = tr.Paragraphs(i + 1, 1); setProperties(range, p.indent); setProperties(range.ParagraphFormat, p.properties);
      if (p.bullet.Type) setProperties(range.ParagraphFormat.Bullet, p.bullet);
      range.ParagraphFormat.Bullet.Type = p.bullet.Type;
      if(p.bullet.Visible !== undefined) range.ParagraphFormat.Bullet.Visible = p.bullet.Visible;
      if (p.bulletFont) restoreFont(range.ParagraphFormat.Bullet.Font, p.bulletFont);
    });
    setProperties(frame, s.frame);
  }
  function tableOf(shape) { if (shape.HasTable === true || shape.HasTable === -1) return shape.Table; return null; }
  function cellShapeId(shape) {
    try {
      var id = Number(shape && shape.Id);
      return isFinite(id) && id > 0 ? String(id) : null;
    } catch (e) { return null; }
  }
  function clearlySpansAnotherCell(actual, expected) {
    if (!isFinite(actual) || !isFinite(expected) || expected <= 0) return false;
    // WPS can expose a small rounding difference between a cell Shape and its
    // row/column. A real merged cell is materially larger than one grid slot.
    return actual > expected * 1.5 + 0.5;
  }
  function capture(shape) {
    try {
      var out = { version: 1, kind: 'text', geometry: properties(shape, ['Left', 'Top', 'Width', 'Height', 'Rotation', 'LockAspectRatio'], ['Left', 'Top', 'Width', 'Height']) }, table = tableOf(shape);
      if (!table) { out.text = textState(shape); return out; }
      out.kind = 'table'; out.rows = Number(table.Rows.Count); out.cols = Number(table.Columns.Count); out.cells = []; out.heights = []; out.widths = [];
      if (out.rows * out.cols > 2000) throw new Error('表格超过 2,000 个单元格，暂不支持可撤销修改');
      for (var c = 1; c <= out.cols; c++) out.widths.push(Number(table.Columns.Item(c).Width));
      var seenCellShapes = {};
      for (var r = 1; r <= out.rows; r++) {
        var line = [], height = Number(table.Rows.Item(r).Height); out.heights.push(height);
        for (var col = 1; col <= out.cols; col++) {
          var cell = table.Cell(r, col).Shape;
          var cellWidth = Number(cell.Width), cellHeight = Number(cell.Height), shapeId = cellShapeId(cell);
          if (!isFinite(height) || !isFinite(out.widths[col - 1]) || !isFinite(cellWidth) || !isFinite(cellHeight)) throw new Error('无法读取表格单元格尺寸，暂不支持可撤销修改');
          if (shapeId !== null) {
            if (seenCellShapes[shapeId]) throw new Error('检测到合并单元格，暂不支持可撤销修改');
            seenCellShapes[shapeId] = true;
          }
          if (clearlySpansAnotherCell(cellWidth, out.widths[col - 1]) || clearlySpansAnotherCell(cellHeight, height)) {
            throw new Error('检测到疑似合并单元格，暂不支持可撤销修改');
          }
          line.push(textState(cell));
        }
        out.cells.push(line);
      }
      return out;
    } catch (e) { throw new Error('无法完整记录目标对象，已停止修改：' + e.message); }
  }
  function preflight(shape, plan) {
    if (plan.kind === 'text') { if (tableOf(shape)) throw new Error('不能将文本计划写入表格'); if (!shape.TextFrame || !shape.TextFrame.TextRange) throw new Error('目标不是文本框'); return; }
    if (plan.kind !== 'table') throw new Error('不支持的渲染计划');
    if (Array.isArray(plan.mergeCells) && plan.mergeCells.length) throw new Error('演示文稿表格暂不支持输出合并单元格');
    var t = tableOf(shape); if (!t) throw new Error('目标不是表格');
    var desired = (plan.header ? 1 : 0) + (plan.rows || []).length;
    if (plan.resizeRows && Math.max(desired, 1) !== Number(t.Rows.Count)) throw new Error('本次需要改变表格行数，尚无法完整撤销行格式。请先将原表格调整为 ' + Math.max(desired, 1) + ' 行，再重新生成。');
    if (desired > t.Rows.Count) throw new Error('目标表格行数不足');
    [plan.header || []].concat(plan.rows || []).forEach(function (row) { if (row.length > t.Columns.Count) throw new Error('目标表格列数不足'); });
  }
  function apply(shape, plan) {
    preflight(shape, plan);
    if (plan.kind === 'text') { shape.TextFrame.TextRange.Text = String(plan.text == null ? '' : plan.text); return; }
    var rows = (plan.header ? [plan.header] : []).concat(plan.rows || []), table = shape.Table;
    rows.forEach(function (row, r) { row.forEach(function (v, c) { table.Cell(r + 1, c + 1).Shape.TextFrame.TextRange.Text = String(v == null ? '' : v); }); });
  }
  function restore(shape, s) {
    if (s.version !== 1) throw new Error('不支持的恢复记录版本');
    if (s.kind === 'text') { if (tableOf(shape)) throw new Error('对象类型已变化'); restoreText(shape, s.text); }
    else {
      var table = tableOf(shape);
      if (!table || Number(table.Rows.Count) !== s.rows || Number(table.Columns.Count) !== s.cols) throw new Error('表格结构已变化，不能自动恢复');
      s.cells.forEach(function (row, r) { row.forEach(function (cell, c) { restoreText(table.Cell(r + 1, c + 1).Shape, cell); }); });
      s.widths.forEach(function (w, c) { table.Columns.Item(c + 1).Width = w; });
      s.heights.forEach(function (h, r) { table.Rows.Item(r + 1).Height = h; });
    }
    if (s.geometry.LockAspectRatio !== undefined) shape.LockAspectRatio = 0;
    Object.keys(s.geometry).filter(function (k) { return k !== 'LockAspectRatio'; }).forEach(function (k) { shape[k] = s.geometry[k]; });
    if (s.geometry.LockAspectRatio !== undefined) shape.LockAspectRatio = s.geometry.LockAspectRatio;
    if (!equal(capture(shape), s)) throw new Error('恢复后的内容或格式与记录不一致，请在修改历史中检查');
  }
  function content(s) { if (!s) return '尚未记录'; if (s.kind === 'text') return s.text.text; return s.cells.map(function (row) { return row.map(function (c) { return c.text; }).join(' | '); }).join('\n'); }
  global.RAChangeState = { capture: capture, restore: restore, apply: apply, preflight: preflight, equal: equal, content: content, clone: clone };
})(typeof window !== 'undefined' ? window : globalThis);
