'use strict';
window.SettingsCharts = (() => {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const format = value => new Intl.NumberFormat(window.CamelliaI18n.locale, { maximumFractionDigits: 2, notation: Math.abs(value) >= 10000 ? 'compact' : 'standard' }).format(value);
  function line(points, { label, unit = '', percent = false, width = 780 } = {}) {
    const rows = points.filter(p => p.value !== null && Number.isFinite(p.value) && Number.isFinite(Date.parse(p.at))).sort((a,b) => Date.parse(a.at) - Date.parse(b.at));
    if (!rows.length) return "<div class=\"chart-empty\" data-i18n>No observations yet. Use the app or refresh a balance to start recording.</div>";
    const chartWidth = Math.max(240, Math.round(width));
    const left = 68, right = chartWidth - 18, top = 18, bottom = 206;
    const minX = Date.parse(rows[0].at), maxX = Date.parse(rows.at(-1).at);
    const minY = Math.min(0, ...rows.map(r => r.value)), maxY = Math.max(percent ? 100 : 1, ...rows.map(r => r.value));
    const x = at => maxX === minX ? (left + right) / 2 : left + (Date.parse(at) - minX) / (maxX - minX) * (right - left);
    const y = value => bottom - (value - minY) / (maxY - minY) * (bottom - top);
    const coords = rows.map(r => `${x(r.at).toFixed(2)},${y(r.value).toFixed(2)}`).join(' ');
    const grid = [0, .5, 1].map(r => { const value = minY + r * (maxY - minY), pos = y(value); return `<line x1="${left}" x2="${right}" y1="${pos}" y2="${pos}" class="chart-grid"/><text x="${left-9}" y="${pos+4}" text-anchor="end" class="chart-label">${format(value)}${percent ? '%' : ''}</text>`; }).join('');
    const dots = rows.map(r => `<circle cx="${x(r.at)}" cy="${y(r.value)}" r="${rows.length === 1 ? 5 : 3}" tabindex="0" class="chart-dot"><title>${escape(new Date(r.at).toLocaleString())} · ${escape(format(r.value) + unit)}</title></circle>`).join('');
    const sameDay = new Date(minX).toDateString() === new Date(maxX).toDateString();
    const date = at => new Date(at).toLocaleString(window.CamelliaI18n.locale, sameDay && rows.length > 1 ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' });
    const axis = rows.length === 1 ? `<text x="${x(rows[0].at)}" y="235" text-anchor="middle" class="chart-label">${date(rows[0].at)}</text>` : `<text x="${left}" y="235" class="chart-label">${date(rows[0].at)}</text><text x="${right}" y="235" text-anchor="end" class="chart-label">${date(rows.at(-1).at)}</text>`;
    return `<svg class="line-chart" viewBox="0 0 ${chartWidth} 248" width="${chartWidth}" height="248" role="img" aria-label="${escape(label)}">${grid}${rows.length > 1 ? `<polyline points="${coords}" fill="none" class="chart-line"/>` : ''}${dots}${axis}</svg>${rows.length === 1 ? "<p class=\"hint\" data-i18n>One observation recorded. More observations will form a trend.</p>" : ''}`;
  }
  return { line };
})();
