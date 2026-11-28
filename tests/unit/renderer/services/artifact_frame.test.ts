
import { describe, expect, test } from 'vitest'
import { JSDOM } from 'jsdom'
import { buildFrameBridge, injectFrameBridge, kFrameHeightMessage, kFrameSnapshotMessage, kFrameSnapshotRequestMessage } from '@services/artifact_frame'

// The script the app adds to an html artifact. What it does once it runs in the frame is checked
// in tests/unit/renderer/components/message_item_html_block.test.ts and, in a real Electron, by
// tools/web_security_probe.cjs. Here: the script itself and where it is put in the page.

const kId = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('the script', () => {

  test('it is one script element that carries the id of the preview', () => {
    const bridge = buildFrameBridge(kId)
    const fragment = new JSDOM(`<body>${bridge}</body>`).window.document.body
    expect(fragment.querySelectorAll('script')).toHaveLength(1)
    expect(fragment.querySelector('script').hasAttribute('data-witsy-bridge')).toBe(true)
    expect(fragment.textContent).toContain(`const id = '${kId}';`)
    expect(fragment.children).toHaveLength(1)
  })

  test('it uses the message names the app listens to', () => {
    const bridge = buildFrameBridge(kId)
    expect(bridge).toContain(`type: '${kFrameHeightMessage}'`)
    expect(bridge).toContain(`type: '${kFrameSnapshotMessage}'`)
    expect(bridge).toContain(`=== '${kFrameSnapshotRequestMessage}'`)
    expect([kFrameHeightMessage, kFrameSnapshotRequestMessage, kFrameSnapshotMessage]).toEqual(['witsy-artifact-height', 'witsy-artifact-snapshot-request', 'witsy-artifact-snapshot'])
  })

  test('it only listens to its parent and only talks to its parent', () => {
    const bridge = buildFrameBridge(kId)
    expect(bridge).toContain('if (event.source !== window.parent || !event.data) return;')
    expect(bridge.match(/postMessage\(/g)).toHaveLength(1)
    expect(bridge).toContain('window.parent.postMessage(message, \'*\')')
  })

  test('two previews have two scripts', () => {
    expect(buildFrameBridge(kId)).not.toBe(buildFrameBridge(kId.replace('0f8f', '1f8f')))
  })

})

describe('where the script goes', () => {

  const bridge = buildFrameBridge(kId)

  test.each([
    ['a page with a head', '<!DOCTYPE html>\n<html>\n<head>\n<title>T</title>\n</head>\n<body><p>Hello</p></body>\n</html>', /<title>T<\/title>\s*<script data-witsy-bridge>[^]*<\/script>\s*<\/head>/],
    ['a page with an uppercase head', '<!DOCTYPE html>\n<HTML><HEAD><TITLE>T</TITLE></HEAD><BODY><p>Hello</p></BODY></HTML>', /<TITLE>T<\/TITLE>\s*<script data-witsy-bridge>[^]*<\/script>\s*<\/HEAD>/],
    ['a head closed with a space', '<html><head><title>T</title></head ><body><p>Hello</p></body></html>', /<title>T<\/title>\s*<script data-witsy-bridge>[^]*<\/script>\s*<\/head >/],
    ['a page without head', '<!DOCTYPE html>\n<html><body><p>Hello</p></body></html>', /^<!DOCTYPE html>\s*<html>\s*<script data-witsy-bridge>/],
    ['a page without doctype', '<html lang="en"><body><p>Hello</p></body></html>', /^<html lang="en">\s*<script data-witsy-bridge>/],
    ['a fragment', '<p>Hello</p>', /^\s*<script data-witsy-bridge>[^]*<\/script>\s*<p>Hello<\/p>$/],
    ['nothing', '', /^\s*<script data-witsy-bridge>[^]*<\/script>\s*$/],
  ])('%s', (_, page, expected) => {
    const result = injectFrameBridge(page, bridge)
    expect(result).toMatch(expected)
    expect(result.replace(bridge, '')).toBe(page)
  })

  test('the page keeps its rendering mode', () => {
    const standards = new JSDOM(injectFrameBridge('<!DOCTYPE html><html><body><p>Hello</p></body></html>', bridge)).window.document
    expect(standards.compatMode).toBe('CSS1Compat')
    const quirks = new JSDOM(injectFrameBridge('<html><body><p>Hello</p></body></html>', bridge)).window.document
    expect(quirks.compatMode).toBe('BackCompat')
  })

  test('a closing head tag in the text of the page does not move the script out of the head', () => {
    // the first closing tag is the one of the head: what comes later is content
    const page = '<html><head><title>T</title></head><body><pre>&lt;/head&gt;</pre><script>const s = "</head>"</script></body></html>'
    const result = injectFrameBridge(page, bridge)
    expect(result.indexOf('data-witsy-bridge')).toBeLessThan(result.indexOf('<body>'))
    expect(result.match(/data-witsy-bridge/g)).toHaveLength(1)
  })

})
