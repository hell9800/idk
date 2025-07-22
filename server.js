require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");
const User = require("./models/userModel");
const { router: optinRoute, registerOptIn } = require("./routes/optin"); // Updated import

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.CORS_ORIGIN?.split(',') || ["https://yourdomain.com"]
    : process.env.CORS_ORIGIN || "*",
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_LOGGING === 'true') {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - IP: ${req.ip}`);
  }
  next();
});

app.set('trust proxy', 1);

app.use('/api/optin', optinRoute);

const otpStore = new Map();
const rateLimitStore = new Map();

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

const checkRateLimit = (phone) => {
  const now = Date.now();
  const key = `rate_${phone}`;
  const attempts = rateLimitStore.get(key) || [];
  const validAttempts = attempts.filter(timestamp => now - timestamp < 60 * 60 * 1000);
  if (validAttempts.length >= 5) return false;
  validAttempts.push(now);
  rateLimitStore.set(key, validAttempts);
  return true;
};

const cleanupExpired = () => {
  const now = Date.now();
  for (const [phone, data] of otpStore.entries()) {
    if (data.expiresAt < now) otpStore.delete(phone);
  }
  for (const [key, attempts] of rateLimitStore.entries()) {
    const validAttempts = attempts.filter(timestamp => now - timestamp < 60 * 60 * 1000);
    if (validAttempts.length === 0) {
      rateLimitStore.delete(key);
    } else {
      rateLimitStore.set(key, validAttempts);
    }
  }
};
setInterval(cleanupExpired, 5 * 60 * 1000);

const validatePhoneNumber = (phone) => /^[6-9]\d{9}$/.test(phone);

const sendWhatsAppOtpGupshup = async (phone, otp) => {
  try {
    const {
      GUPSHUP_API_KEY,
      GUPSHUP_SENDER,
      GUPSHUP_APP_NAME = "GupshupApp",
      GUPSHUP_TEMPLATE_NAME = "otp_verification_code",
      OTP_EXPIRY_MINUTES = 5
    } = process.env;

    const formattedPhone = phone.startsWith('91') ? phone : `91${phone}`;

    const payload = new URLSearchParams({
      channel: "whatsapp",
      source: GUPSHUP_SENDER,
      destination: formattedPhone,
      "src.name": GUPSHUP_APP_NAME,
      template: GUPSHUP_TEMPLATE_NAME,
      "template.params": `${otp}|${OTP_EXPIRY_MINUTES}`
    });

    const response = await axios.post(
      `https://api.gupshup.io/sm/api/v1/template/msg`,
      payload,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          apikey: GUPSHUP_API_KEY
        },
        timeout: 15000
      }
    );

    if (["submitted", "queued"].includes(response.data?.status) || response.data?.messageId) {
      return {
        success: true,
        messageId: response.data.messageId,
        status: response.data.status
      };
    } else {
      throw new Error(`Unexpected Gupshup response: ${JSON.stringify(response.data)}`);
    }

  } catch (error) {
    console.error("Gupshup API Error:", error.response?.data || error.message);
    if (error.response) {
      const msg = error.response.data?.message || "Invalid parameters";
      switch (error.response.status) {
        case 401: throw new Error("Invalid Gupshup API key");
        case 400: throw new Error(`Bad request: ${msg}`);
        case 429: throw new Error("Rate limit exceeded on Gupshup API");
        case 500: throw new Error("Gupshup server error");
      }
    } else if (error.request) {
      throw new Error("No response from Gupshup API - network issue");
    }
    throw new Error(`Gupshup error: ${error.message}`);
  }
};

// Environment variable validation
const requiredEnvVars = [
  'GUPSHUP_API_KEY', 
  'GUPSHUP_SENDER', 
  'GUPSHUP_APP_NAME',
  'MONGO_URI'
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
  console.warn("⚠️ Some functionality may be disabled");
}

// Health check
app.get("/health", (req, res) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: process.env.NODE_ENV || 'development',
    database: mongoStatus,
    services: {
      gupshup_api_key: process.env.GUPSHUP_API_KEY ? 'Configured' : 'Missing',
      gupshup_sender: process.env.GUPSHUP_SENDER ? 'Configured' : 'Missing',
      gupshup_app_name: process.env.GUPSHUP_APP_NAME ? 'Configured' : 'Missing',
      gupshup_template: process.env.GUPSHUP_TEMPLATE_NAME || 'verify_template',
      mongodb_uri: process.env.MONGO_URI ? 'Configured' : 'Missing'
    }
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "🚀 OTP Backend is live!",
    version: "1.0.0",
    endpoints: ["/health", "/send-otp", "/verify-otp", "/api/optin"]
  });
});

