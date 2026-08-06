const express = require('express');
const { gemsBuy } = require('../utils/GoogleIAP/PurchaseHandler/GemsBuyHandler');
const { carromPassBuy } = require('../utils/GoogleIAP/PurchaseHandler/CarromPassBuyHandler');
const { goldenShotBuy } = require('../utils/GoogleIAP/PurchaseHandler/GoldenShotBuyHandler');
const { aimsBuy } = require('../utils/GoogleIAP/PurchaseHandler/AimsBuyHandler');
const router = express.Router();
const AES = require("../utils/AES_256");
const UserLock = require('../utils/Lock/UserLock');

const now = () => new Date().toISOString();

/* ─────────────── GEM PURCHASE ─────────────────────────────────────────── */
router.post('/gemsBuy', async (req, res) => {
    console.log(`[${now()}] 💎 [gemsBuy] Incoming request:`, req.body);
    try {
        const { UID, productId, purchaseToken } = req.body;

        if (!UID || !productId || !purchaseToken) {
            console.warn(`[${now()}] 💎 [gemsBuy] Missing required fields: UID=${UID}, productId=${productId}, token=${purchaseToken}`);
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        if (UID !== AES.getAuthUid(req)) {
            console.warn(`[${now()}] 💎 [gemsBuy] Authorization failed for UID: ${UID}`);
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        console.log(`[${now()}] 💎 [gemsBuy] Processing purchase for UID: ${UID}`);
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await gemsBuy(UID, productId, purchaseToken);
        });

        if (profileData) {
            console.log(`[${now()}] 💎 [gemsBuy] Purchase successful for UID: ${UID}`);
            return res.status(200).json(profileData);
        } else {
            console.warn(`[${now()}] 💎 [gemsBuy] Purchase handler returned null for UID: ${UID}`);
            return res.status(400).json({ success: false, message: "Unable to buy gems." });
        }

    } catch (error) {
        console.error(`[${now()}] 💎 [gemsBuy] ERROR for UID: ${req.body.UID} →`, error.stack);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/* ─────────────── CARROM PASS PURCHASE ─────────────────────────────────── */
router.post('/carromPassBuy', async (req, res) => {
    console.log(`[${now()}] 🎟️ [carromPassBuy] Incoming request:`, req.body);
    try {
        const { UID, purchaseToken } = req.body;

        if (!UID || !purchaseToken) {
            console.warn(`[${now()}] 🎟️ [carromPassBuy] Missing required fields: UID=${UID}, token=${purchaseToken}`);
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        if (UID !== AES.getAuthUid(req)) {
            console.warn(`[${now()}] 🎟️ [carromPassBuy] Authorization failed for UID: ${UID}`);
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        console.log(`[${now()}] 🎟️ [carromPassBuy] Processing purchase for UID: ${UID}`);
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await carromPassBuy(UID, purchaseToken);
        });

        if (profileData) {
            console.log(`[${now()}] 🎟️ [carromPassBuy] Purchase successful for UID: ${UID}`);
            return res.status(200).json(profileData);
        } else {
            console.warn(`[${now()}] 🎟️ [carromPassBuy] Purchase handler returned null for UID: ${UID}`);
            return res.status(400).json({ success: false, message: "Unable to activate Carrom Pass." });
        }

    } catch (error) {
        console.error(`[${now()}] 🎟️ [carromPassBuy] ERROR for UID: ${req.body.UID} →`, error.stack);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/* ─────────────── GOLDEN SHOT PURCHASE ─────────────────────────────────── */
router.post('/goldenShotBuy', async (req, res) => {
    console.log(`[${now()}] 🎯 [goldenShotBuy] Incoming request:`, req.body);
    try {
        const { UID, purchaseToken } = req.body;

        if (!UID || !purchaseToken) {
            console.warn(`[${now()}] 🎯 [goldenShotBuy] Missing required fields: UID=${UID}, token=${purchaseToken}`);
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        if (UID !== AES.getAuthUid(req)) {
            console.warn(`[${now()}] 🎯 [goldenShotBuy] Authorization failed for UID: ${UID}`);
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        console.log(`[${now()}] 🎯 [goldenShotBuy] Processing purchase for UID: ${UID}`);
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await goldenShotBuy(UID, purchaseToken);
        });

        if (profileData) {
            console.log(`[${now()}] 🎯 [goldenShotBuy] Purchase successful for UID: ${UID}`);
            return res.status(200).json(profileData);
        } else {
            console.warn(`[${now()}] 🎯 [goldenShotBuy] Purchase handler returned null for UID: ${UID}`);
            return res.status(400).json({ success: false, message: "Unable to buy golden shot." });
        }

    } catch (error) {
        console.error(`[${now()}] 🎯 [goldenShotBuy] ERROR for UID: ${req.body.UID} →`, error.stack);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/* ─────────────── GEM PURCHASE ─────────────────────────────────────────── */
router.post('/aimPackBuy', async (req, res) => {
    console.log(`[${now()}] 💎 [aimPackBuy] Incoming request:`, req.body);
    try {
        const { UID, productId, purchaseToken } = req.body;

        if (!UID || !productId || !purchaseToken) {
            console.warn(`[${now()}] 💎 [aimPackBuy] Missing required fields: UID=${UID}, productId=${productId}, token=${purchaseToken}`);
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        if (UID !== AES.getAuthUid(req)) {
            console.warn(`[${now()}] 💎 [aimPackBuy] Authorization failed for UID: ${UID}`);
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        console.log(`[${now()}] 💎 [aimPackBuy] Processing purchase for UID: ${UID}`);
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await aimsBuy(UID, productId, purchaseToken);
        });

        if (profileData) {
            console.log(`[${now()}] 💎 [aimPackBuy] Purchase successful for UID: ${UID}`);
            return res.status(200).json(profileData);
        } else {
            console.warn(`[${now()}] 💎 [aimPackBuy] Purchase handler returned null for UID: ${UID}`);
            return res.status(400).json({ success: false, message: "Unable to buy gems." });
        }

    } catch (error) {
        console.error(`[${now()}] 💎 [aimPackBuy] ERROR for UID: ${req.body.UID} →`, error.stack);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;
