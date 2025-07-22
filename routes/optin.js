// routes/optin.js
const express = require('express');
const router = express.Router();
const axios = require('axios');

const registerOptIn = async (phone) => {
  if (!phone || !/^\d{10,15}$/.test(phone)) {
    throw new Error('Invalid phone number');
  }

  const formattedPhone = phone.startsWith('91') ? phone : `91${phone}`;

  // Use URLSearchParams for form-encoded data (same as your OTP endpoint)
  const payload = new URLSearchParams({
    channel: 'whatsapp',
    source: formattedPhone,
    destination: process.env.GUPSHUP_SENDER,
    'src.name': process.env.GUPSHUP_APP_NAME,
    // Add context as form parameters
    'context.optinType': 'checkbox',
    'context.optinSource': 'mobile_app'
  });

  const response = await axios.post(
    `https://api.gupshup.io/sm/api/v1/app/opt/in/${process.env.GUPSHUP_APP_NAME}`,
    payload,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        apikey: process.env.GUPSHUP_API_KEY,
      },
      timeout: 10000,
    }
  );

  if (response.data && (response.data.status === 'success' || response.data.status === 'submitted')) {
    return {
      success: true,
      status: response.data.status,
      message: response.data.message || 'Opt-in successful'
    };
  } else {
    throw new Error(`Unexpected response: ${JSON.stringify(response.data)}`);
  }
};

router.post('/', async (req, res) => {
  try {
    const { phone } = req.body;
    const result = await registerOptIn(phone);
    
    res.status(200).json({ 
      success: true, 
      message: result.message,
      status: result.status 
    });
  } catch (err) {
    console.error('Gupshup opt-in error:', err.response?.data || err.message);
    
    // Handle specific Gupshup errors
    if (err.response) {
      const statusCode = err.response.status;
      const errorData = err.response.data;
      
      switch (statusCode) {
        case 400:
          return res.status(400).json({
            success: false,
            message: errorData?.message || 'Invalid request parameters'
          });
        case 401:
          return res.status(500).json({
            success: false,
            message: 'Authentication failed'
          });
        case 415:
          return res.status(500).json({
            success: false,
            message: 'Content type error'
          });
        default:
          return res.status(500).json({
            success: false,
            message: errorData?.message || 'Gupshup API error'
          });
      }
    }
    
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to register opt-in',
    });
  }
});

module.exports = { router, registerOptIn };