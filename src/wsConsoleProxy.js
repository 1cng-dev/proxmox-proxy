const WebSocket = require("ws");
const { URL, URLSearchParams } = require("url");
const { takeSession } = require("./vncSessions");

const wss = new WebSocket.Server({ noServer: true });

// Builds the real Proxmox VE noVNC websocket URL for a session. Proxmox
// authenticates this handshake the same way as any other /api2 request, so
// we reuse PROXMOX_TOKEN rather than juggling PVEAuthCookie tickets.
function proxmoxWsUrl(session) {
  const base = new URL(process.env.PROXMOX_URL);
  const scheme = base.protocol === "https:" ? "wss:" : "ws:";
  const qs = new URLSearchParams({ port: session.port, vncticket: session.ticket });
  return (
    `${scheme}//${base.host}/api2/json/nodes/${session.node}` +
    `/qemu/${session.vmid}/vncwebsocket?${qs.toString()}`
  );
}

// Pipes a client's /ws/console/:sessionToken connection to the matching
// Proxmox vncwebsocket, without ever revealing the Proxmox host, port, or
// ticket to the browser. Wire this up to the HTTP server's 'upgrade' event —
// see src/index.js.
function handleConsoleUpgrade(request, socket, head) {
  const url = new URL(request.url, "http://localhost");
  const match = url.pathname.match(/^\/ws\/console\/([^/]+)$/);

  if (!match) {
    socket.destroy();
    return;
  }

  const session = takeSession(match[1]);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (clientSocket) => {
    const upstream = new WebSocket(proxmoxWsUrl(session), {
      rejectUnauthorized: false,
      headers: { Authorization: process.env.PROXMOX_TOKEN },
    });

    const closeBoth = () => {
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    };

    upstream.on("open", () => {
      clientSocket.on("message", (data) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      });
      upstream.on("message", (data) => {
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data);
      });
    });

    upstream.on("error", (err) => {
      console.error("[wsConsoleProxy] upstream error:", err.message);
      closeBoth();
    });
    clientSocket.on("error", closeBoth);
    upstream.on("close", closeBoth);
    clientSocket.on("close", closeBoth);
  });
}

module.exports = { handleConsoleUpgrade };
