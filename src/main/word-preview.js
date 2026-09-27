'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { XMLSerializer } = require('@xmldom/xmldom');

async function wordPreview(entries, bytes, xml) {
  const archive = new JSZip();
  for (const [name, entry] of entries) {
    if (entry.type === 'Directory') continue;
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new Error('Invalid Office archive path.');
    if (/\.(xml|rels)$/i.test(name)) {
      const document = await xml(name);
      for (const node of Array.from(document.getElementsByTagName('*'))) {
        if (node.localName === 'Relationship' && node.getAttribute('TargetMode') === 'External') node.parentNode.removeChild(node);
      }
      archive.file(name, new XMLSerializer().serializeToString(document));
    } else if (/\.(png|jpe?g|gif|webp)$/i.test(name)) archive.file(name, await bytes(name));
  }
  const payload = await archive.generateAsync({ type: 'base64', compression: 'DEFLATE' });
  const nonce = crypto.randomBytes(18).toString('base64');
  const library = name => fs.readFileSync(name, 'utf8').replace(/<\/script/gi, '<\\/script');
  const zipScript = library(path.join(path.dirname(require.resolve('jszip/package.json')), 'dist/jszip.min.js'));
  const docxScript = library(path.join(path.dirname(require.resolve('docx-preview')), 'docx-preview.min.js'));
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><style>
    body{margin:0;background:#e9ebee;color:#202124;font:14px Arial,sans-serif}#status{padding:12px}#document{overflow:auto}.docx-wrapper{padding:20px!important}.docx-wrapper>section.docx{margin-bottom:20px}
  </style></head><body><p id="status">Rendering document… / 正在渲染文档…</p><div id="document"></div>
  <script nonce="${nonce}">${zipScript}</script><script nonce="${nonce}">${docxScript}</script>
  <script nonce="${nonce}">
    document.addEventListener('click',event=>{if(event.target.closest('a'))event.preventDefault()});
    const data=Uint8Array.from(atob('${payload}'),character=>character.charCodeAt(0));
    const status=document.getElementById('status');
    const timer=setTimeout(()=>{status.textContent='Rendering is taking longer than expected. You can close the preview. / 渲染耗时较长，可关闭预览。'},15000);
    docx.renderAsync(data,document.getElementById('document'),null,{useBase64URL:true,renderAltChunks:false,ignoreFonts:true,ignoreLastRenderedPageBreak:false,renderHeaders:true,renderFooters:true,renderFootnotes:true,renderEndnotes:true,experimental:false})
      .then(()=>{clearTimeout(timer);status.remove()}).catch(()=>{clearTimeout(timer);status.textContent='Cannot render this document. Open with the system app. / 无法渲染此文档，请使用系统软件打开。'});
  </script></body></html>`;
  return html;
}

module.exports = { wordPreview };
