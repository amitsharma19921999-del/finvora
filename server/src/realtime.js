// Server-Sent Events hub — powers the real-time Notification Centre (BPD 4.1),
// live market data pushes (Stage 9) and investor status updates, with zero
// external dependencies (browsers use the built-in EventSource API).
const clients = new Set(); // { res, userId, role }

function addClient(res, user) {
  const client = { res, userId: user.id, role: user.role };
  clients.add(client);
  res.on('close', () => clients.delete(client));
  return client;
}

function send(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { clients.delete(client); }
}

// target: 'ALL' | 'ADMIN' | numeric user id
function emit(target, event, data) {
  for (const c of clients) {
    if (target === 'ALL' || (target === 'ADMIN' && c.role === 'admin') || c.userId === target) {
      send(c, event, data);
    }
  }
}

setInterval(() => {
  for (const c of clients) {
    try { c.res.write(': ping\n\n'); } catch { clients.delete(c); }
  }
}, 25000).unref();

module.exports = { addClient, emit };
