let lastTimestamp = 0;

function nextTimestamp() {
  const timestamp = Math.max(Date.now(), lastTimestamp + 1);
  lastTimestamp = timestamp;
  return timestamp;
}

module.exports = { nextTimestamp };
