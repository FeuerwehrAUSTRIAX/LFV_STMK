const express = require("express");
const fetch = require("node-fetch");
const app = express();

app.get("/einsatzdaten", async (req, res) => {
  try {
    const response = await fetch("https://gis.stmk.gv.at/wsa/wgapiext/rest/DynamicContentProxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "GetEinsaetze", bereich: "all" }) // ⚠️ hier ggf. den echten Payload einsetzen!
    });

    const data = await response.json();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy läuft auf Port ${PORT}`));
