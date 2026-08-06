const express = require('express');
const FriendHandler = require("../utils/FriendHandler");
const GetUsersDataHandler = require("../utils/GetUsersDataHandler");

const AES = require("../utils/AES_256");
const router = express.Router();

router.post('/searchForFriend', async (req, res) => {
    try {
        const uid = req.body.UID;
        const searchKey = req.body.searchKey;

        if (uid == null || searchKey == null) {
            return res.status(400).json({ success: false, message: 'all params are required.' });
        }

        if(searchKey.length < 0){
            return res.status(400).json({ success: false, message: 'empty search!' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const searchResultPlayerList = await FriendHandler.searchForFriend(searchKey);

        if (searchResultPlayerList) {
            return res.status(200).json(searchResultPlayerList);
        } else {
            return res.status(400).json({ success: false, message: "No Players Found" });
        }
    } catch (error) {
        console.error("Error in searchForFriend:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});



router.post('/sendFriendRequest', async (req, res) => {
    try {
        const uid = req.body.UID;
        const playerUID = req.body.playerUID;

        if (uid == null || playerUID == null) {
            return res.status(400).json({ success: false, message: 'all params are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const success = await FriendHandler.sendFriendRequest(uid, playerUID);

        if (success) {
            return res.status(200).json({ success: true, message: "Friend Request Message Sent Sucessfully" });
        } else {
            return res.status(400).json({ success: false, message: "unable to send Friend Request Message" });
        }
    } catch (error) {
        console.error("Error in sendFriendRequest:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});


router.post('/acceptRejectFriendRequest', async (req, res) => {
    try {
        const uid = req.body.UID;
        const notificationId = req.body.notificationId;
        const isAccepted = req.body.isAccepted;

        if (uid == null || notificationId == null || isAccepted == null) {
            return res.status(400).json({ success: false, message: 'all params are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const success = await FriendHandler.acceptRejectFriendRequest(uid, notificationId, isAccepted);

        if (success) {
            return res.status(200).json({ success: true, message: "Friend Request Message Sent Sucessfully" });
        } else {
            return res.status(400).json({ success: false, message: "unable to send Friend Request Message" });
        }
    } catch (error) {
        console.error("Error in acceptRejectFriendRequest:", error);

        return res.status(400).json({ success: false, message: error.message });
    }
});


router.post('/removeFriend', async (req, res) => {
    try {
        const uid = req.body.UID;
        const playerUID = req.body.playerUID;

        if (uid == null || playerUID == null) {
            return res.status(400).json({ success: false, message: 'all params are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const success = await FriendHandler.removeFriend(uid, playerUID);

        if (success) {
            return res.status(200).json({ success: true, message: "Friend Removed Sucessfully" });
        } else {
            return res.status(400).json({ success: false, message: "Friend Remove Failed" });
        }
    } catch (error) {
        console.error("Error in removeFriend:", error);

        return res.status(400).json({ success: false, message: error.message });
    }
});




router.post('/getFriendProfiles', async (req, res) => {
    try {
        const uid = req.body.UID;
        const uidList = req.body.uidList;

        if (uid == null || uidList == null) {
            return res.status(400).json({ success: false, message: 'all params are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const friendProfiles = await GetUsersDataHandler.getFriendDetailsList(uidList);

        return res.status(200).json(friendProfiles);

    } catch (error) {
        console.error("Error in getFriendProfiles:", error.message);
        console.error("Error in getFriendProfiles:", error);

        return res.status(400).json({ success: false, message: error.message });
    }
});




module.exports = router;















