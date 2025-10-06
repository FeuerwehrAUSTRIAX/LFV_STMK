const express = require("express");
const fetch = require("node-fetch");
const app = express();

app.get("/", (req, res) => {
  res.send("Proxy läuft ✅ – nutze /einsatzdaten für die Einsatzliste.");
});

app.get("/einsatzdaten", async (req, res) => {
  try {
    // Original-Quelle
    const response = await fetch("https://einsatzuebersicht.lfv.steiermark.at/einsatzkarte/data/public_current.json");
    const data = await response.json();

    // CORS-Header anhängen
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Proxy läuft auf Port " + PORT));
