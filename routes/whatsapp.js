const express = require("express");
const router = express.Router();
const whatsappController = require("../controllers/whatsappController");

router.post("/webhook", whatsappController.handleWebhook);

module.exports = router;
