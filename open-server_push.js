require('dotenv').config();
let bat_name;
if (process.env.PRODUCTION_TYPE == "release") {
    bat_name = 'open-server_push_release.bat';
} else {
    bat_name = 'open-server_push_dev.bat';
}
const { exec } = require('child_process');

exec(bat_name, (error, stdout, stderr) => {
    if (error) {
        console.error(`exec error: ${error}`);
        return;
    }
    console.log(`stdout: ${stdout}`);
    console.error(`stderr: ${stderr}`);
});
