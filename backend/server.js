const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());

const PORT = 5000;

// Sample data
const lostItems = [
  {
    id: 1,
    name: "iPhone 15 Pro",
    location: "Pune Railway Station",
    date: "2026-07-20",
  },
  {
    id: 2,
    name: "Wallet",
    location: "Phoenix Mall",
    date: "2026-07-18",
  },
  {
    id: 3,
    name: "Laptop Bag",
    location: "Hinjewadi Phase 1",
    date: "2026-07-15",
  },
];

app.get("/", (req, res) => {
  res.send("🚀 Lost & Found Backend is Running!");
});

app.get("/api/lost-items", (req, res) => {
  res.json(lostItems);
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});