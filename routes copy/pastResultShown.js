const express = require('express');
const AES = require("../utils/AES_256");
const router = express.Router();
const UserLock = require('../utils/Lock/UserLock');
const PastResultHandler = require('../utils/PastResultHandler');
const pastResultHandler = new PastResultHandler();

router.post('/', async (req, res) => {
    try {
        const uid = req.body.UID;
        if(uid == null ){
            return res.status(400).json({ success: false, message: 'UID is required.' });
        }

        //check auth uid
        if(uid !== AES.getAuthUid(req)){
            return res.status(401).json({ success: false, message: 'Authorization failed'});
        }

        const updatedDocUser = await UserLock.getInstance().run(uid, async () => {
            return await pastResultHandler.pastResultShown(uid);
        });

        if (updatedDocUser) {
            return res.status(200).json(updatedDocUser);
        } else {
            return res.status(400).json({ success: false, message: "Unable to update pastResultShown." });
        }
    } catch (error) {
        console.error("Error in pastResultShown:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});

module.exports = router;
