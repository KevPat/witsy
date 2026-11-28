
// Decides whether a URL chosen by a model may be downloaded from the renderer.
// Only the URL is looked at: a public name that resolves to a private address
// and a redirect that goes through one cannot be seen from here.

const kBlockedIPv4Ranges: [string, number][] = [
  ['0.0.0.0', 8],       // "this" network: 0.0.0.0 reaches the machine itself
  ['10.0.0.0', 8],      // private
  ['100.64.0.0', 10],   // carrier-grade NAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local, where the cloud metadata services live
  ['172.16.0.0', 12],   // private
  ['192.0.0.0', 24],    // protocol assignments
  ['192.168.0.0', 16],  // private
  ['198.18.0.0', 15],   // benchmarking
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved and broadcast
]

// names that never leave the machine or the local network (RFC 6761, 6762, 8375, ICANN .internal)
const kBlockedSuffixes = ['localhost', 'localdomain', 'local', 'internal', 'home.arpa']

// short names of the cloud metadata services
const kBlockedHostnames = ['metadata', 'metadata.goog', 'instance-data']

const parseIPv4 = (text: string): number | null => {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return null
  const octets = text.split('.').map(Number)
  if (octets.some((octet) => octet > 255)) return null
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

const isBlockedIPv4 = (address: number): boolean => {
  return kBlockedIPv4Ranges.some(([network, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0
    return ((address & mask) >>> 0) === parseIPv4(network)
  })
}

// the eight groups of an address, with `::` and a dotted tail expanded
const parseIPv6 = (text: string): number[] | null => {
  const dotted = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) {
    const tail = parseIPv4(dotted[2])
    if (tail === null) return null
    text = `${dotted[1]}${(tail >>> 16).toString(16)}:${(tail & 0xffff).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groups = (part: string): number[] => part === '' ? [] : part.split(':').map((group) => /^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN)
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  if ([...head, ...tail].some(Number.isNaN)) return null
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  return [...head, ...new Array<number>(missing).fill(0), ...tail]
}

const isBlockedIPv6 = (groups: number[]): boolean => {
  const embedded = ((groups[6] << 16) | groups[7]) >>> 0
  const leadingZeros = groups.findIndex((group) => group !== 0)
  // ::, ::1 and the deprecated IPv4-compatible addresses
  if (leadingZeros === -1 || leadingZeros >= 6) return true
  // IPv4-mapped (::ffff:a.b.c.d)
  if (leadingZeros === 5 && groups[5] === 0xffff) return isBlockedIPv4(embedded)
  // NAT64 (64:ff9b::a.b.c.d)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return isBlockedIPv4(embedded)
  // unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
  return (groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xff80) === 0xfe80 || (groups[0] & 0xff00) === 0xff00
}

/**
 * True when a host, as returned by `new URL(url).hostname`, designates the
 * machine, the local network or a cloud metadata service. The URL parser has
 * already turned the other spellings of an IPv4 address (decimal, hexadecimal,
 * octal, short forms) into the dotted one.
 */
export const isPrivateHost = (hostname: string): boolean => {

  if (typeof hostname !== 'string') return true
  let host = hostname.trim().toLowerCase()

  if (host.startsWith('[') || host.includes(':')) {
    const groups = parseIPv6(host.replace(/^\[|\]$/g, ''))
    return groups === null || isBlockedIPv6(groups)
  }

  host = host.replace(/\.+$/, '')
  if (host === '') return true

  const address = parseIPv4(host)
  if (address !== null) return isBlockedIPv4(address)

  return kBlockedHostnames.includes(host) || kBlockedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))

}

/**
 * Returns why a URL must not be downloaded, or null when it may be.
 */
export const getUrlRefusal = (value: string): string | null => {

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'Invalid URL'
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only http and https URLs can be downloaded'
  }
  if (url.username !== '' || url.password !== '') {
    return 'URLs with credentials cannot be downloaded'
  }
  if (isPrivateHost(url.hostname)) {
    return 'URLs of this machine or of a private network cannot be downloaded'
  }

  return null

}