app.post("/send-otp", async (req, res) => {
  try {
    const { phone, consentGiven } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, message: "Phone number is required", code: "MISSING_PHONE" });
    }

    const normalizedPhone = phone.replace(/\D/g, '').replace(/^91/, '');

    if (!validatePhoneNumber(normalizedPhone)) {
      return res.status(400).json({ success: false, message: "Invalid Indian phone number format", code: "INVALID_PHONE" });
    }

    if (!consentGiven) {
      return res.status(400).json({ success: false, message: "User consent is required", code: "CONSENT_REQUIRED" });
    }

    // Register WhatsApp opt-in using direct function call (non-blocking)
    try {
      await registerOptIn(normalizedPhone);
      console.log("✅ WhatsApp opt-in registered successfully");
    } catch (optinErr) {
      console.warn("⚠️ Gupshup opt-in failed (continuing):", optinErr.message);
    }

    if (!checkRateLimit(normalizedPhone)) {
      return res.status(429).json({ success: false, message: "Too many OTP requests. Try again in 1 hour.", code: "RATE_LIMITED" });
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + (parseInt(process.env.OTP_EXPIRY_MINUTES) || 5) * 60 * 1000;

    otpStore.set(normalizedPhone, { otp, expiresAt, attempts: 0, createdAt: Date.now() });

    const sendResult = await sendWhatsAppOtpGupshup(normalizedPhone, otp);

    try {
      await User.findOneAndUpdate(
        { phone: normalizedPhone },
        {
          phone: normalizedPhone,
          termsAccepted: true,
          lastOtpRequest: new Date()
        },
        { upsert: true, new: true }
      );
    } catch (dbError) {
      console.error("Database error (non-critical):", dbError);
    }

    res.json({
      success: true,
      message: "OTP sent successfully via WhatsApp",
      expiresIn: Math.floor((expiresAt - Date.now()) / 1000),
      messageId: sendResult.messageId,
      status: sendResult.status
    });

  } catch (error) {
    console.error("❌ Error in /send-otp:", error);
    const statusCode = error.message.includes("Rate limit") ? 429 :
      error.message.includes("Invalid") ? 400 : 500;
    res.status(statusCode).json({ success: false, message: error.message || "Failed to send OTP", code: "OTP_SEND_FAILED" });
  }
});

app.post("/verify-otp", async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: "Phone number and OTP are required", code: "MISSING_CREDENTIALS" });
    }

    const normalizedPhone = phone.replace(/\D/g, '').replace(/^91/, '');
    const storedOtpData = otpStore.get(normalizedPhone);

    if (!storedOtpData) {
      return res.status(400).json({ success: false, message: "OTP not found or expired", code: "OTP_NOT_FOUND" });
    }

    if (storedOtpData.expiresAt < Date.now()) {
      otpStore.delete(normalizedPhone);
      return res.status(400).json({ success: false, message: "OTP has expired", code: "OTP_EXPIRED" });
    }

    if (storedOtpData.attempts >= 3) {
      otpStore.delete(normalizedPhone);
      return res.status(400).json({ success: false, message: "Too many invalid attempts", code: "MAX_ATTEMPTS_EXCEEDED" });
    }

    if (storedOtpData.otp !== otp) {
      storedOtpData.attempts++;
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
        code: "INVALID_OTP",
        attemptsLeft: 3 - storedOtpData.attempts
      });
    }

    otpStore.delete(normalizedPhone);

    await User.findOneAndUpdate(
      { phone: normalizedPhone },
      { isVerified: true, verifiedAt: new Date() }
    );

    res.json({
      success: true,
      message: "OTP verified successfully",
      user: { phone: normalizedPhone, verified: true }
    });

  } catch (error) {
    console.error("❌ Error in /verify-otp:", error);
    res.status(500).json({ success: false, message: "Failed to verify OTP", code: "VERIFICATION_FAILED" });
  }
});

app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found",
    availableEndpoints: ["/", "/health", "/send-otp", "/verify-otp", "/api/optin"]
  });
});

app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? "Internal server error" : error.message
  });
});

const gracefulShutdown = (signal) => {
  console.log(`🛑 Received ${signal}. Starting graceful shutdown...`);
  mongoose.connection.close(false, () => {
    console.log('📦 MongoDB connection closed.');
    process.exit(0);
  });
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

const connectDB = async () => {
  try {
    const mongoOptions = {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      family: 4,
      retryWrites: true,
      w: 'majority'
    };

    await mongoose.connect(process.env.MONGO_URI, mongoOptions);
    console.log(`✅ Connected to MongoDB Atlas`);
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`📱 Gupshup App: ${process.env.GUPSHUP_APP_NAME || 'Not configured'}`);
      console.log(`📞 Gupshup Sender: ${process.env.GUPSHUP_SENDER || 'Not configured'}`);
    });

  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
};

mongoose.connection.on('error', (err) => console.error('MongoDB connection error:', err));
mongoose.connection.on('disconnected', () => console.log('MongoDB disconnected'));
mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected'));

connectDB();