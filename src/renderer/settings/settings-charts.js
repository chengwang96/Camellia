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
    const dots = rows.map(row => {
      const value = new Intl.NumberFormat(window.CamelliaI18n.locale, { maximumFractionDigits: 8 }).format(row.value) + unit;
      const date = new Date(row.at).toLocaleString(window.CamelliaI18n.locale);
      return `<circle cx="${x(row.at)}" cy="${y(row.value)}" r="${rows.length === 1 ? 5 : 3}" tabindex="0" class="chart-dot" data-value="${escape(value)}" data-date="${escape(date)}" aria-label="${escape(date + ' · ' + value)}"/>`;
    }).join('');
    const sameDay = new Date(minX).toDateString() === new Date(maxX).toDateString();
    const date = at => new Date(at).toLocaleString(window.CamelliaI18n.locale, sameDay && rows.length > 1 ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' });
    const axis = rows.length === 1 ? `<text x="${x(rows[0].at)}" y="235" text-anchor="middle" class="chart-label">${date(rows[0].at)}</text>` : `<text x="${left}" y="235" class="chart-label">${date(rows[0].at)}</text><text x="${right}" y="235" text-anchor="end" class="chart-label">${date(rows.at(-1).at)}</text>`;
    return `<svg class="line-chart" viewBox="0 0 ${chartWidth} 248" width="${chartWidth}" height="248" role="img" aria-label="${escape(label)}">${grid}${rows.length > 1 ? `<polyline points="${coords}" fill="none" class="chart-line"/>` : ''}${dots}${axis}</svg>${rows.length === 1 ? "<p class=\"hint\" data-i18n>One observation recorded. More observations will form a trend.</p>" : ''}`;
  }
  function bindHover(container) {
    const chart = container.querySelector('.line-chart');
    if (!chart) return;
    const dots = [...chart.querySelectorAll('.chart-dot')];
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    const value = document.createElement('strong'), date = document.createElement('small');
    tooltip.append(value, date);
    container.append(tooltip);
    const namespace = 'http://www.w3.org/2000/svg';
    const overlay = document.createElementNS(namespace, 'g');
    overlay.classList.add('chart-hover');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('visibility', 'hidden');
    const vertical = document.createElementNS(namespace, 'line');
    const horizontal = document.createElementNS(namespace, 'line');
    for (const guide of [vertical, horizontal]) guide.classList.add('chart-crosshair');
    const marker = document.createElementNS(namespace, 'circle');
    marker.classList.add('chart-hover-dot');
    marker.setAttribute('r', '5');
    overlay.append(vertical, horizontal, marker);
    chart.append(overlay);
    function hide() { tooltip.hidden = true; overlay.setAttribute('visibility', 'hidden'); }
    function show(dot) {
      const coordX = dot.cx.baseVal.value, coordY = dot.cy.baseVal.value;
      vertical.setAttribute('x1', coordX); vertical.setAttribute('x2', coordX);
      vertical.setAttribute('y1', '18'); vertical.setAttribute('y2', '206');
      horizontal.setAttribute('x1', '68'); horizontal.setAttribute('x2', chart.viewBox.baseVal.width - 18);
      horizontal.setAttribute('y1', coordY); horizontal.setAttribute('y2', coordY);
      marker.setAttribute('cx', coordX); marker.setAttribute('cy', coordY);
      value.textContent = dot.dataset.value; date.textContent = dot.dataset.date;
      tooltip.hidden = false; overlay.setAttribute('visibility', 'visible');
      const bounds = container.getBoundingClientRect();
      const position = new DOMPoint(coordX, coordY).matrixTransform(chart.getScreenCTM());
      const left = Math.min(Math.max(0, position.x - bounds.left + 12), Math.max(0, container.clientWidth - tooltip.offsetWidth));
      const top = Math.min(Math.max(0, position.y - bounds.top - tooltip.offsetHeight - 12), Math.max(0, chart.getBoundingClientRect().height - tooltip.offsetHeight));
      tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
    }
    chart.addEventListener('pointermove', event => {
      const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(chart.getScreenCTM().inverse());
      if (position.x < 68 || position.x > chart.viewBox.baseVal.width - 18 || position.y < 18 || position.y > 206) { hide(); return; }
      const nearest = dots.reduce((best, dot) => Math.abs(dot.cx.baseVal.value - position.x) < Math.abs(best.cx.baseVal.value - position.x) ? dot : best);
      show(nearest);
    });
    chart.addEventListener('pointerleave', hide);
    chart.addEventListener('focusin', event => { if (event.target.classList.contains('chart-dot')) show(event.target); });
    chart.addEventListener('focusout', hide);
    chart.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  }
  return { line, bindHover };
})();
