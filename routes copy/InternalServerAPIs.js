const express = require('express');
const GameEventHandler = require('../utils/GameEventHandler');
const router = express.Router();

router.post('/eventData', async (req, res) => {
    try {

        const eventId = req.query.eventId;

        // Validation for undefined or null values
        if (eventId === null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        const response = await GameEventHandler.getTopPlayerofEvent("null", eventId, true);
        if(response.success){
            return res.status(200).json(response.players);
        }else{
            return res.status(400).json(response);
        }

    } catch (error) {
        console.error("Error in eventData :", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});


router.post('/eventCreate', async (req, res) => {
    try {

        const eventId = req.query.eventId;
        const eventType = req.query.eventType;

        // Validation for undefined or null values
        if (eventId === null || eventType === null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        const isDone = await GameEventHandler.createEvent(eventId, eventType);

        if(isDone){
            return res.status(200).json({success: true});

        }else{
            return res.status(400).json({success: false});
        }

    } catch (error) {
        console.error("Error in eventCreate :", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});


router.post('/eventDelete', async (req, res) => {
    try {

        const eventId = req.query.eventId;

        // Validation for undefined or null values
        if (eventId === null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        const isDone = await GameEventHandler.deleteEvent(eventId);

        if(isDone){
            return res.status(200).json({success: true});

        }else{
            return res.status(400).json({success: false});
        }

    } catch (error) {
        console.error("Error in eventDelete :", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});


module.exports = router;