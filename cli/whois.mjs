// Classic WHOIS over TCP port 43 (what browsers cannot do). Follows the IANA referral to the
// registry, then the registry's referral to the registrar when one is given.
import net from 'node:net';

export function query(server, q, { port = 43, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: server, port });
    let data = '';
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`WHOIS ${server} timed out`)));
    socket.on('connect', () => socket.write(`${q}\r\n`));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

const referral = (text, re) => (text.match(re) || [])[1]?.trim().replace(/^whois:\/\//i, '').replace(/\/.*$/, '');

export async function whois(domain, { iana = 'whois.iana.org', port43 = query } = {}) {
  const tld = domain.split('.').pop();
  const root = await port43(iana, tld);
  const registry = referral(root, /^refer:\s*(\S+)/im) || referral(root, /^whois:\s*(\S+)/im);
  if (!registry) throw new Error(`no WHOIS server for .${tld}`);
  let text = await port43(registry, domain);
  let server = registry;
  const registrar = referral(text, /Registrar WHOIS Server:\s*(\S+)/i);
  if (registrar && registrar.toLowerCase() !== registry.toLowerCase()) {
    try {
      const more = await port43(registrar, domain);
      if (more.trim()) { text = `${text}\n\n${more}`; server = `${registry} → ${registrar}`; }
    } catch { /* registrar servers are often flaky; registry data is enough */ }
  }
  return { text, server };
}
