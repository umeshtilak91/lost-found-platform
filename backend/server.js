const express = require("express");
const cors = require("cors");
const pool = require("./db");
const upload = require("./upload");

const app = express();

app.use(cors());
app.use(express.json());

const path = require("path");

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT = 5000;




app.get("/", (req, res) => {
  res.send("🚀 Lost & Found Backend is Running!");
});

app.get("/api/lost-items", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM items ORDER BY created_at DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Database Error",
    });
  }
});

app.post("/api/report", upload.single("image"), async (req, res) => {
  try {
    const { name, location, date, description } = req.body;
    const image = req.file ? req.file.filename : null;
    console.log("================================");
console.log("BODY:", req.body);
console.log("FILE:", req.file);
console.log("IMAGE:", image);
console.log("================================");
    console.log("Request Body:", req.body);
    console.log("Uploaded File:", req.file);

 const result = await pool.query(
  `INSERT INTO items (name, location, date, description, image)
   VALUES ($1, $2, $3, $4, $5)
   RETURNING *`,
  [name, location, date, description, image]
);

    res.status(201).json({
      message: "Lost item reported successfully!",
      item: result.rows[0],
    });
  } catch (error) {
    console.error("Database Error:", error);

    res.status(500).json({
      message: "Database Error",
 });
}
});

pool.query("SELECT NOW()", (err, result) => {
  if (err) {
    console.error("Database connection failed:", err);
  } else {
    console.log("✅ Database Connected");
    console.log(result.rows[0]);
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});