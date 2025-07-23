const User = require("../models/userModel");

exports.handleWebhook = async (req, res) => {
  try {
    const payload = req.body.payload || {};
    const phone = payload?.sender?.phone;

    if (!phone) return res.status(400).send("No phone found");

    const formattedPhone = phone.startsWith("91") ? phone : `91${phone}`;

    await User.findOneAndUpdate(
      { phone: formattedPhone },
      { isOptedIn: true },
      { new: true, upsert: false }
    );

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.message);
    res.status(500).send("Server error");
  }
};
