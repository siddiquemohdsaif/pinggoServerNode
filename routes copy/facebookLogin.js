const express = require('express');
const AES = require("../utils/AES_256");
const { verifyFacebookToken, getFacebookAccount, createNewFacebookAuthAccount} = require("../utils/facebookUtils");
const UserLock = require('../utils/Lock/UserLock');

const router = express.Router();

router.post('/', async (req, res) => {
    try {
        const UID  = req.body.UID;
        const ENC  = req.body.ENC;
        const idToken = req.body.idToken;
        const userId = req.body.facebookId;
        const email = req.body.email;

        //AUTH verification
        if(!AES.validateEncryptedCredentialByUID(ENC,UID)){                 
            console.error("Error in loginFromFacebook:", "Not valid");
            return res.status(400).json({ success: false, message: "Not valid" });
        }

        const existingFacebookAccount = await getFacebookAccount(idToken, UID,userId,email);
        if (existingFacebookAccount) {
            return res.status(200).json({ success: true, UID: existingFacebookAccount.UID , ENC : existingFacebookAccount.ENC });
        } else {

            const newFacebookAuthAccount = await UserLock.getInstance().run(UID, async () => {
                return await createNewFacebookAuthAccount(idToken, UID , ENC, userId,email);
            });
            
            if (newFacebookAuthAccount) {
                return res.status(200).json({ success: true, UID: UID , ENC : ENC });
            } else {
                return res.status(400).json({ success: false, message: "Unable to create new Facebook Auth account." });
            }
        }
    } catch (error) {
        console.error("Error in loginFromFacebook:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});

module.exports = router;
