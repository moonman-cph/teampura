const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'orgchart-data.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ── Simulation data (in-memory only, cleared on server restart) ───────────────
let simData = null;

app.get('/api/sim-data', (req, res) => {
  if (simData) res.json(simData);
  else res.status(404).json({ active: false });
});

app.post('/api/sim-data', (req, res) => {
  simData = req.body;
  res.json({ ok: true });
});

app.delete('/api/sim-data', (req, res) => {
  simData = null;
  res.json({ ok: true });
});

app.get('/api/data', (req, res) => {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.json({});
  }
});

app.post('/api/data', (req, res) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Org chart running at http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
