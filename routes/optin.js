// routes/optin.js
const express = require('express');
const router = express.Router();
const axios = require('axios');

router.post('/', async (req, res) => {
  const { phone } = req.body;

  if (!phone || !/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }

  const formattedPhone = phone.startsWith('91') ? phone : `91${phone}`;

  try {
    const response = await axios.post(
      `https://api.gupshup.io/sm/api/v1/app/opt/in/${process.env.GUPSHUP_APP_NAME}`,
      {
        channel: 'whatsapp',
        source: formattedPhone,
        destination: process.env.GUPSHUP_SENDER,
        context: {
          optinType: 'checkbox',
          optinSource: 'mobile_app',
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: process.env.GUPSHUP_API_KEY,
        },
        timeout: 10000,
      }
    );

    if (response.data && response.data.status === 'success') {
      res.status(200).json({ success: true, message: 'Opt-in successful' });
    } else {
      console.warn('Unexpected response:', response.data);
      res.status(500).json({ success: false, message: 'Unexpected response from Gupshup' });
    }
  } catch (err) {
    console.error('Gupshup opt-in error:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: err.response?.data?.message || 'Failed to register opt-in',
    });
  }
});

module.exports = router;
