# Proxmox API Proxy Server

VMP Web UI + Proxmox VE + Backend Proxy Server

## Project Structure

```
proxmox-proxy/
├── src/
│   ├── index.js            # Express app entry point
│   ├── proxmoxClient.js    # Axios client (Proxmox connection)
│   ├── errorHandler.js     # Central error handler
│   └── routes/
│       ├── nodes.js        # Node list / status
│       └── vms.js          # VM operations
├── .env.example
├── .gitignore
└── package.json
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. .env file create
cp .env.example .env

# 3. Insert values in .env
#    PROXMOX_URL, PROXMOX_TOKEN, PROXMOX_DEFAULT_NODE

# 4. Start
npm run dev    # development (nodemon)
npm start      # production
```

## .env Config

```env
PROXMOX_URL=https://YOUR_PROXMOX_IP:8006
PROXMOX_TOKEN=PVEAPIToken=root@pam!YOUR_TOKEN_NAME=YOUR_TOKEN_SECRET
PROXMOX_DEFAULT_NODE=node1
PORT=3000
ALLOWED_ORIGINS=http://localhost:5173,https://your-vmp-domain.com
```

## API Endpoints

### Multi-node support 

```
/api/nodes/:node/vms/:vmid/start
```

### Health
```
GET /health
```

### Nodes
```
GET /api/nodes              → all nodes in cluster
GET /api/nodes/:node        → status of a node
```

### VMs (default node)
```
GET    /api/vms                          → VM list
GET    /api/vms/:vmid                    → VM status + config
POST   /api/vms/:vmid/start              → VM start
POST   /api/vms/:vmid/stop               → VM stop (force)
POST   /api/vms/:vmid/shutdown           → VM shutdown (graceful)
POST   /api/vms/:vmid/reboot             → VM reboot
DELETE /api/vms/:vmid                    → VM terminate (destroy)
GET    /api/vms/:vmid/stats?timeframe=hour → CPU/RAM/Disk/Net stats
GET    /api/vms/:vmid/console            → noVNC ticket
GET    /api/vms/:vmid/task/:upid         → Task status check
```

### VMs (specific node)
```
GET  /api/nodes/:node/vms
GET  /api/nodes/:node/vms/:vmid
POST /api/nodes/:node/vms/:vmid/start
... (same pattern)
```

### Stats timeframe options
```
hour | day | week | month | year
```

## Example API Requests

```bash
# Health check
curl http://localhost:3000/health

# List all nodes
curl http://localhost:3000/api/nodes

# List VMs on default node
curl http://localhost:3000/api/vms

# Get VM status (replace 100 with actual VM ID)
curl http://localhost:3000/api/vms/100

# Start VM
curl -X POST http://localhost:3000/api/vms/100/start

# Stop VM (force)
curl -X POST http://localhost:3000/api/vms/100/stop

# Shutdown VM (graceful)
curl -X POST http://localhost:3000/api/vms/100/shutdown

# Reboot VM
curl -X POST http://localhost:3000/api/vms/100/reboot

# Get VM stats
curl http://localhost:3000/api/vms/100/stats?timeframe=hour

# Get console ticket
curl http://localhost:3000/api/vms/100/console

# Multi-node: Start VM on specific node
curl -X POST http://localhost:3000/api/nodes/node1/vms/100/start
```

## Response Format

### Success
```json
{
  "ok": true,
  "data": { ... }
}
```

### Error
```json
{
  "ok": false,
  "error": "error message",
  "path": "/api/vms/101/start"
}
```

