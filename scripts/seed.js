// Standalone seed runner — used against a real Postgres database
// (DATABASE_URL set). Not needed for local pg-mem runs, since server.js
// seeds automatically on every boot there.
const db = require('../services/db');
const seed = require('../services/seed');

db.init()
  .then(() => seed.run())
  .then(() => {
    console.log('Done.');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
