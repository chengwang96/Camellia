// Standalone reproduction of the chat scroll-follow mechanics in Chromium.
// Simulates: typing (composer grows), send (composer shrinks + user message
// appended + scroll-to-bottom), then streaming (turn grows over frames).
// Logs every scroll event with the followRunOutput state to find where
// the follow chain breaks.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; }
  #header { height: 48px; background: #ddd; flex: none; }
  #chatScroll { flex: 1; overflow-y: auto; padding: 24px 24px 8px; }
  #chat { max-width: 720px; margin: 0 auto; }
  .msg { margin: 12px 0; padding: 12px; background: #eef; border-radius: 8px; }
  .msg-user { background: #2f6fdd; color: #fff; margin-left: 120px; }
  .turn { margin: 12px 0; }
  .turn-body { line-height: 1.6; }
  #inputZone { flex: none; background: #f5f5f5; border-top: 1px solid #ccc; }
  #fakeInput { height: 56px; transition: none; }
</style></head><body>
  <div id="header"></div>
  <div id="chatScroll"><div id="chat"></div></div>
  <div id="inputZone"><div id="fakeInput"></div></div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const chatScroll = document.getElementById('chatScroll');
    const chat = document.getElementById('chat');
    const fakeInput = document.getElementById('fakeInput');
    const log = [];

    // ---- verbatim logic from claude.js ----
    let running = false;
    let followRunOutput = false;
    let programmaticScroll = false;
    function nearBottom() {
      return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 140;
    }
    function maybeScroll(was) {
      if (was || running && followRunOutput) {
        programmaticScroll = true;
        chatScroll.scrollTop = chatScroll.scrollHeight;
      }
    }
    chatScroll.addEventListener('scroll', () => {
      log.push({ ev: 'scroll', top: Math.round(chatScroll.scrollTop), max: chatScroll.scrollHeight - chatScroll.clientHeight, prog: programmaticScroll, follow: followRunOutput, running });
      if (running && !programmaticScroll) followRunOutput = nearBottom();
      programmaticScroll = false;
    });
    // ---- end verbatim ----

    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Pre-fill history so the pane scrolls.
    for (let i = 0; i < 12; i++) {
      const d = document.createElement('div');
      d.className = 'msg';
      d.style.height = '220px';
      d.textContent = 'old message ' + i;
      chat.appendChild(d);
    }
    chatScroll.scrollTop = chatScroll.scrollHeight; // initial pin (like loadSession)
    await frame();
    log.push({ ev: 'after-init', top: Math.round(chatScroll.scrollTop), max: chatScroll.scrollHeight - chatScroll.clientHeight });

    // User types: composer grows 56 -> 120px (autoResize while typing).
    fakeInput.style.height = '120px';
    await frame();
    log.push({ ev: 'after-typing', top: Math.round(chatScroll.scrollTop), max: chatScroll.scrollHeight - chatScroll.clientHeight, nearBottom: nearBottom() });

    // Send: composer shrinks back, user message appended, scrollToBottom, running=true.
    followRunOutput = true;
    fakeInput.style.height = '56px';               // autoResize() on clear
    const um = document.createElement('div');
    um.className = 'msg msg-user';
    um.textContent = '你好';
    chat.appendChild(um);                          // addUser
    programmaticScroll = true;                     // scrollToBottom branch
    chatScroll.scrollTop = chatScroll.scrollHeight;
    running = true;                                // setRunning(true)
    await frame();
    log.push({ ev: 'after-send', top: Math.round(chatScroll.scrollTop), max: chatScroll.scrollHeight - chatScroll.clientHeight, follow: followRunOutput });

    // Turn element appended (message_start -> ensureTurn, no scroll call there).
    const turn = document.createElement('div');
    turn.className = 'turn';
    turn.innerHTML = '<div class="turn-meta">meta</div><div class="turn-body"></div>';
    chat.appendChild(turn);
    const body = turn.querySelector('.turn-body');
    await frame();
    log.push({ ev: 'after-turn-append', top: Math.round(chatScroll.scrollTop), max: chatScroll.scrollHeight - chatScroll.clientHeight, follow: followRunOutput });

    // Streaming: 15 frames of growth, maybeScroll per frame (flushBlockRenders).
    for (let i = 0; i < 15; i++) {
      const was = nearBottom();
      body.textContent += 'streaming chunk ' + i + ' — lorem ipsum dolor sit amet. ';
      maybeScroll(was);
      await frame();
    }
    const maxEnd = chatScroll.scrollHeight - chatScroll.clientHeight;
    log.push({ ev: 'after-stream', top: Math.round(chatScroll.scrollTop), max: maxEnd, follow: followRunOutput, gap: maxEnd - Math.round(chatScroll.scrollTop) });
    return log;
  })()`);

  for (const entry of result) console.log(JSON.stringify(entry));
  await win.destroy();
  app.exit(0);
});
