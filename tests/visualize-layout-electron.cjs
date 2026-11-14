'use strict';

// Manual native UI regression, with task-owned card fragments supplied as args.
// node tests/visualize-layout-electron.cjs <table-fragment> <slide-fragment>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  const files = process.argv.slice(2).map(file => path.resolve(file));
  assert.equal(files.length, 2, 'Supply the table and slide HTML fragments');
  if (!process.versions.electron) {
    files.forEach(file => assert.ok(fs.statSync(file).isFile()));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-visualize-layout-'));
    const env = { ...process.env, CAMELLIA_LAYOUT_TEST_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), [__filename, ...files], { env, windowsHide: true, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 60000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      assert.equal(code, 0, output);
      console.log(output.trim());
    } finally {
      clearTimeout(timer);
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('camellia-visualize-layout-'));
      removeTree(root);
    }
    return;
  }
  const { app, BrowserWindow } = require('electron');
  const root = process.env.CAMELLIA_LAYOUT_TEST_ROOT;
  app.setPath('userData', root);
  app.disableHardwareAcceleration();
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1600, height: 1000, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const wc = window.webContents;
  const errors = [];
  wc.on('console-message', event => { if (event.level === 'error' && !event.message.includes('Content Security Policy')) errors.push(event.message); });
  const renderer = path.resolve(__dirname, '../src/renderer');
  const host = path.join(root, 'host.html');
  fs.writeFileSync(host, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="' +
    pathToFileURL(path.join(renderer, 'shared/ui-theme.css')).href + '"><link rel="stylesheet" href="' +
    pathToFileURL(path.join(renderer, 'chat/visualize-card.css')).href + '"><style>body{margin:0;padding:16px}#chat{max-width:1000px;margin:auto}</style><div id="chat"><p id="conversation">继续核对选中项。</p><div id="cards"></div><textarea id="composer" aria-label="消息输入">继续提问</textarea></div>');
  await window.loadFile(host);
  let rendererSource = fs.readFileSync(path.join(renderer, 'chat/visualize-card.js'), 'utf8');
  if (process.env.CAMELLIA_QA_LEGACY_EXPAND === '1') {
    // Existing windows have no expansion message and keep accepting height
    // reports while expanded. A live card update must work there as well.
    rendererSource = rendererSource.replace(/postExpandState\(\);/g, '');
    rendererSource = rendererSource.replace('if (expanded || document.fullscreenElement === block) return;', '');
  }
  await wc.executeJavaScript(rendererSource);
  await wc.executeJavaScript(`window.qaActions=[];window.qaSaves=[];window.qaCard=null;
    window.dshDesktop={visualizeGet:async()=>({ok:true,card:qaCard}),visualizeState:async v=>{qaSaves.push(v.state);return {ok:true};}};
    window.mountQA=card=>{document.querySelector('.visualize-block')?.disposeVisualize();qaCard=card;document.querySelector('#cards').replaceChildren(CamelliaVisualize.mount(card,{sessionId:'layout-test',onAction:v=>{qaActions.push(v);return true;}}));};void 0;`);
  async function wait(check, label) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const value = await check(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Timed out: ' + label + '\n' + errors.join('\n'));
  }
  const run = source => wc.executeJavaScript(source, true);
  const frame = () => wc.mainFrame.frames[0];
  const inside = source => frame().executeJavaScript(source, true);
  const frameHeight = () => run('document.querySelector("iframe").getBoundingClientRect().height');
  async function capture(name) {
    if (!process.env.CAMELLIA_QA_SCREENSHOTS) return;
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await inside('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const shot = await wc.capturePage(undefined, { stayHidden: true });
    fs.writeFileSync(path.join(process.env.CAMELLIA_QA_SCREENSHOTS, name + '.png'), shot.toPNG());
  }
  const card = html => ({ cardId: 'layout-test', title: 'Layout test', mode: 'wide', style: 'whale', html, state: {} });
  await run('mountQA(' + JSON.stringify(card(fs.readFileSync(files[0], 'utf8'))) + ')');
  await wait(async () => frame() && await inside('document.querySelectorAll("#rc-rows tr[data-id]").length === 36'), 'table');
  await new Promise(resolve => setTimeout(resolve, 150));
  const inlineHeight = await frameHeight();
  const compactTableHeight = await inside('document.querySelector(".rc-scroll").clientHeight');
  const visibleRows = () => inside(`(()=>{const view=document.querySelector('.rc-scroll').getBoundingClientRect();const header=document.querySelector('thead').getBoundingClientRect();return [...document.querySelectorAll('#rc-rows tr[data-id]')].filter(row=>{const r=row.getBoundingClientRect();return r.top>=header.bottom-1&&r.bottom<=view.bottom+1}).length;})()`);
  const compactRows = await visibleRows();
  await run('document.querySelector(".visualize-expand").click()');
  await wait(async () => await visibleRows() >= compactRows + 6, 'unfiltered table shows more complete rows');
  const expandedRows = await visibleRows();
  await capture('table-unfiltered-expanded');
  await run('document.querySelector(".visualize-expand").click()');
  await wait(async () => Math.abs(await frameHeight() - inlineHeight) <= 2, 'unfiltered collapse restores height');
  assert.equal(await visibleRows(), compactRows);
  console.log('PASS: visible rows ' + compactRows + ' -> ' + expandedRows + ' -> ' + compactRows + (process.env.CAMELLIA_QA_LEGACY_EXPAND === '1' ? ' without expansion messages' : ''));
  await inside(`document.querySelector('#rc-rows input').click();document.querySelector('#rc-filter').value='需复查';document.querySelector('#rc-filter').dispatchEvent(new Event('change'));document.querySelector('#rc-all').click();`);
  assert.ok(await inside('document.querySelectorAll("#rc-rows input:checked").length > 1'));
  await run('document.querySelector(".visualize-expand").click()');
  if (process.env.CAMELLIA_QA_LEGACY_EXPAND !== '1') await wait(() => inside('document.documentElement.dataset.vizExpanded === "1"'), 'expand attribute');
  await wait(async () => await inside('document.querySelector(".rc-scroll").clientHeight') > compactTableHeight + 200, 'table uses expanded viewport');
  await capture('table-expanded');
  assert.equal(await run('!!document.fullscreenElement'), false);
  assert.equal(await run('document.querySelector("#composer").value'), '继续提问');
  await run('document.querySelector(".visualize-expand").click()');
  await wait(async () => Math.abs(await frameHeight() - inlineHeight) <= 2, 'collapse restores inline height');
  await inside(`document.querySelector('#rc-send').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.querySelector('#rc-send').click();`);
  await wait(() => run('!document.querySelector(".visualize-action-tray").hidden'), 'selection confirmation');
  await run('document.querySelector(".visualize-action-use").click()');
  assert.equal(await run('qaActions.length'), 1);
  assert.equal(await run('qaActions[0].payload.demo'), true);
  assert.ok(await run('qaActions[0].payload.ids.includes("C01")'));
  assert.ok(await run('new TextEncoder().encode(JSON.stringify(qaActions[0].payload)).length < 1400'));
  await run('document.querySelector(".visualize-block").flushVisualizeState()');
  const state = await run('document.querySelector(".visualize-block").getVisualizeState()');
  const restored = card(fs.readFileSync(files[0], 'utf8')); restored.state = state;
  await run('mountQA(' + JSON.stringify(restored) + ')');
  await wait(async () => frame() && await inside('document.querySelector("#rc-filter")?.value === "需复查"'), 'restored table');
  assert.ok(await inside('document.querySelectorAll("#rc-rows input:checked").length > 1'));
  await inside(`document.querySelector('#rc-search').value='没有这个测试';document.querySelector('#rc-search').dispatchEvent(new Event('input'));`);
  assert.equal(await inside('document.querySelectorAll("#rc-rows tr[data-id]").length'), 0);
  console.log('PASS: table filtering, selection, expand/collapse, action confirmation and state restoration');
  if (process.env.CAMELLIA_QA_LEGACY_EXPAND === '1') {
    window.destroy();
    app.quit();
    return;
  }
  await run('document.querySelector(".visualize-present").click()');
  await wait(() => run('!!document.fullscreenElement'), 'non-slide fullscreen');
  await wait(() => inside('document.documentElement.dataset.vizPresenting === "1"'), 'non-slide presentation');
  await rightClick();
  assert.equal(await run('document.querySelectorAll(".visualize-present-menu button:not([hidden])").length'), 1);
  assert.equal(await run('document.querySelector("[data-present-command=exit]").textContent'), 'Exit presentation  ·  Esc');
  await run('document.querySelector("[data-present-command=exit]").click()');
  await wait(() => run('!document.fullscreenElement'), 'non-slide exit');

  const deck = card(fs.readFileSync(files[1], 'utf8')); deck.style = 'editorial'; deck.state = { slide: 1 };
  await run('mountQA(' + JSON.stringify(deck) + ')');
  await wait(async () => frame() && await inside('document.documentElement?.dataset.vizPresentation === "slides"'), 'slide marker');
  await new Promise(resolve => setTimeout(resolve, 100));
  const deckInlineHeight = await frameHeight();
  await run('document.querySelector(".visualize-present").click()');
  await wait(() => run('!!document.fullscreenElement'), 'native element fullscreen');
  await wait(() => inside('document.documentElement.dataset.vizPresenting === "1"'), 'slide presentation');
  assert.equal(await run('getComputedStyle(document.querySelector(".visualize-heading")).display'), 'none');
  assert.equal(await run('getComputedStyle(document.querySelector(".visualize-head")).display'), 'none');
  const nativeWidth = await run('innerWidth');
  const nativeHeight = await run('innerHeight');
  await wait(() => inside('innerWidth === ' + nativeWidth + ' && innerHeight === ' + nativeHeight), 'native fullscreen viewport');
  assert.equal(await inside('getComputedStyle(document.querySelector(".vdeck-top")).display'), 'none');
  assert.equal(await inside('getComputedStyle(document.querySelector(".vdeck-bottom")).display'), 'none');
  await capture('ppt-fullscreen');
  let inputSession;
  async function leftClick(x, y) {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    if (!inputSession) {
      const { targetInfos } = await wc.debugger.sendCommand('Target.getTargets');
      const target = targetInfos.find(info => info.type === 'iframe' && info.url === 'about:srcdoc');
      assert.ok(target, 'Sandboxed card input target');
      inputSession = (await wc.debugger.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    }
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',x,y}, inputSession);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',x,y,clickCount:1}, inputSession);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',x,y,clickCount:1}, inputSession);
  }
  for (const fallback of [false, true]) {
    await inside('window.camelliaVisualize.presentation.clickToAdvance=' + !fallback);
    await wait(() => inside('document.querySelector("#vd-local").readyState >= 2'), 'video ready for control click');
    const video = await inside('document.querySelector("#vd-local").getBoundingClientRect().toJSON()');
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(video.left + 24), y: Math.round(video.bottom - 46) });
    await inside('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await capture('ppt-video-controls');
    await leftClick(Math.round(video.left + 24), Math.round(video.bottom - 46));
    await wait(() => inside('!document.querySelector("#vd-local").paused'), 'native video play control');
    assert.equal(await inside('document.querySelector("#vd-count").textContent'), '02 / 05');
    await leftClick(Math.round(video.left + 24), Math.round(video.bottom - 46));
    await wait(() => inside('document.querySelector("#vd-local").paused'), 'native video pause control');
    assert.equal(await inside('document.querySelector("#vd-count").textContent'), '02 / 05');
    for (const [x, expected] of [[20,'03 / 05'],[Math.round(nativeWidth / 2),'04 / 05'],[nativeWidth - 20,'05 / 05']]) {
      await leftClick(x, 20);
      await wait(() => inside('document.querySelector("#vd-count").textContent === ' + JSON.stringify(expected)), 'left/center/right click advances one page');
    }
    await leftClick(nativeWidth - 20, 20);
    assert.equal(await inside('document.querySelector("#vd-count").textContent'), '05 / 05');
    await inside(`for(let i=0;i<3;i++)window.dispatchEvent(new CustomEvent('camellia:presentation-command',{detail:{command:'previous'}}));`);
    assert.equal(await inside('document.querySelector("#vd-count").textContent'), '02 / 05');
    console.log('PASS: ordinary left/center/right clicks advance; native video controls play/pause without advancing' + (fallback ? ' (legacy card fallback)' : ' (shared slide bridge)'));
  }
  await inside('window.camelliaVisualize.presentation.clickToAdvance=true');
  await inside(`(()=>{const controls=document.createElement('div');controls.id='qa-slide-controls';controls.style.cssText='position:fixed;left:30px;top:50px;z-index:50;display:flex;gap:12px';controls.innerHTML='<button id="qa-button"><span>Interact</span></button><input id="qa-input" aria-label="Editable"><a id="qa-link" href="#">Link</a><div id="qa-role" role="button">Role</div><div id="qa-custom" data-viz-interactive>Custom</div><div id="qa-editable" contenteditable="true">Edit</div>';controls.addEventListener('click',event=>{if(event.target.closest('a'))event.preventDefault();controls.dataset.clicks=String(Number(controls.dataset.clicks||0)+1)});document.body.append(controls);})()`);
  for (const id of ['qa-button','qa-input','qa-link','qa-role','qa-custom','qa-editable']) {
    const rect = await inside('document.getElementById(' + JSON.stringify(id) + ').getBoundingClientRect().toJSON()');
    await leftClick(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
    assert.equal(await inside('document.querySelector("#vd-count").textContent'), '02 / 05');
  }
  assert.equal(await inside('document.querySelector("#qa-slide-controls").dataset.clicks'), '6');
  await inside('document.querySelector("#qa-slide-controls").remove();window.getSelection().removeAllRanges()');
  console.log('PASS: native and custom controls retain interaction without page changes');
  async function rightClick(x = 300, y = 250) {
    wc.sendInputEvent({ type: 'mouseDown', button: 'right', x, y, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', button: 'right', x, y, clickCount: 1 });
    await wait(() => run('!document.querySelector(".visualize-present-menu").hidden'), 'iframe context menu');
  }
  await rightClick();
  assert.equal(await run('document.querySelectorAll(".visualize-present-menu button:not([hidden])").length'), 3);
  await run('document.querySelector("[data-present-command=next]").click()');
  await wait(() => inside('document.querySelector("#vd-count").textContent === "03 / 05"'), 'next slide from menu');
  await rightClick();
  await run('document.querySelector("[data-present-command=previous]").click()');
  await wait(() => inside('document.querySelector("#vd-count").textContent === "02 / 05"'), 'previous slide from menu');
  await rightClick(nativeWidth - 2, nativeHeight - 2);
  const bounds = await run('document.querySelector(".visualize-present-menu").getBoundingClientRect().toJSON()');
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= nativeWidth && bounds.bottom <= nativeHeight);
  await capture('ppt-right-click-menu');
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', x: 400, y: 300, clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', x: 400, y: 300, clickCount: 1 });
  await wait(() => run('document.querySelector(".visualize-present-menu").hidden'), 'outside click dismisses menu');
  await rightClick();
  await run('document.querySelector("[data-present-command=exit]").click()');
  await wait(() => run('!document.fullscreenElement'), 'exit fullscreen');
  await wait(() => inside('!document.documentElement.dataset.vizPresenting'), 'presentation exit');
  assert.equal(await inside('document.querySelector("#vd-count").textContent'), '02 / 05');
  assert.ok(Math.abs(await frameHeight() - deckInlineHeight) <= 2);
  assert.equal(await inside('document.querySelector("#vd-local").paused'), true);
  await run('document.querySelector(".visualize-present").click()');
  await wait(() => run('!!document.fullscreenElement'), 'reenter fullscreen');
  await wait(() => inside('document.documentElement.dataset.vizPresenting === "1"'), 'presentation reentered');
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(() => run('!document.fullscreenElement'), 'Escape exits from focused iframe');
  await wait(() => inside('!document.documentElement.dataset.vizPresenting'), 'Escape synchronizes presentation state');
  assert.equal(await run('document.querySelector(".visualize-present-menu").hidden'), true);
  assert.notEqual(await run('getComputedStyle(document.querySelector(".visualize-head")).display'), 'none');
  console.log('PASS: chrome hidden, native right-click menu, next/previous, edge clamping, outside dismissal, End slide show and Escape');
  // Native fullscreen uses the actual monitor size. Check other viewport shapes
  // in a sized iframe using the same bridge and presentation document styles.
  await run('document.querySelector(".visualize-expand").click()');
  await run('document.querySelector("iframe").contentWindow.postMessage({cardId:"layout-test",type:"camellia-visualize-present",active:true},"*")');
  await wait(() => inside('document.documentElement.dataset.vizPresenting === "1"'), 'sized presentation');
  const measurements = [];
  for (const [width, height] of [[1600,900],[1280,1024],[800,1100],[2560,1080]]) {
    await run('document.querySelector("iframe").style.width="' + width + 'px";document.querySelector("iframe").style.height="' + height + 'px"');
    await wait(() => inside('innerWidth === ' + width + ' && innerHeight === ' + height), 'viewport dimensions');
    const geometry = await inside(`(()=>{const r=document.querySelector('.vdeck-stage').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,padding:getComputedStyle(document.querySelector('.viz-theme')).padding};})()`);
    const expectedWidth = Math.min(geometry.vw, geometry.vh * 16 / 9);
    assert.ok(Math.abs(geometry.width - expectedWidth) < 2, JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.width / geometry.height - 16 / 9) < .01, JSON.stringify(geometry));
    assert.ok(geometry.x >= -1 && geometry.y >= -1 && geometry.x + geometry.width <= geometry.vw + 1 && geometry.y + geometry.height <= geometry.vh + 1, JSON.stringify(geometry));
    assert.equal(geometry.padding, '0px');
    measurements.push(geometry);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: native fullscreen, no header footprint, 16:9 fitting on four viewport shapes, page and inline height restored');
  console.log(JSON.stringify(measurements));
  window.destroy();
  app.quit();
}

main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
