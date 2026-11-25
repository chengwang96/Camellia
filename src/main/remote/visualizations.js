'use strict';

const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src data: blob:",
  "media-src data:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
].join('; ');

const THEME_CSS = [
  ':root{--viz-bg:#ffffff;--viz-fg:#1c2430;--viz-muted:#5c6678;--viz-border:#d8dee8;--viz-accent:#3f6fd8;--viz-good:#1d8a58;--viz-warn:#a66a00;--viz-font:"Segoe UI","Microsoft YaHei",sans-serif;color-scheme:light;}',
  ':root[data-theme=dark]{--viz-bg:#171b24;--viz-fg:#e7ebf5;--viz-muted:#9eabc4;--viz-border:#2c3650;--viz-accent:#6f9cff;--viz-good:#8ad9ae;--viz-warn:#ffd27a;color-scheme:dark;}',
  '.viz-theme{min-height:100%;padding:16px;padding-top:calc(16px + env(safe-area-inset-top));padding-bottom:calc(16px + env(safe-area-inset-bottom));border-radius:12px;background:var(--viz-bg);color:var(--viz-fg);font-family:var(--viz-font);box-sizing:border-box;}',
  '.viz-theme > *{background-color:transparent !important;}',
  '.viz-theme *{box-sizing:border-box;}',
  '.viz-theme h1,.viz-theme h2,.viz-theme h3{color:var(--viz-fg);letter-spacing:-.02em;margin:.2em 0 .5em;}',
  '.viz-theme p{color:var(--viz-muted);line-height:1.55;}',
  '.viz-theme table{width:100%;border-collapse:collapse;font-size:12px;}',
  '.viz-theme th{color:var(--viz-muted);text-align:left;border-bottom:1px solid var(--viz-border);padding:8px;}',
  '.viz-theme td{border-bottom:1px solid color-mix(in srgb,var(--viz-border) 65%,transparent);padding:8px;}',
  '.viz-theme button,.viz-theme input,.viz-theme select,.viz-theme textarea{font:inherit;}',
  '.viz-theme button{border:1px solid var(--viz-accent);background:transparent;color:var(--viz-accent);border-radius:8px;padding:7px 10px;}',
  '.viz-theme img{max-width:100%;height:auto;border-radius:8px;}',
  '.viz-theme code,.viz-theme pre{font-family:Consolas,"SFMono-Regular",monospace;}',
  '.viz-paper{--viz-bg:#ffffff!important;--viz-fg:#1c2430!important;--viz-muted:#5c6678!important;--viz-border:#d8dee8!important;--viz-accent:#3f6fd8!important;--viz-good:#1d8a58!important;--viz-warn:#a66a00!important;--viz-font:Georgia,"Times New Roman",serif!important;}',
  '.viz-editorial{--viz-bg:#fbf7ef!important;--viz-fg:#221f1a!important;--viz-muted:#766b5d!important;--viz-border:#ded3c2!important;--viz-accent:#b4532a!important;--viz-good:#2d7a54!important;--viz-warn:#9a6500!important;--viz-font:Georgia,"Times New Roman",serif!important;}',
  '.viz-sketch{--viz-bg:#fffdf4!important;--viz-fg:#24221d!important;--viz-muted:#6e6659!important;--viz-border:#cfc4a9!important;--viz-accent:#2f6f8f!important;--viz-good:#387b4a!important;--viz-warn:#a66a00!important;--viz-font:"Segoe Print","Comic Sans MS",cursive!important;border:2px solid var(--viz-border);box-shadow:3px 4px 0 rgba(36,34,29,.12);}',
  '.viz-terminal{--viz-bg:#07110c!important;--viz-fg:#b7f7c8!important;--viz-muted:#75a888!important;--viz-border:#245238!important;--viz-accent:#50e38d!important;--viz-good:#50e38d!important;--viz-warn:#f2c14e!important;--viz-font:Consolas,"SFMono-Regular",monospace!important;border-radius:4px;}',
].join('');

