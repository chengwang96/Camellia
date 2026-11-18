'use strict';

(() => {
  const STYLES = new Set(['whale', 'editorial', 'paper', 'sketch', 'terminal']);
  const MAX_STATE_BYTES = 64 * 1024;
  const MAX_ACTION_BYTES = 1400;
  const MAX_FILL_CHARS = 2000;
  let mountedCards = 0;
  let removalObserver = null;
  function watchCardRemoval() {
    mountedCards++;
    if (removalObserver) return;
    // Observe removals rather than retaining a registry of card DOM nodes.
    // A synchronous layout move leaves the node connected by delivery time.
    removalObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node.nodeType !== 1 || node.isConnected) continue;
        node.disposeVisualize?.();
        for (const card of node.querySelectorAll('.visualize-block')) card.disposeVisualize?.();
      }
    });
    removalObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  function contentSecurityPolicy(origins = []) {
    const network = origins.length ? ' ' + origins.join(' ') : '';
    return [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      'img-src data: blob:' + network,
      'media-src data: blob:' + network,
      'font-src data:',
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
    ].join('; ');
  }
  const THEME_CSS = [
    ':root{--viz-bg:#ffffff;--viz-fg:#1c2430;--viz-muted:#5c6678;--viz-border:#d8dee8;--viz-accent:#3f6fd8;--viz-good:#1d8a58;--viz-warn:#a66a00;--viz-font:"Segoe UI","Microsoft YaHei",sans-serif;color-scheme:light;}',
    ':root[data-theme=dark]{--viz-bg:#171b24;--viz-fg:#e7ebf5;--viz-muted:#9eabc4;--viz-border:#2c3650;--viz-accent:#6f9cff;--viz-good:#8ad9ae;--viz-warn:#ffd27a;color-scheme:dark;}',
    '.viz-theme{min-height:100%;padding:16px;border-radius:12px;background:var(--viz-bg);color:var(--viz-fg);font-family:var(--viz-font);box-sizing:border-box;}',
    '.viz-theme > *{background-color:transparent !important;}',
    '.viz-theme *{box-sizing:border-box;}',
    '.viz-theme h1,.viz-theme h2,.viz-theme h3{color:var(--viz-fg);letter-spacing:-.02em;margin:.2em 0 .5em;}',
    '.viz-theme p{color:var(--viz-muted);line-height:1.55;}',
    '.viz-theme table{width:100%;border-collapse:collapse;font-size:12px;}',
    '.viz-theme th{color:var(--viz-muted);text-align:left;border-bottom:1px solid var(--viz-border);padding:8px;}',
    '.viz-theme td{border-bottom:1px solid color-mix(in srgb,var(--viz-border) 65%,transparent);padding:8px;}',
    '.viz-theme button,.viz-theme input,.viz-theme select,.viz-theme textarea{font:inherit;}',
    '.viz-theme button,.viz-theme select{min-height:36px;max-width:100%;border:1px solid var(--viz-border);border-radius:9px;background-color:color-mix(in srgb,var(--viz-fg) 3%,var(--viz-bg));color:var(--viz-fg);line-height:1.4;transition:background-color .14s ease,border-color .14s ease,color .14s ease;}',
    '.viz-theme button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 12px;appearance:none;vertical-align:middle;}',
    '.viz-theme button:not(:disabled):hover,.viz-theme select:not(:disabled):hover{background-color:color-mix(in srgb,var(--viz-fg) 6%,var(--viz-bg));border-color:color-mix(in srgb,var(--viz-fg) 25%,var(--viz-border));}',
    '.viz-theme button:not(:disabled):active{background-color:color-mix(in srgb,var(--viz-fg) 10%,var(--viz-bg));}',
    '.viz-theme button.btn-primary,.viz-theme button[aria-pressed="true"]{background-color:var(--viz-accent);border-color:var(--viz-accent);color:var(--viz-bg);}',
    '.viz-theme button.btn-primary:not(:disabled):hover,.viz-theme button[aria-pressed="true"]:not(:disabled):hover{background-color:color-mix(in srgb,var(--viz-accent) 88%,var(--viz-fg));border-color:var(--viz-accent);}',
    '.viz-theme button.btn-ghost{background-color:transparent;border-color:transparent;}',
    '.viz-theme button.btn-ghost:not(:disabled):hover{background-color:color-mix(in srgb,var(--viz-fg) 6%,var(--viz-bg));border-color:transparent;}',
    '.viz-theme select{min-width:0;padding:7px 12px;vertical-align:middle;}',
    '.viz-theme label:has(> select){display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%;}',
    '.viz-theme label > select{flex:1 1 0%;}',
    '.viz-theme select:not([multiple]):not([size]),.viz-theme select:not([multiple])[size="1"]{appearance:none;padding-right:34px;background-image:linear-gradient(45deg,transparent 42%,var(--viz-muted) 43%,var(--viz-muted) 57%,transparent 58%),linear-gradient(135deg,transparent 42%,var(--viz-muted) 43%,var(--viz-muted) 57%,transparent 58%);background-position:calc(100% - 18px) center,calc(100% - 12px) center;background-size:6px 6px;background-repeat:no-repeat;}',
    '.viz-theme select option,.viz-theme select optgroup{background:var(--viz-bg);color:var(--viz-fg);}',
    '.viz-theme button:focus-visible,.viz-theme select:focus-visible{outline:2px solid var(--viz-accent);outline-offset:2px;}',
    '.viz-theme button:disabled,.viz-theme select:disabled{opacity:.48;cursor:not-allowed;}',
    '@media(pointer:coarse){.viz-theme button,.viz-theme select{min-height:44px;}}',
    '@media(prefers-reduced-motion:reduce){.viz-theme button,.viz-theme select{transition:none;}}',
    '.viz-theme img{max-width:100%;height:auto;border-radius:8px;}',
    '.viz-theme code,.viz-theme pre{font-family:Consolas,"SFMono-Regular",monospace;}',
    '.viz-theme .viz-error{color:#ff9d9d;}',
    '.viz-paper,.viz-editorial,.viz-sketch{color-scheme:light;}',
    '.viz-terminal{color-scheme:dark;}',
    '.viz-paper{--viz-bg:#ffffff !important;--viz-fg:#1c2430 !important;--viz-muted:#5c6678 !important;--viz-border:#d8dee8 !important;--viz-accent:#3f6fd8 !important;--viz-good:#1d8a58 !important;--viz-warn:#a66a00 !important;--viz-font:Georgia,"Times New Roman",serif !important;}',
    '.viz-editorial{--viz-bg:#fbf7ef !important;--viz-fg:#221f1a !important;--viz-muted:#766b5d !important;--viz-border:#ded3c2 !important;--viz-accent:#b4532a !important;--viz-good:#2d7a54 !important;--viz-warn:#9a6500 !important;--viz-font:Georgia,"Times New Roman",serif !important;}',
    '.viz-sketch{--viz-bg:#fffdf4 !important;--viz-fg:#24221d !important;--viz-muted:#6e6659 !important;--viz-border:#cfc4a9 !important;--viz-accent:#2f6f8f !important;--viz-good:#387b4a !important;--viz-warn:#a66a00 !important;--viz-font:"Segoe Print","Comic Sans MS",cursive !important;border:2px solid var(--viz-border);box-shadow:3px 4px 0 rgba(36,34,29,.12);}',
    '.viz-terminal{--viz-bg:#07110c !important;--viz-fg:#b7f7c8 !important;--viz-muted:#75a888 !important;--viz-border:#245238 !important;--viz-accent:#50e38d !important;--viz-good:#50e38d !important;--viz-warn:#f2c14e !important;--viz-font:Consolas,"SFMono-Regular",monospace !important;border-radius:4px;}',
  ].join('');

  function parseValue(value, depth = 0) {
    if (depth > 6 || value == null) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed.startsWith('{')) return null;
      try { return parseValue(JSON.parse(trimmed), depth + 1); }
      catch { return null; }
    }
    if (typeof value !== 'object') return null;
    if (value.ok !== false && value.visualize) {
      const card = value.visualize;
      return card && typeof card.cardId === 'string' && card.cardId && typeof card.title === 'string'
        ? card : null;
    }
    if (typeof value.output === 'string') {
      const card = parseValue(value.output, depth + 1);
      if (card) return card;
    }
    if (Array.isArray(value.content)) {
      for (const item of value.content) {
        const card = parseValue(item?.text ?? item?.structuredContent ?? item, depth + 1);
        if (card) return card;
      }
    }
    if (value.structuredContent) return parseValue(value.structuredContent, depth + 1);
    return null;
  }

  function parse(text) {
    return parseValue(text);
  }

  function resolvedTheme() {
    const value = document.documentElement.dataset.theme;
    if (value === 'light' || value === 'dark') return value;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function byteLength(value) {
    const text = String(value ?? '');
    try { return new TextEncoder().encode(text).length; }
    catch { return text.length * 2; }
  }

  function normalizeState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    let encoded;
    try { encoded = JSON.stringify(value); }
    catch { return null; }
    if (typeof encoded !== 'string' || byteLength(encoded) > MAX_STATE_BYTES) return null;
    try { return JSON.parse(encoded); }
    catch { return null; }
  }

  function normalizeAction(value) {
    if (!value || typeof value !== 'object') return null;
    const type = String(value.type || '').trim().slice(0, 80);
    const label = String(value.label || type).trim().slice(0, 200);
    const payload = value.payload === undefined ? null : value.payload;
    let encoded;
    try { encoded = JSON.stringify(payload); }
    catch { return null; }
    if (!type || !label || typeof encoded !== 'string' || byteLength(encoded) > MAX_ACTION_BYTES)
      return null;
    try { return { type, label, payload: JSON.parse(encoded) }; }
    catch { return null; }
  }

  function scriptJson(value) {
    return JSON.stringify(value ?? null)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function tr(value) {
    return window.CamelliaI18n?.t?.(value) || value;
  }

  function bridgeDocumentScript(card, state) {
    return '<script>(function(){' +
      'var cardId=' + scriptJson(String(card.cardId)) + ';' +
      'var stateValue=' + scriptJson(normalizeState(state) || {}) + ';' +
      'var networkOrigins=' + scriptJson(Array.isArray(card.networkOrigins) ? card.networkOrigins : []) + ';' +
      'var networkAllowed=' + (card.networkApproved === true ? 'true' : 'false') + ';' +
      'var networkRequests={},networkSequence=0;' +
      'var activated=false,dataCache=null,presenting=false,dismissPresentationClick=false;' +
      'var MAX_STATE_BYTES=' + MAX_STATE_BYTES + ',MAX_ACTION_BYTES=' + MAX_ACTION_BYTES + ';' +
      'function byteLength(text){try{return new TextEncoder().encode(String(text)).length;}catch(_){return String(text).length*2;}}' +
      'function clone(value){try{return JSON.parse(JSON.stringify(value));}catch(_){return null;}}' +
      'function normalizeState(value){if(!value||typeof value!=="object"||Array.isArray(value))return null;var encoded;try{encoded=JSON.stringify(value);}catch(_){return null;}if(typeof encoded!=="string"||byteLength(encoded)>MAX_STATE_BYTES)return null;return JSON.parse(encoded);}' +
      'function post(message){try{parent.postMessage(Object.assign({cardId:cardId},message),"*");}catch(_){}}' +
      'function height(){var body=document.body;var h=Math.max(body?body.scrollHeight:0,body?Math.ceil(body.getBoundingClientRect().height):0,140);post({type:"camellia-visualize-height",height:Math.min(1400,h)});}' +
      'function width(){if(presenting)return;var root=document.querySelector(".viz-theme");if(!root)return;' +
      'var style=getComputedStyle(root);var outer=(parseFloat(style.paddingLeft)||0)+(parseFloat(style.paddingRight)||0)+(parseFloat(style.borderLeftWidth)||0)+(parseFloat(style.borderRightWidth)||0);' +
      'var children=Array.from(root.children).filter(function(el){return !/^(SCRIPT|STYLE|LINK|META)$/.test(el.tagName);});var content=0;' +
      'for(var index=0;index<children.length;index++)content=Math.max(content,children[index].getBoundingClientRect().width);' +
      'if(content>0)post({type:"camellia-visualize-width",width:Math.ceil(Math.min(1600,Math.max(240,content+outer)))});}' +
      'function size(){height();width();}' +
      'function setPresenting(active){presenting=active===true;if(presenting)document.documentElement.setAttribute("data-viz-presenting","1");else{dismissPresentationClick=false;document.documentElement.removeAttribute("data-viz-presenting");document.querySelectorAll("video,audio").forEach(function(media){try{media.pause();}catch(_){}});}window.dispatchEvent(new CustomEvent("camellia:presentation",{detail:{active:presenting}}));setTimeout(size,0);}' +
      'function setExpanded(active){if(active===true)document.documentElement.setAttribute("data-viz-expanded","1");else document.documentElement.removeAttribute("data-viz-expanded");window.dispatchEvent(new CustomEvent("camellia:expand",{detail:{active:active===true}}));setTimeout(size,0);}' +
      'function scanData(){if(dataCache)return dataCache;dataCache={};var scripts=document.querySelectorAll("script[data-viz-name]");' +
      'for(var index=0;index<scripts.length;index++){if(scripts[index].type!=="application/json")continue;var name=scripts[index].getAttribute("data-viz-name");if(!name)continue;try{dataCache[name]=JSON.parse(scripts[index].textContent||"null");}catch(_){dataCache[name]=null;}}return dataCache;}' +
      'function networkFetch(url,options){return new Promise(function(resolve,reject){' +
      'if(!networkAllowed)return reject(new Error("Network access has not been approved for this card"));' +
      'var target;try{target=new URL(String(url));}catch(_){return reject(new Error("Invalid network URL"));}' +
      'if(target.protocol!=="https:"||networkOrigins.indexOf(target.origin)<0)return reject(new Error("Network origin is not allowed"));' +
      'var method=String(options&&options.method||"GET").toUpperCase();if(method!=="GET"&&method!=="HEAD")return reject(new Error("Only GET and HEAD network requests are allowed"));' +
      'var requestId=cardId+":"+(++networkSequence)+":"+Date.now();networkRequests[requestId]={resolve:resolve,reject:reject};' +
      'post({type:"camellia-visualize-network-request",requestId:requestId,url:target.href,method:method});' +
      'setTimeout(function(){if(networkRequests[requestId]){delete networkRequests[requestId];reject(new Error("Network request timed out"));}},12000);});}' +
      'function activate(){activated=true;}' +
      'document.addEventListener("pointerdown",activate,true);document.addEventListener("keydown",activate,true);' +
      'document.addEventListener("contextmenu",function(event){if(!presenting)return;dismissPresentationClick=true;event.preventDefault();post({type:"camellia-visualize-present-menu",x:event.clientX,y:event.clientY});},true);' +
      'var slideInteractive="button,a,area,input,select,textarea,label,summary,video,audio,iframe,object,embed,[contenteditable]:not([contenteditable=false]),[tabindex]:not([tabindex=\\\"-1\\\"]),[role=button],[role=link],[role=slider],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=combobox],[role=textbox],[data-viz-interactive]";' +
      'document.addEventListener("click",function(event){if(!presenting||document.documentElement.getAttribute("data-viz-presentation")!=="slides"||!window.camelliaVisualize.presentation.clickToAdvance)return;' +
      'if(dismissPresentationClick){dismissPresentationClick=false;return;}if(event.defaultPrevented||event.button!==0||event.detail>1||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||event.target.closest(slideInteractive))return;' +
      'var selection=window.getSelection();if(selection&&!selection.isCollapsed)return;window.dispatchEvent(new CustomEvent("camellia:presentation-command",{detail:{command:"next"}}));});' +
      'document.addEventListener("pointerdown",function(){if(presenting)post({type:"camellia-visualize-dismiss-menu"});},true);' +
      'document.addEventListener("keydown",function(event){if(presenting&&event.key==="Escape")post({type:"camellia-visualize-exit-present"});},true);' +
      'window.addEventListener("message",function(event){if(event.source!==parent||!event.data||event.data.cardId!==cardId)return;' +
      'if(event.data.type==="camellia-visualize-present"){setPresenting(event.data.active===true);return;}' +
      'if(event.data.type==="camellia-visualize-expand"){setExpanded(event.data.active===true);return;}' +
      'if(event.data.type==="camellia-visualize-present-command"){dismissPresentationClick=false;if(presenting&&["previous","next"].indexOf(event.data.command)>=0)window.dispatchEvent(new CustomEvent("camellia:presentation-command",{detail:{command:event.data.command}}));return;}' +
      'if(event.data.type==="camellia-visualize-network-response"){var pending=networkRequests[event.data.requestId];if(!pending)return;delete networkRequests[event.data.requestId];' +
      'if(event.data.ok===true)pending.resolve(String(event.data.text||""));else pending.reject(new Error(String(event.data.error||"Network request failed")));}});' +
      'window.camelliaVisualize={version:2,' +
      'presentation:{clickToAdvance:true},' +
      'state:{get:function(){return clone(stateValue);},' +
      'set:function(value){var next=normalizeState(value);if(!next)return false;stateValue=next;post({type:"camellia-visualize-state",state:next});return true;},' +
      'patch:function(value){if(!value||typeof value!=="object"||Array.isArray(value))return false;return window.camelliaVisualize.state.set(Object.assign({},stateValue,value));},' +
      'reset:function(){stateValue={};post({type:"camellia-visualize-state",state:{}});return true;}},' +
      'data:{get:function(name){var data=scanData();return Object.prototype.hasOwnProperty.call(data,name)?clone(data[name]):null;},' +
      'list:function(){return Object.keys(scanData());},has:function(name){return Object.prototype.hasOwnProperty.call(scanData(),name);}},' +
      'network:{allowed:networkAllowed,origins:networkOrigins.slice(),fetch:networkFetch,json:function(url,options){return networkFetch(url,options).then(function(text){return JSON.parse(text);});}},' +
      'fill:function(text){if(activated&&typeof text==="string"&&text.trim()&&text.length<=' + MAX_FILL_CHARS + ')post({type:"camellia-visualize-fill",text:text});},' +
      'action:function(input){if(!activated||!input||typeof input!=="object")return false;' +
      'var type=String(input.type||"").trim().slice(0,80);var label=String(input.label||type).trim().slice(0,200);' +
      'var payload=input.payload===undefined?null:input.payload;var encoded=JSON.stringify(payload);' +
      'if(!type||!label||typeof encoded!=="string"||byteLength(encoded)>MAX_ACTION_BYTES)return false;' +
      'post({type:"camellia-visualize-action",action:{type:type,label:label,payload:JSON.parse(encoded)}});return true;}};' +
      'window.__camelliaVisualizeBridge={ready:function(){dataCache=null;scanData();var slides=!!document.querySelector("[data-viz-presentation=slides]");if(slides)document.documentElement.setAttribute("data-viz-presentation","slides");post({type:"camellia-visualize-ready",slides:slides});size();if(window.ResizeObserver){new ResizeObserver(size).observe(document.documentElement);}window.addEventListener("load",size);window.addEventListener("resize",size);}};' +
      '})();</script>';
  }

  function frameDocument(card, fragment, theme = resolvedTheme(), state = {}) {
    const style = STYLES.has(card.style) ? card.style : 'whale';
    const csp = contentSecurityPolicy(card.networkApproved === true && Array.isArray(card.networkOrigins)
      ? card.networkOrigins : []);
    return '<!doctype html><html data-theme="' + (theme === 'dark' ? 'dark' : 'light') + '"><head><meta charset="utf-8">' +
      '<title>' + escapeHtml(card.title || 'Camellia visualization') + '</title>' +
      '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
      '<meta name="color-scheme" content="light dark">' +
      '<style>html,body{margin:0;background:var(--viz-bg);color:var(--viz-fg);' +
      'font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;scrollbar-width:none;-ms-overflow-style:none;}' +
      '*{box-sizing:border-box}body{overflow:auto;padding:0;}button,input,select,textarea{font:inherit;}' +
      'body::-webkit-scrollbar{width:0;height:0;display:none}' + THEME_CSS + '</style>' +
      '<style>html[data-viz-presenting="1"] .viz-theme{min-height:100vh;padding:clamp(20px,3vw,48px);display:flex;flex-direction:column;align-items:center;}' +
      'html[data-viz-presenting="1"] .viz-theme > *:not(script):not(style):not(link):not(meta){width:100% !important;max-width:none !important;margin:auto;}' +
      'html[data-viz-presenting="1"][data-viz-presentation="slides"]{background:#000;}' +
      'html[data-viz-presenting="1"][data-viz-presentation="slides"] body{height:100vh;overflow:hidden;background:#000;}' +
      'html[data-viz-presenting="1"][data-viz-presentation="slides"] .viz-theme{height:100vh;min-height:0;padding:0;border:0;border-radius:0;background:#000;}' +
      '</style>' +
      bridgeDocumentScript(card, state) +
      '</head><body><div class="viz-theme viz-' + style + '">' + fragment +
      '</div><script>window.__camelliaVisualizeBridge&&window.__camelliaVisualizeBridge.ready();</script></body></html>';
  }

  function mount(card, { sessionId, engine = 'claude', onFill = () => {}, onAction = () => {}, onStatus = () => {} } = {}) {
    let currentCard = { ...card };
    let currentState = normalizeState(card.state) || {};
    let stateLoaded = card.state !== undefined;
    const block = document.createElement('section');
    block.className = 'visualize-block';
    block.dataset.visualizeCardId = String(card.cardId);
    block.dataset.visualizeStyle = STYLES.has(card.style) ? card.style : 'whale';
    block.innerHTML =
      '<div class="visualize-head">' +
      '  <div class="visualize-heading"><span class="visualize-mark" aria-hidden="true">◇</span>' +
      '    <div><div class="visualize-title"></div><div class="visualize-summary"></div></div></div>' +
      '  <div class="visualize-actions">' +
      '    <button type="button" class="visualize-network" hidden></button>' +
      '    <button type="button" class="visualize-present" aria-label="Present visualization" title="Present visualization" aria-pressed="false">Present</button>' +
      '    <button type="button" class="visualize-expand" aria-label="Expand visualization" title="Expand visualization">Expand</button>' +
      '    <details class="visualize-more"><summary aria-label="More card actions" title="More card actions">•••</summary>' +
      '      <div class="visualize-menu" role="menu">' +
      '        <button type="button" data-card-action="copy" role="menuitem">Copy snapshot</button>' +
      '        <button type="button" data-card-action="export" role="menuitem">Export HTML</button>' +
      '        <button type="button" data-card-action="reset" role="menuitem">Reset state</button>' +
      '      </div></details>' +
      '  </div>' +
      '</div>' +
      '<div class="visualize-action-tray" hidden aria-live="polite">' +
      '  <div class="visualize-action-copy"><span>Card action</span><strong></strong><code></code></div>' +
      '  <div class="visualize-action-buttons"><button type="button" class="visualize-action-use">Continue in chat</button><button type="button" class="visualize-action-dismiss" aria-label="Dismiss card action">×</button></div>' +
      '</div>' +
      '<div class="visualize-frame-wrap"><div class="visualize-loading" data-i18n>Loading visualization…</div></div>';
    block.querySelector('.visualize-title').textContent = card.title;
    block.querySelector('.visualize-summary').textContent = card.summary || '';
    block.querySelector('.visualize-summary').hidden = !card.summary;

    const frameWrap = block.querySelector('.visualize-frame-wrap');
    const expand = block.querySelector('.visualize-expand');
    const present = block.querySelector('.visualize-present');
    const networkButton = block.querySelector('.visualize-network');
    const more = block.querySelector('.visualize-more');
    const menuSummary = more.querySelector('summary');
    const menuButtons = {
      copy: block.querySelector('[data-card-action="copy"]'),
      export: block.querySelector('[data-card-action="export"]'),
      reset: block.querySelector('[data-card-action="reset"]'),
    };
    const actionTray = block.querySelector('.visualize-action-tray');
    const actionLabel = actionTray.querySelector('strong');
    const actionCode = actionTray.querySelector('code');
    const actionKicker = actionTray.querySelector('.visualize-action-copy > span');
    const actionUse = actionTray.querySelector('.visualize-action-use');
    const actionDismiss = actionTray.querySelector('.visualize-action-dismiss');
    const presentMenu = document.createElement('div');
    presentMenu.className = 'visualize-present-menu';
    presentMenu.setAttribute('role', 'menu');
    presentMenu.hidden = true;
    presentMenu.innerHTML = '<button type="button" role="menuitem" data-present-command="previous"></button>' +
      '<button type="button" role="menuitem" data-present-command="next"></button>' +
      '<hr><button type="button" role="menuitem" data-present-command="exit"></button>';
    block.appendChild(presentMenu);
    const presentMenuButtons = Object.fromEntries([...presentMenu.querySelectorAll('button')]
      .map(button => [button.dataset.presentCommand, button]));
    let slideDeck = false;
    let currentAction = null;
    let expanded = false;
    const refreshNetworkButton = () => {
      const origins = Array.isArray(currentCard.networkOrigins) ? currentCard.networkOrigins : [];
      networkButton.hidden = !origins.length;
      if (!origins.length) return;
      const approved = currentCard.networkApproved === true;
      networkButton.textContent = tr(approved ? 'Network allowed' : 'Allow network');
      const label = tr(approved ? 'Revoke network access' : 'Allow network access');
      networkButton.setAttribute('aria-label', label);
      networkButton.setAttribute('aria-pressed', String(approved));
      networkButton.title = label + '\n' + origins.join('\n');
      networkButton.classList.toggle('is-on', approved);
    };
    const refreshCardLabels = () => {
      const active = document.fullscreenElement === block;
      present.textContent = tr(active ? 'Exit' : 'Present');
      const presentLabel = tr(active ? 'Exit presentation' : 'Present visualization');
      present.setAttribute('aria-label', presentLabel);
      present.title = presentLabel;
      expand.textContent = tr(expanded ? 'Collapse' : 'Expand');
      const expandLabel = tr(expanded ? 'Collapse visualization' : 'Expand visualization');
      expand.setAttribute('aria-label', expandLabel);
      expand.setAttribute('aria-expanded', String(expanded));
      expand.title = expandLabel;
      menuSummary.setAttribute('aria-label', tr('More card actions'));
      menuSummary.title = tr('More card actions');
      menuButtons.copy.textContent = tr('Copy snapshot');
      menuButtons.export.textContent = tr('Export HTML');
      menuButtons.reset.textContent = tr('Reset state');
      refreshNetworkButton();
      actionKicker.textContent = tr('Card action');
      actionUse.textContent = tr('Continue in chat');
      actionDismiss.setAttribute('aria-label', tr('Dismiss card action'));
      actionDismiss.title = tr('Dismiss card action');
      presentMenu.setAttribute('aria-label', tr('Presentation menu'));
      presentMenuButtons.previous.textContent = tr('Previous slide');
      presentMenuButtons.next.textContent = tr('Next slide');
      presentMenuButtons.exit.textContent = tr(slideDeck ? 'End slide show' : 'Exit presentation') + '  ·  Esc';
    };
    let contentHeight = 420;
    let frame = null;
    let currentHtml = '';
    let renderedDocument = '';
    let currentTheme = resolvedTheme();
    let disposed = false;
    let stateSaveTimer = null;
    let pendingState = null;
    let stateSaveChain = Promise.resolve();
    let stateResetting = false;
    const expandedHeight = () => Math.max(window.innerWidth < 700 ? 560 : 760, contentHeight);
    const applyFrameHeight = () => {
      if (!frame) return;
      frame.style.height = document.fullscreenElement === block ? '100%'
        : (expanded ? expandedHeight() : contentHeight) + 'px';
    };
    const postPresentState = () => {
      if (!frame) return;
      frame.contentWindow?.postMessage({
        cardId: currentCard.cardId,
        type: 'camellia-visualize-present',
        active: document.fullscreenElement === block,
      }, '*');
    };
    const postExpandState = () => {
      frame?.contentWindow?.postMessage({
        cardId: currentCard.cardId,
        type: 'camellia-visualize-expand',
        active: expanded,
      }, '*');
    };
    function hidePresentMenu(restoreFocus = false) {
      if (presentMenu.hidden) return;
      presentMenu.hidden = true;
      if (restoreFocus && document.fullscreenElement === block) frame?.focus();
    }
    async function exitPresentation() {
      hidePresentMenu();
      if (document.fullscreenElement !== block) return;
      try { await document.exitFullscreen(); }
      catch (error) { onStatus(tr(error.message || 'Could not exit presentation')); }
    }
    function showPresentMenu(x, y) {
      if (document.fullscreenElement !== block) return;
      presentMenuButtons.exit.textContent = tr(slideDeck ? 'End slide show' : 'Exit presentation') + '  ·  Esc';
      presentMenuButtons.previous.hidden = !slideDeck;
      presentMenuButtons.next.hidden = !slideDeck;
      presentMenu.querySelector('hr').hidden = !slideDeck;
      presentMenu.hidden = false;
      const width = presentMenu.offsetWidth, height = presentMenu.offsetHeight;
      const left = Number.isFinite(x) ? x : 8, top = Number.isFinite(y) ? y : 8;
      presentMenu.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, left)) + 'px';
      presentMenu.style.top = Math.max(8, Math.min(window.innerHeight - height - 8, top)) + 'px';
      Object.values(presentMenuButtons).find(button => !button.hidden)?.focus();
    }
    presentMenu.addEventListener('click', event => {
      const command = event.target.closest('[data-present-command]')?.dataset.presentCommand;
      if (!command) return;
      if (command === 'exit') { void exitPresentation(); return; }
      hidePresentMenu(true);
      if (document.fullscreenElement !== block || !slideDeck) return;
      frame?.contentWindow?.postMessage({ cardId: currentCard.cardId,
        type: 'camellia-visualize-present-command', command }, '*');
    });
    presentMenu.addEventListener('keydown', event => {
      const buttons = Object.values(presentMenuButtons).filter(button => !button.hidden);
      const index = buttons.indexOf(document.activeElement);
      let next;
      if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
      else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else if (event.key === 'Tab') { event.preventDefault(); hidePresentMenu(true); return; }
      else return;
      event.preventDefault(); buttons[next].focus();
    });
    block.addEventListener('contextmenu', event => {
      if (document.fullscreenElement !== block) return;
      event.preventDefault(); showPresentMenu(event.clientX, event.clientY);
    });
    const onPresentPointerDown = event => {
      if (!presentMenu.contains(event.target)) hidePresentMenu();
    };
    const onPresentKeyDown = event => {
      if (document.fullscreenElement === block && event.key === 'Escape') {
        event.preventDefault(); void exitPresentation();
      }
    };
    const dismissPresentMenu = () => hidePresentMenu();
    document.addEventListener('pointerdown', onPresentPointerDown, true);
    document.addEventListener('keydown', onPresentKeyDown, true);
    window.addEventListener('blur', dismissPresentMenu);
    window.addEventListener('resize', dismissPresentMenu);
    const hideAction = () => {
      currentAction = null;
      actionTray.hidden = true;
      actionUse.disabled = true;
    };
    const showAction = value => {
      currentAction = value;
      actionLabel.textContent = value.label || value.type;
      const payload = JSON.stringify(value.payload);
      const preview = value.type + (payload && payload !== 'null' ? ' · ' + payload : '');
      actionCode.textContent = preview.length > 260 ? preview.slice(0, 257) + '…' : preview;
      actionUse.disabled = false;
      actionTray.hidden = false;
    };
    refreshCardLabels();
    hideAction();
    expand.addEventListener('click', () => {
      expanded = !expanded;
      block.classList.toggle('is-expanded', expanded);
      refreshCardLabels();
      applyFrameHeight();
      postExpandState();
    });
    const syncPresent = () => {
      const active = document.fullscreenElement === block;
      const wasPresenting = present.getAttribute('aria-pressed') === 'true';
      hidePresentMenu();
      refreshCardLabels();
      present.setAttribute('aria-pressed', String(active));
      applyFrameHeight();
      postPresentState();
      if (active) frame?.focus();
      else if (wasPresenting) present.focus();
    };
    present.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement === block) await document.exitFullscreen();
        else if (block.requestFullscreen) await block.requestFullscreen();
        else {
          expanded = true;
          block.classList.add('is-expanded');
          refreshCardLabels();
          applyFrameHeight();
          postExpandState();
          onStatus(tr('Fullscreen is unavailable; the card was expanded instead.'));
        }
      } catch (error) {
        expanded = true;
        block.classList.add('is-expanded');
        refreshCardLabels();
        applyFrameHeight();
        postExpandState();
        onStatus(tr('Fullscreen is unavailable; the card was expanded instead.'));
      }
    });
    document.addEventListener('fullscreenchange', syncPresent);
    window.addEventListener('camellia:language', refreshCardLabels);
    networkButton.addEventListener('click', async () => {
      const origins = Array.isArray(currentCard.networkOrigins) ? currentCard.networkOrigins : [];
      if (!origins.length) return;
      const approved = currentCard.networkApproved === true;
      const prompt = tr(approved ? 'Revoke network access for this card?' : 'Allow network access for this card?');
      if (!window.confirm(prompt + '\n\n' + origins.join('\n'))) return;
      if (!window.dshDesktop.visualizeNetwork) {
        onStatus(tr('Card network controls are unavailable.'));
        return;
      }
      try {
        const result = await window.dshDesktop.visualizeNetwork({
          sessionId, cardId: currentCard.cardId, approved: !approved,
        });
        if (!result?.ok) throw new Error(result?.error || tr('Could not update network access'));
        currentCard = { ...currentCard, ...(result.card || {}), networkApproved: !approved };
        renderedDocument = '';
        renderDocument();
        refreshCardLabels();
        onStatus(tr(approved ? 'Network access revoked.' : 'Network access allowed.'));
      } catch (error) {
        onStatus(tr(error.message || 'Could not update network access'));
      }
    });

    function applyHeader(value) {
      block.dataset.visualizeStyle = STYLES.has(value.style) ? value.style : 'whale';
      block.dataset.visualizeMode = value.mode === 'wide' ? 'wide' : 'card';
      block.querySelector('.visualize-title').textContent = value.title;
      block.querySelector('.visualize-summary').textContent = value.summary || '';
      block.querySelector('.visualize-summary').hidden = !value.summary;
    }

    function renderDocument() {
      if (!frame || !currentHtml) return;
      const documentHtml = frameDocument(currentCard, currentHtml, currentTheme, currentState);
      if (documentHtml === renderedDocument) return;
      renderedDocument = documentHtml;
      hidePresentMenu();
      slideDeck = false;
      frame.srcdoc = documentHtml;
    }

    function stateRequest(payload) {
      const request = { sessionId, cardId: currentCard.cardId, ...payload };
      if (window.dshDesktop.visualizeState) return window.dshDesktop.visualizeState(request);
      return window.dshDesktop.conversationCommand({
        engine, action: 'visualize-state', payload: request,
      });
    }

    function flushStateSave() {
      if (stateSaveTimer) {
        clearTimeout(stateSaveTimer);
        stateSaveTimer = null;
      }
      if (!pendingState) return stateSaveChain;
      const value = pendingState;
      pendingState = null;
      stateSaveChain = stateSaveChain.then(async () => {
        const result = await stateRequest({ state: value });
        if (!result?.ok) throw new Error(result?.error || tr('Could not save card state'));
      }).catch(error => {
        if (!disposed) onStatus(tr('Could not save card state: {0}').replace('{0}', error.message || error));
      });
      return stateSaveChain;
    }

    function queueStateSave(value) {
      if (stateResetting) return;
      const next = normalizeState(value);
      if (!next) return;
      const encoded = JSON.stringify(next);
      if (pendingState && encoded === JSON.stringify(pendingState)) return;
      currentState = next;
      pendingState = next;
      if (stateSaveTimer) clearTimeout(stateSaveTimer);
      stateSaveTimer = setTimeout(flushStateSave, 180);
    }

    async function resetState() {
      if (!window.confirm(tr('Reset the saved interaction state for this card?'))) return;
      if (stateResetting) return;
      stateResetting = true;
      if (stateSaveTimer) {
        clearTimeout(stateSaveTimer);
        stateSaveTimer = null;
      }
      pendingState = null;
      currentState = {};
      try {
        await stateSaveChain;
        const result = await stateRequest({ state: null, clear: true });
        if (!result?.ok) throw new Error(result?.error || tr('Could not reset card state'));
        hideAction();
        renderedDocument = '';
        renderDocument();
        onStatus(tr('Card state reset.'));
      } catch (error) {
        onStatus(tr(error.message || 'Could not reset card state'));
      } finally {
        stateResetting = false;
      }
    }

    async function exportCard() {
      if (!currentHtml) return onStatus(tr('The visualization is still loading.'));
      if (!window.dshDesktop.visualizeExport) return onStatus(tr('Card export is unavailable.'));
      try {
        const result = await window.dshDesktop.visualizeExport({
          title: currentCard.title,
          cardId: currentCard.cardId,
          html: frameDocument(currentCard, currentHtml, resolvedTheme(), currentState),
        });
        if (result?.canceled) return;
        if (!result?.ok) throw new Error(result?.error || tr('Could not export visualization'));
        onStatus(tr('Visualization exported to {0}').replace('{0}', result.filePath));
      } catch (error) {
        onStatus(tr(error.message || 'Could not export visualization'));
      }
    }

    async function copyCard() {
      if (!currentHtml) return onStatus(tr('The visualization is still loading.'));
      if (!window.dshDesktop.visualizeCopy) return onStatus(tr('Card copy is unavailable.'));
      try {
        const result = await window.dshDesktop.visualizeCopy({
          title: currentCard.title,
          cardId: currentCard.cardId,
          html: frameDocument(currentCard, currentHtml, resolvedTheme(), currentState),
        });
        if (!result?.ok) throw new Error(result?.error || tr('Could not copy visualization'));
        onStatus(tr('Visualization snapshot copied.'));
      } catch (error) {
        onStatus(tr(error.message || 'Could not copy visualization'));
      }
    }

    block.querySelectorAll('[data-card-action]').forEach(button => {
      button.addEventListener('click', () => {
        more.open = false;
        if (button.dataset.cardAction === 'copy') void copyCard();
        if (button.dataset.cardAction === 'export') void exportCard();
        if (button.dataset.cardAction === 'reset') void resetState();
      });
    });
    more.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      more.open = false;
      more.querySelector('summary')?.focus();
    });
    const closeMoreOnOutsideClick = event => {
      if (more.open && !more.contains(event.target)) more.open = false;
    };
    document.addEventListener('pointerdown', closeMoreOnOutsideClick, true);
    actionUse.addEventListener('click', () => {
      if (!currentAction) return;
      const accepted = onAction({ ...currentAction, cardId: currentCard.cardId, title: currentCard.title });
      if (accepted !== false) hideAction();
    });
    actionDismiss.addEventListener('click', hideAction);

    async function handleNetworkRequest(data) {
      const requestId = String(data.requestId || '').slice(0, 160);
      const origins = Array.isArray(currentCard.networkOrigins) ? currentCard.networkOrigins : [];
      const reply = result => frame?.contentWindow?.postMessage({
        cardId: currentCard.cardId,
        type: 'camellia-visualize-network-response',
        requestId,
        ...result,
      }, '*');
      if (!requestId) return;
      try {
        if (currentCard.networkApproved !== true)
          throw new Error('Network access has not been approved for this card');
        const target = new URL(String(data.url || ''));
        if (target.protocol !== 'https:' || !origins.includes(target.origin))
          throw new Error('Network origin is not allowed for this card');
        const method = data.method === 'HEAD' ? 'HEAD' : 'GET';
        if (!window.dshDesktop.visualizeNetworkFetch)
          throw new Error('Network fetching is unavailable');
        reply(await window.dshDesktop.visualizeNetworkFetch({
          sessionId, cardId: currentCard.cardId, url: target.href, method,
        }));
      } catch (error) {
        reply({ ok: false, error: error.message || 'Network request failed' });
      }
    }

    const onMessage = event => {
      if (!frame || event.source !== frame.contentWindow || !event.data || event.data.cardId !== card.cardId) return;
      if (event.data.type === 'camellia-visualize-height') {
        // Viewport-sized content reports the larger frame height when expanded
        // or presenting. Keep the inline height so Collapse restores it.
        if (expanded || document.fullscreenElement === block) return;
        contentHeight = Math.max(140, Math.min(1400, Number(event.data.height) || 360));
        applyFrameHeight();
      } else if (event.data.type === 'camellia-visualize-width') {
        if (expanded || document.fullscreenElement === block) return;
        const available = Math.max(240, block.parentElement?.clientWidth || window.innerWidth);
        const nextWidth = Math.max(240, Math.min(1600, Number(event.data.width) || 0));
        if (!nextWidth) return;
        const border = Math.max(0, block.offsetWidth - block.clientWidth);
        const width = Math.min(available, nextWidth + border);
        block.classList.toggle('is-compact', width < available - 24);
        if (width < available - 1) {
          if (Math.abs(block.getBoundingClientRect().width - width) > 1) block.style.width = width + 'px';
        } else {
          block.style.width = '';
        }
      } else if (event.data.type === 'camellia-visualize-fill') {
        onFill(String(event.data.text || ''));
      } else if (event.data.type === 'camellia-visualize-state') {
        queueStateSave(event.data.state);
      } else if (event.data.type === 'camellia-visualize-action') {
        const action = normalizeAction(event.data.action);
        if (action) showAction(action);
      } else if (event.data.type === 'camellia-visualize-network-request') {
        void handleNetworkRequest(event.data);
      } else if (event.data.type === 'camellia-visualize-ready') {
        slideDeck = event.data.slides === true;
      } else if (event.data.type === 'camellia-visualize-present-menu') {
        const rect = frame.getBoundingClientRect();
        showPresentMenu(rect.left + Number(event.data.x), rect.top + Number(event.data.y));
      } else if (event.data.type === 'camellia-visualize-dismiss-menu') {
        hidePresentMenu();
      } else if (event.data.type === 'camellia-visualize-exit-present') {
        void exitPresentation();
      }
    };
    window.addEventListener('message', onMessage);

    function applyTheme() {
      const nextTheme = resolvedTheme();
      if (nextTheme === currentTheme) return;
      currentTheme = nextTheme;
      renderDocument();
    }
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mediaTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystemTheme = applyTheme;
    mediaTheme?.addEventListener?.('change', onSystemTheme);

    async function load() {
      try {
        const result = window.dshDesktop.visualizeGet
          ? await window.dshDesktop.visualizeGet({ sessionId, cardId: currentCard.cardId })
          : await window.dshDesktop.conversationCommand({
            engine, action: 'visualize-get', payload: { sessionId, cardId: currentCard.cardId },
          });
        if (disposed) return;
        if (!result?.ok || !result.card?.html) throw new Error(result?.error || 'Visualization not available');
        if (!frame) {
          frame = document.createElement('iframe');
          frame.className = 'visualize-frame';
          frame.setAttribute('sandbox', 'allow-scripts');
          frame.setAttribute('referrerpolicy', 'no-referrer');
          frame.addEventListener('load', () => { postPresentState(); postExpandState(); });
          frameWrap.replaceChildren(frame);
        }
        currentCard = { ...currentCard, ...result.card };
        currentHtml = String(result.card.html);
        if (!stateLoaded) {
          currentState = normalizeState(result.card.state) || {};
          stateLoaded = true;
        }
        applyHeader(currentCard);
        refreshCardLabels();
        frame.setAttribute('title', currentCard.title);
        contentHeight = currentCard.mode === 'wide' ? 560 : 420;
        applyFrameHeight();
        currentTheme = resolvedTheme();
        renderDocument();
      } catch (error) {
        if (disposed) return;
        const failure = document.createElement('div');
        failure.className = 'visualize-error';
        failure.textContent = tr(error.message || 'Could not load visualization');
        frameWrap.replaceChildren(failure);
        onStatus(failure.textContent);
      }
    }
    void load();
    syncPresent();
    block.flushVisualizeState = () => flushStateSave();
    block.getVisualizeState = () => normalizeState(currentState) || {};
    block.disposeVisualize = () => {
      if (disposed) return;
      disposed = true;
      hidePresentMenu();
      void flushStateSave();
      window.removeEventListener('message', onMessage);
      document.removeEventListener('fullscreenchange', syncPresent);
      window.removeEventListener('camellia:language', refreshCardLabels);
      document.removeEventListener('pointerdown', closeMoreOnOutsideClick, true);
      document.removeEventListener('pointerdown', onPresentPointerDown, true);
      document.removeEventListener('keydown', onPresentKeyDown, true);
      window.removeEventListener('blur', dismissPresentMenu);
      window.removeEventListener('resize', dismissPresentMenu);
      themeObserver.disconnect();
      mediaTheme?.removeEventListener?.('change', onSystemTheme);
      if (--mountedCards === 0) { removalObserver?.disconnect(); removalObserver = null; }
    };
    block.updateVisualize = next => {
      const previousRevision = currentCard.revision;
      currentCard = { ...currentCard, ...next };
      applyHeader(currentCard);
      refreshCardLabels();
      if (next.revision !== undefined && next.revision === previousRevision) return;
      hideAction();
      void load();
    };
    watchCardRemoval();
    return block;
  }

  window.CamelliaVisualize = { parse, mount, documentFor: frameDocument };
})();
