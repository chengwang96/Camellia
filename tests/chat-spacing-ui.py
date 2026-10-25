"""Paragraph/list geometry, preserved line breaks and streamed/history parity."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
tree = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
source = ('**下一步：处理联通网关**\n\n'
          '请登录 `http://192.168.1.1`，优先尝试管理员入口 `http://192.168.1.1/cu.html`。\n\n'
          '登录后二选一：\n\n'
          '1. **DMZ 主机**：把 DMZ 指向 `192.168.3.1`（荣耀路由的 WAN 地址）。这是最简单的一步。\n'
          '2. **改桥接**：让荣耀路由直接 PPPoE 拨号，彻底去掉这一层 NAT。效果最好，但会短暂断网。\n\n'
          '不建议在联通网关上单独做 UDP 端口转发：本机 helper 每次重启会换随机端口，固定映射容易失效。\n\n'
          '改完后告诉我，我再跑 `netcheck` 和手机连接诊断。\n\n'
          '当前时间：2026-10-22 08:34 HKT。')
fixture['messages'][0]['text'] = '第一行\n第二行\n\n下一段\n\n- 项目一\n- 项目二'
fixture['messages'][-1]['text'] = source
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
output = repo / 'dist/ui-preview'
output.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors, metrics = [], []
    for theme, width in [('light', 1440), ('dark', 960), ('light', 420)]:
        page = browser.new_page(viewport={'width': width, 'height': 1000}, color_scheme=theme)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri()
                  + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        area = page.locator('#chat .turn .md').last
        expect(area.locator(':scope > p')).to_have_count(6)
        expect(area.locator(':scope > ol > li')).to_have_count(2)
        layout = area.evaluate('''el => {
          const blocks = [...el.children].map(node => node.getBoundingClientRect());
          const gaps = blocks.slice(1).map((rect, i) => rect.top - blocks[i].bottom);
          return {height: el.getBoundingClientRect().height, gaps,
            lineHeight: parseFloat(getComputedStyle(el).lineHeight)};
        }''')
        assert all(7.9 <= gap <= 8.1 for gap in layout['gaps']), layout
        assert layout['lineHeight'] <= 26, layout
        metrics.append({'theme': theme, 'width': width, **layout})
        area.screenshot(path=str(output / f'chat-spacing-after-{theme}-{width}.png'), animations='disabled')
        user = page.locator('#chat .msg-user .bubble').last
        assert user.locator('p').first.inner_text() == '第一行\n第二行'
        assert user.locator('p').first.evaluate('el => el.getBoundingClientRect().height') > 50

        # Streaming must keep the same compact layout while text is arriving.
        history_html = area.inner_html()
        page.evaluate('''source => {
          onBlockStart({type: 'text', text: '', phase: 'final_answer'}, 88);
          for (let at = 0; at < source.length; at += 7) {
            onBlockDelta({type: 'text_delta', text: source.slice(at, at + 7)}, 88);
            flushBlockRenders();
          }
        }''', source)
        live = page.locator('#chat .turn .md').last
        live_layout = live.evaluate('''el => {
          const blocks = [...el.children].filter(node => !node.matches('.cursor'));
          return {gaps: blocks.slice(1).map((node, i) =>
            node.getBoundingClientRect().top - blocks[i].getBoundingClientRect().bottom)};
        }''')
        # The paragraph beside the caret has inline glyph bounds instead of
        # a block line box. It must stay compact and retain the same total height.
        assert all(7.9 <= gap <= 12 for gap in live_layout['gaps']), live_layout
        assert abs(live.bounding_box()['height'] - layout['height']) < 0.1
        page.evaluate('onBlockStop(88)')
        assert live.inner_html() == history_html
        assert abs(live.bounding_box()['height'] - layout['height']) < 0.1

        # Repeated empty lines collapse, but explicit newlines and code do not.
        details = page.evaluate('''() => {
          const probe = document.createElement('div'); probe.className = 'md'; chat.appendChild(probe);
          const height = source => {probe.innerHTML = mdRender(source); return probe.getBoundingClientRect().height;};
          const normal = height('first\\n\\nnext');
          const repeated = height('first\\n \\n\\n\\nnext');
          probe.innerHTML = mdRender('- English title\\n中文译文');
          const itemHeight = probe.querySelector('li').getBoundingClientRect().height;
          probe.innerHTML = mdRender('```text\\none\\n\\nthree\\n```');
          const code = probe.querySelector('code').textContent;
          probe.remove(); return {normal, repeated, itemHeight, code};
        }''')
        assert details['normal'] == details['repeated'], details
        assert details['itemHeight'] > 50, details
        assert details['code'] == 'one\n\nthree', details
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.close()
    assert not errors, errors
    browser.close()
print(json.dumps(metrics, indent=2))
print('PASS: compact paragraph/list spacing, newlines, code, streaming, history, light/dark and mobile')
