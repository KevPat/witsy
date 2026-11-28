
import { describe, expect, test } from 'vitest'
import { getUrlRefusal, isPrivateHost } from '@renderer/utils/url_guard'

describe('isPrivateHost', () => {

  test.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.0', '10.255.255.255', '100.64.0.0', '100.127.255.255',
    '127.0.0.1', '127.255.255.255', '169.254.0.1', '169.254.169.254', '172.16.0.0', '172.31.255.255',
    '192.0.0.1', '192.168.0.0', '192.168.255.255', '198.18.0.1', '198.19.255.255',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ])('%s is private', (host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  test.each([
    '1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.0', '93.184.216.34', '100.63.255.255', '100.128.0.0',
    '126.255.255.255', '128.0.0.0', '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0',
    '192.0.1.0', '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '223.255.255.255',
  ])('%s is public', (host) => {
    expect(isPrivateHost(host)).toBe(false)
  })

  test.each([
    '[::]', '[::1]', '[0:0:0:0:0:0:0:1]', '[::7f00:1]', '[::127.0.0.1]',
    '[::ffff:7f00:1]', '[::ffff:127.0.0.1]', '[::ffff:a00:5]', '[::ffff:169.254.169.254]', '[::ffff:c0a8:101]', '[0:0:0:0:0:ffff:0:0]',
    '[64:ff9b::7f00:1]', '[64:ff9b::10.0.0.1]',
    '[fc00::1]', '[fd00::1]', '[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
    '[fe80::1]', '[febf::1]', '[fec0::1]', '[ff02::1]', '[FE80::1]',
    '::1', 'fe80::1',
  ])('%s is private', (host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  test.each([
    '[2606:4700:4700::1111]', '[2001:4860:4860::8888]', '[2a00:1450:4007:80c::200e]',
    '[::ffff:808:808]', '[::ffff:93.184.216.34]', '[64:ff9b::808:808]', '[fbff::1]', '[fe00::1]', '[2001:db8::1]',
  ])('%s is public', (host) => {
    expect(isPrivateHost(host)).toBe(false)
  })

  test.each([
    '[', '[]', '[:::1]', '[1::2::3]', '[::g]', '[1:2:3:4:5:6:7]', '[1:2:3:4:5:6:7:8:9]', '[::ffff:999.0.0.1]', '[fe80::1%eth0]',
  ])('%s cannot be read as an address and is refused', (host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  test.each([
    'localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'a.b.localhost.', 'localhost.localdomain',
    'printer.local', 'nas.local.', 'db.internal', 'metadata.google.internal', 'instance-data.ec2.internal',
    'router.home.arpa', 'metadata', 'metadata.goog', 'instance-data', '', '.', ' localhost ',
  ])('%j is private', (host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  test.each([
    'example.com', 'example.com.', 'localhost.example.com', 'notlocalhost', 'mylocal', 'local.example.org',
    'internal.example.com', 'metadata.example.com', 'xn--bcher-kva.example', '127.0.0.1.nip.io',
  ])('%s is public', (host) => {
    expect(isPrivateHost(host)).toBe(false)
  })

  test('something that is not a host name is refused', () => {
    expect(isPrivateHost(undefined as unknown as string)).toBe(true)
    expect(isPrivateHost(null as unknown as string)).toBe(true)
    expect(isPrivateHost(127 as unknown as string)).toBe(true)
  })

})

describe('getUrlRefusal', () => {

  test.each([
    'https://example.com/article',
    'http://example.com/article',
    'HTTPS://EXAMPLE.COM/Article',
    'https://docs.example.com:8443/search?q=witsy#results',
    'https://93.184.216.34/',
    'https://[2606:4700:4700::1111]/dns-query',
    'https://bücher.example/',
    'https://example.com/?next=http://127.0.0.1/',
    'https://example.com/localhost/127.0.0.1',
    'https://localhost.example.com/',
  ])('%s may be downloaded', (url) => {
    expect(getUrlRefusal(url)).toBeNull()
  })

  // every way the URL parser accepts to write 127.0.0.1, 0.0.0.0, 10.0.0.1 or 169.254.169.254
  test.each([
    'http://127.0.0.1/', 'http://127.1/', 'http://127.0.1/', 'http://2130706433/', 'http://0x7f000001/',
    'http://0x7f.0.0.1/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://017700000001/', 'http://127.0.0.1./',
    'http://①②⑦.0.0.1/', 'http://127。0。0。1/', 'http://0/', 'http://0.0.0.0:8090/', 'http://00.0.0.0/',
    'http://10.1/', 'http://167772161/', 'http://0xa.0.0.1/', 'http://012.0.0.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://2852039166/', 'http://0xa9fea9fe/', 'http://0251.0376.0251.0376/',
    'http://[::1]/', 'http://[0:0:0:0:0:0:0:1]:8080/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/', 'http://[::]/', 'http://[fd00::1]/', 'http://[fe80::1]/',
  ])('%s is refused', (url) => {
    expect(getUrlRefusal(url)).toBe('URLs of this machine or of a private network cannot be downloaded')
  })

  test.each([
    'http://localhost:11434/api/tags', 'http://LOCALHOST/', 'http://localhost.:3000/', 'http://app.localhost:3000/',
    'https://192.168.1.1/', 'http://metadata.google.internal/computeMetadata/v1/', 'http://metadata/computeMetadata/v1/',
    'http://homeassistant.local:8123/', 'http://kubernetes.default.svc.cluster.local/',
    ' http://127.0.0.1/ ', 'http:127.0.0.1', 'http:\\\\127.0.0.1\\admin', 'http://127.0.0.1\\@example.com/',
  ])('%j is refused', (url) => {
    expect(getUrlRefusal(url)).toBe('URLs of this machine or of a private network cannot be downloaded')
  })

  test.each([
    'http://admin:admin@192.168.1.1/', 'https://user@example.com/', 'https://:secret@example.com/',
    'http://example.com@127.0.0.1/', 'https://example.com:443@10.0.0.1/',
  ])('%s is refused because of its credentials', (url) => {
    expect(getUrlRefusal(url)).toBe('URLs with credentials cannot be downloaded')
  })

  test.each([
    'file:///etc/passwd', 'FILE:///etc/passwd', 'file:///C:/Users/user/.ssh/id_rsa', 'file://fileserver/share/payroll.xlsx',
    'ftp://example.com/file.txt', 'data:text/html,<h1>hi</h1>', 'javascript:alert(1)', 'blob:https://example.com/1234',
    'about:blank', 'chrome://settings', 'ws://example.com/', 'view-source:https://example.com/', 'witsy://settings',
  ])('%s is refused because of its scheme', (url) => {
    expect(getUrlRefusal(url)).toBe('Only http and https URLs can be downloaded')
  })

  test.each([
    'not a url', '', '/etc/passwd', '../index.html', 'example.com/page', '//127.0.0.1/', 'http://', 'http://999.1.1.1/',
    'http://0x100000000/', 'http://[::1', 'http://[fe80::1%25eth0]/',
  ])('%j is refused as invalid', (url) => {
    expect(getUrlRefusal(url)).toBe('Invalid URL')
  })

  test('something that is not a string is refused', () => {
    expect(getUrlRefusal(undefined as unknown as string)).toBe('Invalid URL')
    expect(getUrlRefusal(null as unknown as string)).toBe('Invalid URL')
    expect(getUrlRefusal({} as unknown as string)).toBe('Invalid URL')
  })

})
