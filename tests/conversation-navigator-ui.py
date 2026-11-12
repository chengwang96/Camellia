"""Conversation turn navigator and permanently hidden chat scrollbar."""
import ast
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in module.body
               if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture'
                                                        for target in node.targets))
fixture['messages'] = [
    {'role': 'user' if index % 2 == 0 else 'assistant', 'engine': 'claude', 'seq': index + 1,
     'text': f'Question {index // 2 + 1}: compare the experiment results and record the next steps.'
     if index % 2 == 0 else f'Answer {index // 2 + 1}\n\n' + ('The experiment result remains available. ' * 16)}
    for index in range(48)
]
node = next(node for node in module.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
bridge = ast.literal_eval(node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge = bridge.replace('window.switches = [];', 'window.switches = []; window.fixtureNavigator = true;')
bridge = bridge.replace(
    'workbenchSettings:async()=>({ok:true,conversations:window.fixturePreferences}),',
    'workbenchSettings:async()=>({ok:true,conversations:window.fixturePreferences,showConversationNavigator:window.fixtureNavigator !== false}),'
    'onConversationNavigatorChanged:fn=>{window.setFixtureNavigator=value=>{window.fixtureNavigator=value;fn(value);};return()=>{};},')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=claude', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="shared-fixture"]').click()
    expect(page.locator('#chat')).to_contain_text('Answer 24')
    expect(page.locator('#conversationRail')).to_be_visible()
    expect(page.locator('.conversation-marker')).to_have_count(24)
    rail_box = page.locator('#conversationRail').bounding_box()
    main_box = page.locator('.main').bounding_box()
    assert abs(rail_box['x'] - main_box['x'] - 2) <= 1, (rail_box, main_box)
    assert page.locator('#chatScroll').evaluate('(node)=>getComputedStyle(node).scrollbarWidth') == 'none'
    assert page.locator('#chatScroll').evaluate('(node)=>node.offsetWidth===node.clientWidth')
    page.wait_for_function("document.querySelectorAll('.conversation-marker')[23].classList.contains('is-current')")
    assert page.locator('.conversation-marker').nth(23).get_attribute('aria-current') == 'location'
    marker_widths = page.locator('.conversation-marker-line').evaluate_all(
        '(lines)=>lines.map(line=>getComputedStyle(line).width)')
    assert marker_widths[23] == '16px' and marker_widths[0] == '12px', marker_widths
    assert 'Question 1:' in page.locator('.conversation-marker').first.get_attribute('aria-label')
    assert page.locator('.conversation-marker').first.get_attribute('title') is None
    expect(page.locator('.conversation-marker:visible')).to_have_count(20)
    expect(page.locator('.conversation-window-more.is-up')).to_be_visible()
    expect(page.locator('.conversation-window-more.is-down')).to_be_hidden()
    page.locator('.conversation-window-more.is-up').click()
    page.wait_for_function("document.querySelectorAll('.conversation-marker')[3].classList.contains('is-current')")
    expect(page.locator('.conversation-window-more.is-up')).to_be_hidden()
    expect(page.locator('.conversation-window-more.is-down')).to_be_visible()

    page.locator('.conversation-marker:visible').first.click()
    page.wait_for_function("document.querySelector('#chatScroll').scrollTop <= 30")
    expect(page.locator('.conversation-marker').first).to_have_class(re.compile(r'\bis-current\b'))
    page.locator('.conversation-marker').nth(4).focus()
    page.keyboard.press('Enter')
    page.wait_for_function("document.querySelectorAll('.conversation-marker')[4].classList.contains('is-current')")

    page.evaluate('setFixtureNavigator(false)')
    expect(page.locator('#conversationRail')).to_be_hidden()
    page.evaluate('setFixtureNavigator(true)')
    expect(page.locator('#conversationRail')).to_be_visible()
    page.locator('#workPanelToggle').click()
    expect(page.locator('#workPanel')).to_be_visible()
    expect(page.locator('#conversationRail')).to_be_visible()
    assert page.locator('.conversation-marker').first.evaluate('(node)=>getComputedStyle(node).width') == '20px'
    assert page.locator('.conversation-marker-line').first.evaluate('(node)=>getComputedStyle(node).width') == '12px'
    page.screenshot(path=str(preview / 'conversation-navigator-panel.png'), animations='disabled')
    page.locator('#workPanelClose').click()
    expect(page.locator('#workPanel')).to_be_hidden()
    page.emulate_media(reduced_motion='no-preference')
    hover_marker = page.locator('.conversation-marker').nth(2)
    hover_line = hover_marker.locator('.conversation-marker-line')
    before_hover = hover_line.evaluate('(node)=>parseFloat(getComputedStyle(node).width)')
    assert hover_line.evaluate('(node)=>getComputedStyle(node).transitionDuration') != '0s'
    hover_marker.hover()
    page.wait_for_timeout(260)
    after_hover = hover_line.evaluate('(node)=>parseFloat(getComputedStyle(node).width)')
    assert after_hover > before_hover + 5, (before_hover, after_hover)
    expect(page.locator('.conversation-preview')).to_be_visible()
    expect(page.locator('.conversation-preview')).to_contain_text('Turn 3')
    expect(page.locator('.conversation-preview')).to_contain_text('Click to jump')
    expect(page.locator('.conversation-preview')).to_contain_text('Question 3')
    assert page.locator('.conversation-preview').evaluate('(node)=>getComputedStyle(node).borderRadius') == '12px'
    page.screenshot(path=str(preview / 'conversation-navigator-hover.png'), animations='disabled')
    page.mouse.move(1000, 120)
    expect(page.locator('.conversation-preview')).to_be_hidden()
    page.emulate_media(reduced_motion='reduce')

    page.evaluate("changeLanguage('zh-CN')")
    expect(page.locator('#conversationRail')).to_have_attribute('aria-label', '对话轮次')
    assert '跳转到第 1 轮' in page.locator('.conversation-marker').first.get_attribute('aria-label')
    page.locator('.conversation-marker').nth(2).hover()
    expect(page.locator('.conversation-preview')).to_contain_text('第 3 轮')
    expect(page.locator('.conversation-preview')).to_contain_text('点击跳转')
    page.mouse.move(1000, 120)
    page.evaluate("changeLanguage('en')")

    page.screenshot(path=str(preview / 'conversation-navigator-light.png'), animations='disabled')
    page.emulate_media(color_scheme='dark')
    page.screenshot(path=str(preview / 'conversation-navigator-dark.png'), animations='disabled')
    page.emulate_media(color_scheme='light')
    page.set_viewport_size({'width': 1100, 'height': 900})
    expect(page.locator('#conversationRail')).to_be_visible()
    assert page.locator('.conversation-marker').first.evaluate('(node)=>getComputedStyle(node).width') == '20px'
    assert page.locator('.conversation-marker-line').first.evaluate('(node)=>getComputedStyle(node).width') == '12px'
    page.set_viewport_size({'width': 1440, 'height': 900})
    expect(page.locator('#conversationRail')).to_be_visible()
    page.set_viewport_size({'width': 740, 'height': 900})
    expect(page.locator('#conversationRail')).to_be_hidden()
    page.set_viewport_size({'width': 1440, 'height': 900})
    expect(page.locator('#conversationRail')).to_be_visible()
    assert not errors, errors

    hidden_page = browser.new_page(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
    hidden_page.add_init_script(bridge.replace('window.fixtureNavigator = true;', 'window.fixtureNavigator = false;'))
    hidden_page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=claude', wait_until='networkidle')
    hidden_page.wait_for_function('uiReady')
    hidden_page.locator('[data-sid="shared-fixture"]').click()
    expect(hidden_page.locator('#chat')).to_contain_text('Answer 24')
    expect(hidden_page.locator('#conversationRail')).to_be_hidden()
    browser.close()
print('PASS: conversation navigator jumps, current-turn tracking, saved visibility and hidden chat scrollbar')
