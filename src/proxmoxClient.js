const axios = require("axios");
const https = require("https");

// Agent to allow self-signed certificates
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const proxmoxClient = axios.create({
  baseURL: `${process.env.PROXMOX_URL}/api2/json`,
  httpsAgent,
  headers: {
    Authorization: process.env.PROXMOX_TOKEN,
    "Content-Type": "application/json",
  },
  timeout: 15000,
  transformResponse: [function (data) {
    try {
      return JSON.parse(data);
    } catch (e) {
      // If JSON parsing fails, return the raw data
      return data;
    }
  }],
});

// Response interceptor — normalizes Proxmox errors
proxmoxClient.interceptors.response.use(
  (res) => {
    // Handle empty responses from Proxmox
    if (!res.data || res.data === '') {
      res.data = { data: null };
    }
    return res;
  },
  (err) => {
    const status = err.response?.status || 500;
    const proxmoxData = err.response?.data;
    const message =
      proxmoxData?.errors ||
      proxmoxData?.message ||
      (typeof proxmoxData === 'string' ? proxmoxData : null) ||
      err.message ||
      "Proxmox connection failed";
    
    console.error("[Proxmox Error]", {
      status,
      message,
      data: proxmoxData,
      url: err.config?.url
    });
    
    const error = new Error(message);
    error.status = status;
    throw error;
  }
);

module.exports = proxmoxClient;