function visualizationDocument(card, theme = 'light') {
  if (!card || typeof card.html !== 'string') throw new Error('Visualization HTML is unavailable');
  const style = ['whale', 'editorial', 'paper', 'sketch', 'terminal'].includes(card.style) ? card.style : 'whale';
  const mode = theme === 'dark' ? 'dark' : 'light';
  const state = JSON.stringify(card.state && typeof card.state === 'object' && !Array.isArray(card.state)
    ? card.state : {}).replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const bridge = '<script>(function(){' +
    'var stateValue=' + state + ';var dataCache=null;' +
    'function clone(value){try{return JSON.parse(JSON.stringify(value));}catch(_){return null;}}' +
    'function scanData(){if(dataCache)return dataCache;dataCache={};var scripts=document.querySelectorAll("script[data-viz-name]");' +
    'for(var index=0;index<scripts.length;index++){if(scripts[index].type!=="application/json")continue;var name=scripts[index].getAttribute("data-viz-name");if(!name)continue;try{dataCache[name]=JSON.parse(scripts[index].textContent||"null");}catch(_){dataCache[name]=null;}}return dataCache;}' +
    'window.camelliaVisualize={version:2,presentation:{clickToAdvance:true},state:{get:function(){return clone(stateValue);},' +
    'set:function(value){if(!value||typeof value!=="object"||Array.isArray(value))return false;try{stateValue=JSON.parse(JSON.stringify(value));return true;}catch(_){return false;}},' +
    'patch:function(value){if(!value||typeof value!=="object"||Array.isArray(value))return false;return window.camelliaVisualize.state.set(Object.assign({},stateValue,value));},' +
    'reset:function(){stateValue={};return true;}},' +
    'data:{get:function(name){var data=scanData();return Object.prototype.hasOwnProperty.call(data,name)?clone(data[name]):null;},' +
    'list:function(){return Object.keys(scanData());},has:function(name){return Object.prototype.hasOwnProperty.call(scanData(),name);}},' +
    'fill:function(){return false;},action:function(){return false;}};' +
    // Mobile viewers have no host page, so the document owns its presentation
    // flag and the tap-to-advance gesture. Both mirror the desktop bridge so a
    // card written once behaves the same in every viewer.
    'var presenting=false;' +
    'function slides(){return !!document.querySelector("[data-viz-presentation=slides]");}' +
    'window.__camelliaPresentationCommand=function(command){if(presenting&&slides()&&(command==="previous"||command==="next"))window.dispatchEvent(new CustomEvent("camellia:presentation-command",{detail:{command:command}}));};' +
    'window.__camelliaSetPresenting=function(active){presenting=active===true;' +
    'if(presenting)document.documentElement.setAttribute("data-viz-presenting","1");' +
    'else document.documentElement.removeAttribute("data-viz-presenting");' +
    'window.dispatchEvent(new CustomEvent("camellia:presentation",{detail:{active:presenting}}));};' +
    'document.addEventListener("click",function(event){' +
    'if(!presenting||!window.camelliaVisualize.presentation.clickToAdvance||event.defaultPrevented||event.button!==0||event.detail>1||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;' +
    'var target=event.target;if(!target||!target.closest)return;' +
    'if(target.closest("button,a,area,input,select,textarea,label,summary,video,audio,iframe,object,embed,[contenteditable]:not([contenteditable=false]),[data-viz-interactive],[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=slider],[role=tab],[role=menuitem],[role=combobox],[role=textbox]"))return;' +
    'var selection=window.getSelection();if(selection&&!selection.isCollapsed)return;window.__camelliaPresentationCommand("next");});' +
    '})();</script>';
  return '<!doctype html><html data-theme="' + mode + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">' +
    '<meta name="color-scheme" content="light dark">' +
    '<style>html,body{margin:0;min-height:100%;background:var(--viz-bg);color:var(--viz-fg);' +
    'font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;-webkit-text-size-adjust:100%;}' +
    '*{box-sizing:border-box}body{overflow:auto;padding:0;}button,input,select,textarea{font:inherit;}' +
    THEME_CSS + (card.layoutVersion === 2
      ? '.viz-theme{display:flow-root;min-height:0;padding:var(--viz-padding,16px)}html[data-viz-presenting="1"] .viz-theme{min-height:100vh}'
      : '') + '</style>' + bridge + '</head><body><div class="viz-theme viz-' + style + '">'
    + card.html + '</div></body></html>';
}

module.exports = { visualizationDocument };
