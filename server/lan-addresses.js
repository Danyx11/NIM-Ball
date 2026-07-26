import { networkInterfaces } from 'node:os';

// Reachable LAN IPv4 addresses for this machine, e.g. ['192.168.1.28'].
export function lanAddresses() {
  const nets = networkInterfaces();
  const addrs = [];
  for (const iface of Object.values(nets)) {
    for (const info of iface || []) {
      if (info.family === 'IPv4' && !info.internal) addrs.push(info.address);
    }
  }
  return addrs;
}
