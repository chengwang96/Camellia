(function (key) {
  'use strict';
  if (window[key]) return;
  var body = document.body;
  if (!body) return;
  var root = document.documentElement, rootOriginal = {}, rootProperties = ['width', 'height', 'min-height', 'overflow'];
  rootProperties.forEach(function (name) { rootOriginal[name] = [root.style.getPropertyValue(name), root.style.getPropertyPriority(name)]; });
  var original = {}, properties = ['width', 'height', 'min-height', 'transform', 'transform-origin'];
  properties.forEach(function (name) { original[name] = [body.style.getPropertyValue(name), body.style.getPropertyPriority(name)]; });
  var computed = getComputedStyle(body);
  var baseZoom = parseFloat(computed.zoom) || 1;
  var baseTransform = computed.transform === 'none' ? '' : computed.transform;
  var margins = ['marginLeft', 'marginRight', 'marginTop', 'marginBottom'].map(function (name) { return parseFloat(computed[name]) || 0; });
  var extras = computed.boxSizing === 'border-box' ? [0, 0] : [
    ['paddingLeft','paddingRight','borderLeftWidth','borderRightWidth'].reduce(function (sum, name) { return sum + (parseFloat(computed[name]) || 0); }, 0),
    ['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'].reduce(function (sum, name) { return sum + (parseFloat(computed[name]) || 0); }, 0)
  ];
  var config = null, result = null, frame = 0, disposed = false, applied = false;
  var resize, mutations;
  function finite(value, fallback) { return typeof value === 'number' && isFinite(value) && value > 0 ? value : fallback; }
  function style(name, value, element) {
    element = element || body;
    if (element.style.getPropertyValue(name) !== value || element.style.getPropertyPriority(name) !== 'important') element.style.setProperty(name, value, 'important');
  }
  function measure() {
    if (disposed || !config || !body.isConnected) return result;
    var old = result, x = window.scrollX, y = window.scrollY;
    if (config.mode === 'width') {
      if (applied) { restore(); applied = false; }
      var naturalWidth = Math.max(body.offsetWidth, body.scrollWidth, 1) * baseZoom;
      var naturalHeight = Math.max(body.offsetHeight, body.scrollHeight, 1) * baseZoom;
      if (naturalWidth + (margins[0] + margins[1]) * baseZoom <= config.width + 1) {
        result = {mode:'width',scale:1,width:config.width,height:config.height,contentWidth:naturalWidth,contentHeight:naturalHeight,offsetX:0,offsetY:0};
        return result;
      }
    }
    applied = true;
    style('width', config.width + 'px', root);
    style('height', config.height + 'px', root);
    style('min-height', config.height + 'px', root);
    if (config.mode === 'page') style('overflow', 'hidden', root);
    else if (rootOriginal.overflow[0]) root.style.setProperty('overflow', rootOriginal.overflow[0], rootOriginal.overflow[1]);
    else root.style.removeProperty('overflow');
    var logicalWidth = Math.max(1, config.width / baseZoom - margins[0] - margins[1] - extras[0]);
    // Only the host's page dimensions change. No card nodes, inputs, canvases,
    // embedded frames, event handlers or interaction state are replaced.
    style('width', logicalWidth + 'px');
    style('min-height', Math.max(1, config.height / baseZoom - margins[2] - margins[3] - extras[1]) + 'px');
    // A finite logical viewport lets transformed overflow contribute only its
    // visible extent, rather than leaving the original tall page as blank scroll.
    style('height', Math.max(1, config.height / baseZoom - margins[2] - margins[3] - extras[1]) + 'px');
    var width = Math.max(body.offsetWidth, body.scrollWidth, 1);
    var height = Math.max(body.offsetHeight, body.scrollHeight, 1);
    var contentWidth = Math.max(1, width * baseZoom);
    var contentHeight = Math.max(1, height * baseZoom);
    var availableWidth = Math.max(1, config.width - (margins[0] + margins[1]) * baseZoom);
    var availableHeight = Math.max(1, config.height - (margins[2] + margins[3]) * baseZoom);
    var scale = config.mode === 'page' ? Math.min(1, availableWidth / contentWidth, availableHeight / contentHeight)
      : config.mode === 'width' ? Math.min(1, availableWidth / contentWidth) : config.scale;
    scale = Math.max(.0001, Math.min(3, finite(scale, 1)));
    var offsetX = Math.max(0, (availableWidth - contentWidth * scale) / 2);
    var offsetY = config.mode === 'page' ? Math.max(0, (availableHeight - contentHeight * scale) / 2) : 0;
    // CSS transforms have consistent painted bounds and pointer coordinates in
    // older Android WebViews too; CSS zoom changed those semantics in Chromium 128.
    style('transform-origin', '0 0');
    var transform = 'translate(' + offsetX / baseZoom + 'px,' + offsetY / baseZoom + 'px) scale(' + scale + ')' + (baseTransform ? ' ' + baseTransform : '');
    style('transform', scale === 1 && offsetX === 0 && offsetY === 0 && !baseTransform ? 'none' : transform);
    result = {mode:config.mode, scale:scale, width:config.width, height:config.height, contentWidth:contentWidth, contentHeight:contentHeight, offsetX:offsetX, offsetY:offsetY};
    var active = document.activeElement;
    var editing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    if (config.mode === 'page') window.scrollTo(0, 0);
    else if (old && !editing && (old.scale !== scale || old.offsetX !== offsetX || old.offsetY !== offsetY)) {
      window.scrollTo(Math.max(0, (x - old.offsetX) / old.scale * scale + offsetX), Math.max(0, (y - old.offsetY) / old.scale * scale + offsetY));
    }
    return result;
  }
  function schedule() {
    if (disposed || frame || !config) return;
    frame = requestAnimationFrame(function () { frame = 0; measure(); });
  }
  function restore() {
    properties.forEach(function (name) { if (original[name][0]) body.style.setProperty(name, original[name][0], original[name][1]); else body.style.removeProperty(name); });
    rootProperties.forEach(function (name) { if (rootOriginal[name][0]) root.style.setProperty(name, rootOriginal[name][0], rootOriginal[name][1]); else root.style.removeProperty(name); });
  }
  var controller = {
    update: function (width, height, mode, scale) {
      var next = {width:finite(width, innerWidth), height:finite(height, innerHeight), mode:['width','page','custom'].indexOf(mode) >= 0 ? mode : 'width', scale:Math.max(.05, Math.min(3, finite(scale, 1)))};
      if (config && result && config.width === next.width && config.height === next.height && config.mode === next.mode && config.scale === next.scale) return result;
      config = next; return measure();
    },
    state: function () { return result; },
    destroy: function () {
      disposed = true; if (frame) cancelAnimationFrame(frame);
      if (resize) resize.disconnect(); if (mutations) mutations.disconnect();
      window.removeEventListener('load', schedule); document.removeEventListener('load', schedule, true);
      if (applied) restore();
      if (window[key] === controller) delete window[key];
    }
  };
  window[key] = controller;
  if (window.ResizeObserver) {
    resize = new ResizeObserver(schedule); resize.observe(body);
    for (var child = body.firstElementChild; child; child = child.nextElementSibling) resize.observe(child);
  }
  mutations = new MutationObserver(function (records) {
    if (records.some(function (record) { return record.type !== 'attributes' || record.target !== body || record.attributeName !== 'style'; })) schedule();
  });
  mutations.observe(body, {childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['class','style','hidden','open','width','height']});
  window.addEventListener('load', schedule); document.addEventListener('load', schedule, true);
})
