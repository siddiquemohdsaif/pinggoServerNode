const express = require('express');
const { refillAllBot } = require('../utils/BotHandler');
const router = express.Router();


router.post('/refill', async (req, res) => {
    try {

        const result = await refillAllBot();
        return res.status(200).json(result);

    } catch (error) {
        console.error("Error in botRefill:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});



module.exports = router;
